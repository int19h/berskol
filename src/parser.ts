// Parser pipeline: .peggy grammar → peggy codegen (to source, no eval) →
// sandboxed dynamic worker isolate, cached by grammar version.

import * as peggy from "peggy";
import {
  fetchUpstream,
  promote,
  VersionMemo,
  ISOLATE_COMPAT_DATE,
  type Env,
  type Upstream,
} from "./upstream";

export const GRAMMAR_PATH = "web/src/grammar/eberban.peggy";
const WEB_PACKAGE_PATH = "web/package.json";

// Bump when WRAPPER or codegen flags change, so stale isolates are abandoned.
const WRAPPER_VERSION = 4;
const ISOLATE_TIMEOUT_MS = 10_000;

const WRAPPER = `
import * as parser from "./eberban.peggy.js";
export default {
  async fetch(req) {
    const { text } = await req.json();
    try {
      const tree = parser.parse(text);
      return Response.json({ ok: true, tree });
    } catch (e) {
      // A peggy SyntaxError carries a location: that is a genuine grammar
      // rejection. Anything else (e.g. a grammar action throwing) is a
      // parser malfunction, not invalid Eberban.
      return Response.json({
        ok: false,
        parserError: !(e && e.location),
        error: String((e && e.message) ?? e),
        location: (e && e.location) ?? null,
        expected: e && Array.isArray(e.expected) ? e.expected.slice(0, 10) : null,
      });
    }
  },
};
`;

const sourceMemo = new VersionMemo<string>();
const KV_LAST_GOOD_PARSER = "gen:parser";

export interface ParseOutcome {
  ok: boolean;
  tree?: unknown;
  /** True when the parser itself malfunctioned (not a grammar rejection). */
  parserError?: boolean;
  error?: string;
  location?: unknown;
  expected?: unknown;
  grammarSha: string;
  stale: boolean;
  warnings: string[];
}

function tryParse<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

export async function getGrammar(env: Env, ctx: ExecutionContext): Promise<Upstream> {
  // promote: false — the grammar is promoted only after codegen validates it.
  return fetchUpstream(env, ctx, GRAMMAR_PATH, { promote: false });
}

/**
 * Generate parser source with the same flags as upstream's `build-peggy`
 * script. On codegen failure (e.g. upstream adopted grammar syntax our pinned
 * peggy can't handle), fall back to the last-known-good generated source.
 */
async function getParserSource(
  env: Env,
  ctx: ExecutionContext,
  grammar: Upstream,
): Promise<{ source: string; sha: string; fellBack: boolean; warnings: string[] }> {
  const warnings: string[] = [];
  try {
    const source = sourceMemo.get(grammar.sha, () =>
      peggy.generate(grammar.text, {
        cache: true,
        format: "es",
        output: "source",
      }),
    );
    // Codegen succeeded: the grammar text is AST-valid (enough for the
    // pure-PEG consumers). Runtime validation gates gen:parser promotion —
    // see promoteRuntimeValidatedParser.
    promote(env, ctx, GRAMMAR_PATH, grammar);
    return { source, sha: grammar.sha, fellBack: false, warnings };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const kv = await env.CACHE.get(KV_LAST_GOOD_PARSER);
    const d = kv ? tryParse<{ source: string; sha: string }>(kv) : null;
    if (d) {
      warnings.push(
        `Parser generation from the current grammar failed (${msg}); ` +
          `using the last working grammar version ${d.sha.slice(0, 10)} instead.`,
      );
      return { source: d.source, sha: d.sha, fellBack: true, warnings };
    }
    throw new Error(`parser generation failed: ${msg}`);
  }
}

// gen:parser is promoted only after the generated parser demonstrably works
// as a parser: it returned a tree, or a genuine syntax rejection (which has
// a location). A grammar whose actions throw unconditionally never gets in.
const runtimeValidated = new Set<string>();

function promoteRuntimeValidatedParser(
  env: Env,
  ctx: ExecutionContext,
  sha: string,
  source: string,
  fetchedAt: string,
): void {
  if (runtimeValidated.has(sha)) return;
  runtimeValidated.add(sha);
  ctx.waitUntil(
    (async () => {
      const prev = await env.CACHE.get(KV_LAST_GOOD_PARSER);
      const p = prev ? tryParse<{ sha: string; fetchedAt?: string }>(prev) : null;
      if (p && (p.sha === sha || (p.fetchedAt && p.fetchedAt > fetchedAt))) return;
      await env.CACHE.put(
        KV_LAST_GOOD_PARSER,
        JSON.stringify({ source, sha, fetchedAt }),
      );
    })().catch(() => {
      runtimeValidated.delete(sha);
    }),
  );
}

/**
 * Grammar guaranteed to be parseable by our bundled peggy (for AST-based
 * consumers: pure-PEG resource, grammar_rule). Falls back to the last
 * promoted grammar — which was validated by codegen — when the current
 * upstream grammar cannot be parsed.
 */
const astValidMemo = new VersionMemo<boolean>();

export async function getParseableGrammar(
  env: Env,
  ctx: ExecutionContext,
): Promise<Upstream> {
  const grammar = await getGrammar(env, ctx);
  const valid = astValidMemo.get(grammar.sha, () => {
    try {
      peggy.parser.parse(grammar.text);
      return true;
    } catch {
      return false;
    }
  });
  if (valid) return grammar;
  const kv = await env.CACHE.get(`up:${GRAMMAR_PATH}`);
  const d = kv
    ? tryParse<{ text: string; sha: string; fetchedAt: string }>(kv)
    : null;
  if (d && d.sha !== grammar.sha)
    return { text: d.text, sha: d.sha, stale: true, fetchedAt: d.fetchedAt };
  throw new Error("current grammar is not parseable and no fallback is available");
}

/** Call a dynamic-worker entrypoint with a wall-clock timeout. */
export async function isolateCall(
  worker: { getEntrypoint(): { fetch(url: string, init?: RequestInit): Promise<Response> } },
  body: unknown,
): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const resp = await Promise.race([
      worker.getEntrypoint().fetch("http://isolate/", {
        method: "POST",
        body: JSON.stringify(body),
        // Best-effort cancellation of the isolate-side work on timeout; the
        // Promise.race below still bounds the caller either way.
        signal: AbortSignal.timeout(ISOLATE_TIMEOUT_MS),
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(new Error(`isolate timed out after ${ISOLATE_TIMEOUT_MS}ms`)),
          ISOLATE_TIMEOUT_MS,
        );
      }),
    ]);
    if (!resp.ok) {
      // Loader/isolate infrastructure failure — body is not our JSON.
      throw new Error(
        `isolate error ${resp.status}: ${(await resp.text()).slice(0, 200)}`,
      );
    }
    return await resp.json();
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function parse(
  env: Env,
  ctx: ExecutionContext,
  text: string,
): Promise<ParseOutcome> {
  const grammar = await getGrammar(env, ctx);
  const { source, sha, fellBack, warnings } = await getParserSource(
    env,
    ctx,
    grammar,
  );

  const peggyVer = peggy.VERSION ?? "unknown";
  const worker = env.LOADER.get(
    `parser-${sha}-p${peggyVer}-v${WRAPPER_VERSION}`,
    () => ({
      mainModule: "main.js",
      modules: { "main.js": WRAPPER, "eberban.peggy.js": source },
      compatibilityDate: ISOLATE_COMPAT_DATE,
      globalOutbound: null, // grammar actions run fully sandboxed, no network
    }),
  );

  const result = (await isolateCall(worker, { text })) as Omit<
    ParseOutcome,
    "grammarSha" | "stale" | "warnings"
  >;

  const functioned = result.ok === true || result.location != null;
  if (functioned && !fellBack && !grammar.stale) {
    promoteRuntimeValidatedParser(env, ctx, sha, source, grammar.fetchedAt);
  }
  if (result.parserError) {
    warnings.push(
      "The parser itself failed on this input (grammar defect upstream?); " +
        "this is NOT evidence the input is invalid Eberban.",
    );
  }

  const drift = await peggyDriftWarning(env, ctx);
  if (drift) warnings.push(drift);
  const stale = grammar.stale || fellBack;
  if (grammar.stale) {
    warnings.push(
      `Grammar was served from cache (upstream unreachable); ` +
        `last fetched ${grammar.fetchedAt}.`,
    );
  }
  return { ...result, grammarSha: sha, stale, warnings };
}

/** Warn when upstream's peggy requirement drifts from our bundled major. */
const driftMemo = new VersionMemo<string | null>();

async function peggyDriftWarning(
  env: Env,
  ctx: ExecutionContext,
): Promise<string | null> {
  try {
    const pkg = await fetchUpstream(env, ctx, WEB_PACKAGE_PATH);
    return driftMemo.get(pkg.sha, () => {
      const parsed = JSON.parse(pkg.text) as {
        devDependencies?: Record<string, string>;
        dependencies?: Record<string, string>;
      };
      const range =
        parsed.devDependencies?.peggy ?? parsed.dependencies?.peggy;
      if (!range) return null;
      const upstreamMajor = range.match(/(\d+)/)?.[1];
      const bundledMajor = (peggy.VERSION ?? "0").split(".")[0];
      if (upstreamMajor && upstreamMajor !== bundledMajor) {
        return (
          `Upstream requires peggy ${range} but this server bundles ` +
          `${peggy.VERSION}; parse results may differ from the official parser.`
        );
      }
      return null;
    });
  } catch {
    return null; // drift check is best-effort
  }
}
