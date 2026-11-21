/** How a host lets one app call another app's tools through `ctx.tools`. */
import { Context, type Effect } from "effect";
import type { AppCallFailure } from "apps/contracts";
import type { AppAccounts } from "./apps.ts";
import type { AppId, OwnerId, VersionId } from "./shared.ts";

/** One `ctx.tools` call the host is asked to allow. */
export interface AppCallTarget {
  readonly owner: OwnerId;
  /** The invocation's actor; null for work without a caller, such as an app schedule. */
  readonly actor: string | null;
  /** The calling app, which declared `app` in its `uses`. */
  readonly caller: AppId;
  /** The target app's slug, as the caller's code named it. */
  readonly app: string;
  readonly tool: string;
}

/** The target the host allowed: its app, active version and the actor's accounts for it. */
export interface AppCallGrant {
  readonly app: AppId;
  readonly version: VersionId;
  readonly accounts: AppAccounts;
}

/**
 * The host's check of an app call, with the same membership, app access, tool policy and account
 * selection as a direct call by the actor. Unset, every app call is refused as unavailable.
 */
export const AppCallAuthority = Context.Reference<
  ((target: AppCallTarget) => Effect.Effect<AppCallGrant, AppCallFailure>) | undefined
>("executor/AppCallAuthority", { defaultValue: () => undefined });
