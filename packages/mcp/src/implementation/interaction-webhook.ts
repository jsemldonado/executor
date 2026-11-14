/**
 * Optional Standard Webhooks notice for each request that waits on a person: a browser approval or
 * input link, or an account connection link, so another service can push it to the person who
 * answers it. Delivery never blocks or fails the request.
 */
import { Config, Effect, Option, Redacted } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import type { McpExecutionResult } from "../contracts/execute.ts";

type Pending = Extract<McpExecutionResult, { status: "approval-required" | "input-required" }>;

/** One request that waits on a person, as the webhook's body carries it. */
export interface Interaction {
  readonly kind: "approval" | "input" | "connect";
  readonly requestId: string;
  readonly url: string;
  readonly app: string;
  readonly appName?: string | undefined;
  readonly tool?: string | undefined;
  readonly argsSummary?: string | undefined;
  readonly account?: string | undefined;
  readonly requirement?: string | undefined;
  readonly expireTime: string;
}

export type InteractionAnnouncer = (interaction: Interaction) => Effect.Effect<void>;

export const appOf = (pending: Pending) =>
  pending.status === "approval-required" ? pending.invocation.app : pending.tool.app;

const settings = Config.all({
  url: Config.URL("EXECUTOR_INTERACTION_WEBHOOK_URL"),
  secret: Config.Redacted("EXECUTOR_INTERACTION_WEBHOOK_SECRET"),
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

/** The interaction a paused execution waits on, once its browser link is minted. */
export const pendingInteraction = (
  pending: Pending,
  url: string,
  appName: string | undefined,
): Interaction => {
  const approval = pending.status === "approval-required";
  const { app, tool, accounts } = approval ? pending.invocation : pending.tool;
  const account = accountIds([accounts?.app, accounts?.user]).join(", ");
  return {
    kind: approval ? "approval" : "input",
    requestId: pending.requestId,
    url,
    app,
    appName,
    tool,
    argsSummary: approval ? argsSummary(pending.invocation.input) : undefined,
    account: account === "" ? undefined : account,
    expireTime: new Date(pending.expiresAt).toISOString(),
  };
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

/** Undefined unless EXECUTOR_INTERACTION_WEBHOOK_URL and EXECUTOR_INTERACTION_WEBHOOK_SECRET are both set. */
export const interactionWebhook: Effect.Effect<InteractionAnnouncer | undefined> = settings.pipe(
  Effect.map(
    Option.match({
      onNone: () => undefined,
      onSome:
        ({ url, secret }): InteractionAnnouncer =>
        (interaction) => {
          const body = JSON.stringify(interaction);
          const id = `msg_${interaction.requestId}`;
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
