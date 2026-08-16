// Worker entry point: /mcp is the MCP endpoint, / is a landing page,
// /health reports artifact freshness, and a cron trigger runs golden checks.

import { createMcpHandler } from "agents/mcp/server";

const MAX_BODY_BYTES = 262_144; // MCP tool inputs are ≤ 8 KB; 256 KB is generous
import { createServer } from "./mcp";
import { resolveSha, type Env } from "./upstream";
import { parse } from "./parser";
import { getDictionary, lookupWord } from "./dictionary";
import { refgramToc } from "./docs";
import { particleInfo } from "./glosser";

const LANDING = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>berskol — Eberban MCP server</title>
<style>
  body { font: 16px/1.6 system-ui, sans-serif; max-width: 42rem;
         margin: 3rem auto; padding: 0 1rem; color: #222; background: #fdfdfc; }
  code { background: #eee; padding: .1em .35em; border-radius: 4px; }
  h1 { font-size: 1.6rem; } a { color: #2a6f4e; }
  @media (prefers-color-scheme: dark) {
    body { color: #ddd; background: #161618; } code { background: #2a2a2e; }
    a { color: #7fc8a4; }
  }
</style>
</head>
<body>
<h1>berskol</h1>
<p>An <a href="https://modelcontextprotocol.io">MCP</a> server for the
<a href="https://github.com/eberban/eberban">Eberban</a> constructed language:
parser, dictionary, grammar, and reference documentation — always fresh from
the Eberban repository, nothing to rebuild or republish.</p>
<p>Endpoint: <code>https://berskol.app/mcp</code> (Streamable HTTP)</p>
<p>Add it to Claude, ChatGPT, or any MCP client as a custom
connector/server with that URL. No authentication required.</p>
<p>Content and code are fetched from and executed on behalf of the upstream
repository; document text is served verbatim and should be treated as
reference data.</p>
</body>
</html>`;

async function health(env: Env, ctx: ExecutionContext): Promise<Response> {
  const out: Record<string, unknown> = { at: new Date().toISOString() };
  try {
    const { sha, stale } = await resolveSha(env, ctx);
    out.upstream = { sha, stale };
  } catch (e) {
    out.upstream = { error: e instanceof Error ? e.message : String(e) };
  }
  try {
    out.lastGoldenCheck = JSON.parse(
      (await env.CACHE.get("health:last")) ?? "null",
    );
  } catch {
    out.lastGoldenCheck = { ok: false, error: "corrupt health:last KV entry" };
  }
  const upstream = out.upstream as { error?: string; stale?: boolean };
  const golden = out.lastGoldenCheck as {
    ok?: boolean;
    stale?: boolean;
  } | null;
  // `ok` = functioning (possibly from cache); `degraded` = serving stale or
  // upstream unreachable. Monitors can alert on either signal.
  const ok = upstream.error === undefined && (golden?.ok ?? true);
  const degraded =
    upstream.error !== undefined ||
    upstream.stale === true ||
    golden?.stale === true;
  return Response.json({ ok, degraded, ...out }, { status: ok ? 200 : 503 });
}

/** Golden checks: exercise every subsystem against known-good inputs. */
async function goldenChecks(env: Env, ctx: ExecutionContext): Promise<void> {
  const checks: Record<string, string> = {};
  const run = async (name: string, fn: () => Promise<boolean>) => {
    try {
      checks[name] = (await fn()) ? "ok" : "FAILED: unexpected result";
    } catch (e) {
      checks[name] = `FAILED: ${e instanceof Error ? e.message : String(e)}`;
    }
  };

  let anyStale = false;
  await run("parse", async () => {
    const r = await parse(env, ctx, "a mian etiansa meon");
    anyStale ||= r.stale;
    return r.ok === true;
  });
  await run("parse-reject", async () => {
    const r = await parse(env, ctx, "xqz");
    return r.ok === false;
  });
  await run("dictionary", async () => {
    const { index, meta } = await getDictionary(env, ctx);
    anyStale ||= meta.stale;
    return lookupWord(index, "mian") !== null;
  });
  await run("particle", async () => {
    const r = await particleInfo(env, ctx, "vio");
    anyStale ||= r.stale;
    return r.ok && r.info != null;
  });
  await run("refgram", async () => {
    const toc = await refgramToc(env, ctx);
    anyStale ||= toc.stale;
    return toc.entries.length > 5;
  });

  // `ok` measures function; staleness (KV-fallback mode) is reported
  // separately so monitors can distinguish "broken" from "serving stale".
  const ok = Object.values(checks).every((v) => v === "ok");
  await env.CACHE.put(
    "health:last",
    JSON.stringify({ ok, stale: anyStale, at: new Date().toISOString(), checks }),
  );
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);

    if (url.pathname === "/mcp") {
      if (env.RL && request.method !== "OPTIONS") {
        const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
        const { success } = await env.RL.limit({ key: ip });
        if (!success) {
          return Response.json(
            {
              jsonrpc: "2.0",
              error: { code: -32000, message: "rate limited; slow down" },
              id: null,
            },
            { status: 429, headers: { "Retry-After": "30" } },
          );
        }
      }
      if (request.method === "POST") {
        const len = Number(request.headers.get("Content-Length") ?? "0");
        if (!Number.isFinite(len) || len > MAX_BODY_BYTES) {
          ctx.waitUntil(request.body?.cancel().catch(() => {}) ?? Promise.resolve());
          return Response.json(
            {
              jsonrpc: "2.0",
              error: { code: -32600, message: "request body too large" },
              id: null,
            },
            { status: 413 },
          );
        }
      }
      return createMcpHandler(() => createServer(env, ctx), {
        route: "/mcp",
        corsOptions: { origin: "*" },
        allowedOriginHostnames: "*",
        allowedHostnames: [
          "berskol.app",
          "berskol.me-fe5.workers.dev",
          "localhost",
          "127.0.0.1",
        ],
      })(request, env, ctx);
    }

    if (url.pathname === "/") {
      return new Response(LANDING, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
    if (url.pathname === "/health") return health(env, ctx);

    return new Response("Not found. MCP endpoint: /mcp", { status: 404 });
  },

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(goldenChecks(env, ctx));
  },
} satisfies ExportedHandler<Env>;
