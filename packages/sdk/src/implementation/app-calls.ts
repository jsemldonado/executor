/** `ctx.tools`: one app calling another app's tool as the invocation's actor. */
import { Cause, Effect } from "effect";
import { UserFacingError } from "@executor-js/utils/user-facing-error";
import { AppCallFailure, maxFailureMessageLength, type AppCallHostControls } from "apps/contracts";
import { AppCallAuthority } from "../contracts/app-calls.ts";
import { ToolName } from "../contracts/shared.ts";
import type { Executor } from "../contracts/executor.ts";
import type { InvocationSnapshot } from "./tools.ts";
import type { ToolInvocationOptions } from "../contracts/tools.ts";

interface Calls {
  readonly call: Executor["tools"]["call"];
  readonly resume: Executor["tools"]["resume"];
}

const refused = (reason: AppCallFailure["reason"], message: string) =>
  new AppCallFailure({ reason, message: message.slice(0, maxFailureMessageLength) });

const tagOf = (error: unknown) =>
  typeof error === "object" && error !== null && "_tag" in error && typeof error._tag === "string"
    ? error._tag
    : undefined;

const reasonOf = (tag: string): AppCallFailure["reason"] => {
  switch (tag) {
    case "ToolNotFound":
    case "AppNotFound":
    case "AppNotDeployed":
      return "not_found";
    case "InputInvalid":
    case "RequestInvalid":
      return "input";
    case "OrganizationForbidden":
    case "Forbidden":
      return "denied";
    default:
      return "execution";
  }
};

const failed = (error: unknown, target: string) => {
  const tag = tagOf(error);
  if (tag !== undefined && reasonOf(tag) === "not_found")
    return refused("not_found", `${target} was not found.`);
  return UserFacingError.is(error)
    ? refused(reasonOf(error._tag), `${target}: ${error.message}`)
    : refused(
        tag === undefined ? "execution" : reasonOf(tag),
        `${target} failed in Executor${tag === undefined ? "" : ` (${tag})`}.`,
      );
};
const surfaced = <A, E, R>(effect: Effect.Effect<A, E, R>, target: string) =>
  effect.pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterrupts(cause)
        ? Effect.interrupt
        : Effect.fail(failed(Cause.squash(cause), target)),
    ),
  );

/**
 * The calls `state`'s app may make: only to apps its version declares in `uses`, each allowed by
 * the host's `AppCallAuthority` for the same actor, and run with the target's own accounts. A
 * target that needs approval asks the person through `elicitation`, the prompt of the call that
 * started this invocation; without one, such as in a scheduled run, the call is refused.
 */
export const appCalls =
  (
    state: InvocationSnapshot,
    tools: Calls,
    elicitation?: ToolInvocationOptions["elicitation"],
  ): AppCallHostControls["call"] =>
  (command) =>
    Effect.gen(function* () {
      const target = `${command.app}.${command.tool}`;
      if (!(state.version.requirements.uses ?? []).includes(command.app))
        return yield* refused(
          "undeclared",
          `${state.app.slug} does not declare "${command.app}" in its uses, so it cannot call ${target}. Add it to defineApp's uses and deploy again.`,
        );
      const authorize = yield* AppCallAuthority;
      if (authorize === undefined)
        return yield* refused("unavailable", "This Executor runs no calls between apps.");
      const grant = yield* authorize({
        owner: state.app.owner,
        actor: state.actor ?? null,
        caller: state.app.id,
        app: command.app,
        tool: command.tool,
      });
      const options = elicitation === undefined ? undefined : { elicitation };
      const started = yield* surfaced(
        tools.call(
          {
            app: grant.app,
            version: grant.version,
            accounts: grant.accounts,
            tool: ToolName.make(command.tool),
            input: command.input,
          },
          options,
        ),
        target,
      );
      const ask = started.status === "approval-required" ? elicitation : undefined;
      if (started.status === "approval-required" && ask === undefined)
        return yield* refused(
          "approval",
          `${target} needs your approval, and nobody is here to ask: this run started without a person, such as a schedule. Run it yourself, or approve the tool in Executor.`,
        );
      const result =
        started.status === "approval-required" && ask !== undefined
          ? yield* Effect.gen(function* () {
              const controller = new AbortController();
              const answer = yield* ask(
                {
                  ...started.elicitation,
                  message: `${state.app.name} wants to call ${target}.\n\n${started.elicitation.message}`,
                },
                controller.signal,
              ).pipe(
                Effect.ensuring(Effect.sync(() => controller.abort())),
                Effect.mapError(() =>
                  refused("approval", `${target} needs your approval, which could not be asked.`),
                ),
              );
              if (answer.action !== "accept")
                return yield* refused("denied", `You declined ${target}.`);
              const resumed = yield* surfaced(
                tools.resume(
                  {
                    requestId: started.requestId,
                    owner: state.app.owner,
                    response: { action: "accept" },
                  },
                  options,
                ),
                target,
              );
              if (resumed.status === "completed") return resumed;
              return yield* refused(
                resumed.status === "denied" || resumed.status === "cancelled"
                  ? "denied"
                  : "execution",
                `${target} did not run after approval (${resumed.status}).`,
              );
            })
          : started;
      if (result.status !== "completed")
        return yield* refused("approval", `${target} needs your approval.`);
      if (result.toolError === true)
        return yield* refused(
          "execution",
          `${target} reported an error: ${JSON.stringify(result.value)}`,
        );
      return result.value;
    }).pipe(
      Effect.withSpan("sdk.app.call", {
        attributes: { "executor.app.id": state.app.id, "executor.app.call.target": command.app },
      }),
    );
