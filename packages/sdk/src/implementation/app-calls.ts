/** `ctx.tools`: one app calling another app's tool as the invocation's actor. */
import { Cause, Effect } from "effect";
import { UserFacingError } from "@executor-js/utils/user-facing-error";
import { AppCallFailure, maxFailureMessageLength, type AppCallHostControls } from "apps/contracts";
import { AppCallAuthority } from "../contracts/app-calls.ts";
import { ToolName } from "../contracts/shared.ts";
import type { Executor } from "../contracts/executor.ts";
import type { InvocationSnapshot } from "./tools.ts";

type Call = Executor["tools"]["call"];

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

/**
 * The calls `state`'s app may make: only to apps its version declares in `uses`, each allowed by
 * the host's `AppCallAuthority` for the same actor, and run with the target's own accounts.
 */
export const appCalls =
  (state: InvocationSnapshot, call: Call): AppCallHostControls["call"] =>
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
      const result = yield* call({
        app: grant.app,
        version: grant.version,
        accounts: grant.accounts,
        tool: ToolName.make(command.tool),
        input: command.input,
      }).pipe(
        Effect.catchCause((cause) => {
          if (Cause.hasInterrupts(cause)) return Effect.interrupt;
          const error = Cause.squash(cause);
          const tag = tagOf(error);
          if (tag !== undefined && reasonOf(tag) === "not_found")
            return Effect.fail(refused("not_found", `${target} was not found.`));
          return Effect.fail(
            UserFacingError.is(error)
              ? refused(reasonOf(error._tag), `${target}: ${error.message}`)
              : refused(
                  tag === undefined ? "execution" : reasonOf(tag),
                  `${target} failed in Executor${tag === undefined ? "" : ` (${tag})`}.`,
                ),
          );
        }),
      );
      if (result.status === "approval-required")
        return yield* refused(
          "approval",
          `${target} needs your approval, which a call from another app cannot ask for yet. Approve it in Executor, or call it directly.`,
        );
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
