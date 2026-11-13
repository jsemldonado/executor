/**
 * Optional Standard Webhooks notice for each browser approval link, so another service can push
 * the link to the person who answers it. Delivery never blocks or fails the approval.
 */
import { Config, Effect, Option, Redacted } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import type { McpExecutionResult } from "../contracts/execute.ts";

type Pending = Extract<McpExecutionResult, { status: "approval-required" | "input-required" }>;

export type ApprovalAnnouncer = (
  pending: Pending,
  approvalUrl: string,
  appName: string | undefined,
) => Effect.Effect<void>;

export const appOf = (pending: Pending) =>
  pending.status === "approval-required" ? pending.invocation.app : pending.tool.app;

const settings = Config.all({
  url: Config.URL("EXECUTOR_APPROVAL_WEBHOOK_URL"),
  secret: Config.Redacted("EXECUTOR_APPROVAL_WEBHOOK_SECRET"),
}).pipe(Config.option);

// Argument names only: values may hold credentials or private content.
const argsSummary = (input: unknown) =>
  typeof input === "object" && input !== null && !Array.isArray(input)
    ? Object.keys(input).join(", ").slice(0, 200)
    : "";

const accountIds = (scopes: ReadonlyArray<object | undefined>) =>
  scopes
    .flatMap((scope) => Object.values(scope ?? {}))
    .flatMap((slot: unknown) => (Array.isArray(slot) ? slot : [slot]))
    .map((account: unknown) =>
      typeof account === "object" && account !== null && "id" in account
        ? String(account.id)
        : String(account),
    );

const describe = (pending: Pending) => {
  if (pending.status === "approval-required") {
    const { app, tool, input, accounts } = pending.invocation;
    return {
      app,
      tool,
      argsSummary: argsSummary(input),
      accounts: [accounts.app, accounts.user],
    };
  }
  const { app, tool, accounts } = pending.tool;
  return { app, tool, argsSummary: "", accounts: [accounts?.app, accounts?.user] };
};

const sign = async (secret: string, id: string, timestamp: string, body: string) => {
  const raw = Uint8Array.from(atob(secret.replace(/^whsec_/u, "")), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${id}.${timestamp}.${body}`),
  );
  return `v1,${btoa(String.fromCharCode(...new Uint8Array(mac)))}`;
};

/** Undefined unless EXECUTOR_APPROVAL_WEBHOOK_URL and EXECUTOR_APPROVAL_WEBHOOK_SECRET are both set. */
export const approvalWebhook: Effect.Effect<ApprovalAnnouncer | undefined> = settings.pipe(
  Effect.map(
    Option.match({
      onNone: () => undefined,
      onSome:
        ({ url, secret }): ApprovalAnnouncer =>
        (pending, approvalUrl, appName) => {
          const { app, tool, argsSummary, accounts } = describe(pending);
          const account = accountIds(accounts).join(", ");
          const body = JSON.stringify({
            approvalId: pending.requestId,
            approvalUrl,
            app,
            ...(appName === undefined ? {} : { appName }),
            tool,
            argsSummary,
            ...(account === "" ? {} : { account }),
            expiresAt: new Date(pending.expiresAt).toISOString(),
          });
          const id = `msg_${pending.requestId}`;
          const timestamp = String(Math.floor(Date.now() / 1000));
          return Effect.promise(() => sign(Redacted.value(secret), id, timestamp, body)).pipe(
            Effect.flatMap((signature) =>
              HttpClient.execute(
                HttpClientRequest.post(url).pipe(
                  HttpClientRequest.setHeaders({
                    "webhook-id": id,
                    "webhook-timestamp": timestamp,
                    "webhook-signature": signature,
                  }),
                  HttpClientRequest.bodyText(body, "application/json"),
                ),
              ),
            ),
            Effect.timeout("10 seconds"),
            Effect.provide(FetchHttpClient.layer),
            Effect.ignore,
            Effect.forkDetach,
            Effect.asVoid,
          );
        },
    }),
  ),
  // A malformed URL or secret disables the notice rather than the MCP server.
  Effect.orElseSucceed(() => undefined),
);
