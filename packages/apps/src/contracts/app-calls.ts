/**
 * Calling another app's tool from an app. The host runs the call as the invocation's caller, with
 * the same authorization and approvals as a direct call, and only to apps the caller declared in
 * `uses`. Credentials never cross: the target app runs with its own accounts.
 */
import { Schema, type Effect } from "effect";
import { JsonValue } from "./schema.ts";
import { FailureMessage } from "./failure.ts";

/** An app's address, as `uses` and `ctx.tools` name it. */
export const AppSlug = Schema.NonEmptyString.check(Schema.isMaxLength(100));

/** Apps an app may call, by slug. */
export const DeclaredUses = Schema.Array(AppSlug).check(Schema.isMaxLength(32));

export const AppCallCommand = Schema.Struct({
  app: AppSlug,
  tool: Schema.NonEmptyString.check(Schema.isMaxLength(300)),
  input: JsonValue,
});
export type AppCallCommand = typeof AppCallCommand.Type;

/**
 * Why a `ctx.tools` call did not return the target's output: the host runs no app calls
 * (`unavailable`), the app does not list the target in `uses` (`undeclared`), the app or tool does
 * not exist (`not_found`), the input was refused (`input`), the tool needs an approval this call
 * cannot ask for (`approval`), the actor may not use it (`denied`), or it failed (`execution`).
 */
export class AppCallFailure extends Schema.TaggedError<AppCallFailure>()("AppCallFailure", {
  reason: Schema.Literals([
    "unavailable",
    "undeclared",
    "not_found",
    "input",
    "approval",
    "denied",
    "execution",
  ]),
  message: Schema.optionalKey(FailureMessage),
  approvalUrl: Schema.optionalKey(Schema.String),
}) {}

/**
 * An app call's answer over the invocation's private control channel: the target's output, or why
 * the host refused or the target failed. Encoded as a successful control reply, so a refusal reaches
 * the app with its reason instead of as an engine failure.
 */
export const AppCallReply = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), value: JsonValue }),
  Schema.Struct({ ok: Schema.Literal(false), error: AppCallFailure }),
]);

/** The host capability behind `ctx.tools`, supplied only to an authorized invocation. */
export interface AppCallHostControls {
  readonly call: (command: AppCallCommand) => Effect.Effect<JsonValue, AppCallFailure>;
}

/**
 * `ctx.tools.<app>.<tool path>(input)`: call a tool of an app this app declares in `uses`, as the
 * person running this tool. Resolves with the target tool's output; rejects with `AppCallFailure`.
 */
export interface AppTools {
  readonly [app: string]: AppToolPath;
}
/** One app, or one segment of its tool path, under `ctx.tools`; call it to run that tool. */
export interface AppToolPath {
  (input?: JsonValue): Promise<JsonValue>;
  readonly [segment: string]: AppToolPath;
}
