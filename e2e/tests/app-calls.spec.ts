/**
 * An app calls another app's tools through `ctx.tools` only when it declares the target in `uses`,
 * and each call answers with the target's output or a reason the calling code can act on.
 */
import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { scenarios } from "../test-plan.ts";
import { Api, body } from "../support/api.ts";
import { Actors } from "../support/actors.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App } from "../support/contracts.ts";
import { appsManifest } from "../support/apps-release.ts";

const target = `import { defineApp, mutation, query, number, object, router } from "apps";
const double = query({ input: object({ n: number() }) }, async (_ctx, input) => ({ doubled: input.n * 2 }));
const add = mutation({ input: object({ a: number(), b: number() }) }, async (_ctx, input) => ({ sum: input.a + input.b }));
export default defineApp({}, { tools: router({ double, add }) });`;

const caller = (
  uses: string,
  slug: string,
) => `import { defineApp, mutation, number, object, string, router } from "apps";
const settle = async (work) => {
  try { return { ok: await work() }; }
  catch (error: any) { return { failed: { tag: error?._tag ?? null, reason: error?.reason ?? null, message: error?.message ?? "" } }; }
};
const combine = mutation({ input: object({ n: number() }) }, (ctx, input) =>
  settle(async () => {
    const doubled = await ctx.tools[${JSON.stringify(slug)}].double({ n: input.n });
    const added = await ctx.tools[${JSON.stringify(slug)}].add({ a: doubled.doubled, b: 1 });
    return added.sum;
  }));
const missing = mutation({ input: object({}) }, (ctx) =>
  settle(() => ctx.tools[${JSON.stringify(slug)}].vanish({})));
const elsewhere = mutation({ input: object({ app: string() }) }, (ctx, input) =>
  settle(() => ctx.tools[input.app].double({ n: 1 })));
export default defineApp({ uses: ${uses} }, { tools: router({ combine, missing, elsewhere }) });`;

const Settled = Schema.Union([
  Schema.Struct({ ok: Schema.Json }),
  Schema.Struct({
    failed: Schema.Struct({
      tag: Schema.NullOr(Schema.String),
      reason: Schema.NullOr(Schema.String),
      message: Schema.String,
    }),
  }),
]);

layer(HostedLive, { excludeTestServices: true })("App calls", (it) => {
  it.effect(scenarios.appCalls.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors;
        const prefix = `/api/organizations/${actors.organization.id}`;
        const apps: string[] = [];
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            for (const app of apps.toReversed())
              yield* api.request(actors.owner, "DELETE", `${prefix}/apps/${app}`);
          }).pipe(Effect.orDie),
        );
        const deploy = (label: string, content: string) =>
          Effect.gen(function* () {
            const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
              name: `${label} ${randomUUID().slice(0, 8)}`,
              files: [{ path: "index.ts", content }, appsManifest],
            });
            expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
            const app = yield* body(App, deployed);
            apps.push(app.id);
            return app;
          });
        const call = (app: string, tool: string, input: Schema.Json) =>
          Effect.gen(function* () {
            const response = yield* api.request(
              actors.owner,
              "POST",
              `${prefix}/apps/${app}/tools/call`,
              { tool, kind: "mutation", input },
            );
            expect(response.status, JSON.stringify(response.body)).toBe(200);
            return yield* body(Settled, response);
          });

        const math = yield* deploy("Calls target", target);
        const declared = yield* deploy(
          "Calls caller",
          caller(JSON.stringify([math.slug]), math.slug),
        );
        const silent = yield* deploy("Calls silent", caller("[]", math.slug));

        expect(yield* call(declared.id, "combine", { n: 20 })).toEqual({ ok: 41 });
        expect(yield* call(declared.id, "missing", {})).toEqual({
          failed: {
            tag: "AppCallFailure",
            reason: "not_found",
            message: expect.stringContaining(`${math.slug}.vanish`),
          },
        });
        expect(yield* call(declared.id, "elsewhere", { app: silent.slug })).toEqual({
          failed: {
            tag: "AppCallFailure",
            reason: "undeclared",
            message: expect.stringContaining(`does not declare "${silent.slug}"`),
          },
        });
        expect(yield* call(silent.id, "combine", { n: 1 })).toEqual({
          failed: {
            tag: "AppCallFailure",
            reason: "undeclared",
            message: expect.stringContaining(`does not declare "${math.slug}"`),
          },
        });
      }),
    ),
  );
});
