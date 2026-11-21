/**
 * One app calling another app's tool through `ctx.tools` runs as the invocation's actor: the same
 * membership, app access, tool policy and account links as that person calling it directly.
 */
import { Cause, Effect, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { fullAuthority, noAuthority } from "@executor-js/authorization";
import { AppCallFailure, maxFailureMessageLength } from "apps/contracts";
import {
  AppSlug,
  ToolName,
  type AppCallGrant,
  type AppCallTarget,
  type Executor,
} from "@executor-js/sdk/core";
import { UserFacingError } from "@executor-js/utils/user-facing-error";
import { GroupDatabase } from "../contracts/groups.ts";
import {
  CurrentOrganization,
  OrganizationId,
  OrganizationRole,
} from "../contracts/organization.ts";
import { CurrentPolicy } from "../contracts/authorization.ts";
import { CurrentUserId } from "../contracts/auth.ts";
import { HostedExecutor } from "../contracts/executor.ts";
import { checkedToolCall } from "./access.ts";
import { authorizeTool } from "./authorization.ts";

const refused = (reason: AppCallFailure["reason"], message: string) =>
  new AppCallFailure({ reason, message: message.slice(0, maxFailureMessageLength) });

/** Capture the host SQL client; each call checks the actor's membership and access afresh. */
export const makeAppCallAuthority = (executor: Executor) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return (target: AppCallTarget) =>
      Effect.gen(function* () {
        const name = `${target.app}.${target.tool}`;
        if (target.actor === null)
          return yield* refused(
            "denied",
            `${name} was called from work with no person behind it, such as an app schedule. Calls between apps run as a person, so start it from a personal schedule or a direct call.`,
          );
        if (!target.owner.startsWith("organization:"))
          return yield* refused("denied", `${name} is outside this organization.`);
        const organization = yield* Schema.decodeUnknownEffect(OrganizationId)(
          target.owner.slice("organization:".length),
        ).pipe(Effect.mapError(() => refused("denied", `${name} is outside this organization.`)));
        const rows =
          yield* sql`select role from member where "organizationId" = ${organization} and "userId" = ${target.actor}`;
        const members = yield* Schema.decodeUnknownEffect(
          Schema.Array(Schema.Struct({ role: OrganizationRole })),
        )(rows);
        const member = members.length === 1 ? members[0] : undefined;
        if (member === undefined)
          return yield* refused("denied", `The person behind this call can no longer use ${name}.`);
        const slug = yield* Schema.decodeUnknownEffect(AppSlug)(target.app).pipe(
          Effect.mapError(() => refused("not_found", `No app has the address "${target.app}".`)),
        );
        const found = yield* executor.apps.list({ owner: target.owner, slug });
        const app = found[0];
        if (app === undefined)
          return yield* refused("not_found", `No app has the address "${target.app}".`);
        const tool = ToolName.make(target.tool);
        // The caller's own grant narrows the call; background work has none, and runs as a
        // schedule does, by membership and app access.
        const inherited = yield* CurrentPolicy;
        const policy = inherited === noAuthority ? fullAuthority : inherited;
        const { version, accounts } = yield* checkedToolCall(
          executor,
          target.owner,
          { app: app.id },
          (selected, described) => authorizeTool({ app: app.id, tool, ...selected }, described),
        ).pipe(
          Effect.provideService(CurrentPolicy, policy),
          Effect.provideService(CurrentUserId, target.actor),
          Effect.provideService(CurrentOrganization, {
            organization,
            owner: target.owner,
            role: member.role,
          }),
          Effect.provideService(GroupDatabase, Effect.succeed(sql)),
          Effect.provideService(HostedExecutor, Effect.succeed(executor)),
        );
        return { app: app.id, version, accounts } satisfies AppCallGrant;
      }).pipe(
        Effect.catchCause((cause) => {
          if (Cause.hasInterrupts(cause)) return Effect.interrupt;
          const error = Cause.squash(cause);
          if (Schema.is(AppCallFailure)(error)) return Effect.fail(error);
          const tag =
            typeof error === "object" &&
            error !== null &&
            "_tag" in error &&
            typeof error._tag === "string"
              ? error._tag
              : "";
          const name = `${target.app}.${target.tool}`;
          return Effect.fail(
            tag === "ToolNotFound" || tag === "AppNotDeployed" || tag === "AppNotFound"
              ? refused("not_found", `${name} was not found.`)
              : tag === "OrganizationForbidden" || tag === "Forbidden"
                ? refused("denied", `The person behind this call may not use ${name}.`)
                : UserFacingError.is(error)
                  ? refused("execution", `${name}: ${error.message}`)
                  : refused("execution", `Executor could not check the call to ${name}.`),
          );
        }),
      );
  });
