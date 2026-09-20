// Semantics pipeline: upstream's lowering + formula printer give a parsed
// text its logical reading in the refgram notation.
//
// Upstream ships those modules as TypeScript, and the worker runs on workerd,
// which has no type stripper we can reach (node:module.stripTypeScriptTypes
// throws ERR_METHOD_NOT_IMPLEMENTED) and whose dynamic-worker loader accepts
// JS, not TS. So the stripping happens host-side with sucrase, a pure text
// transform with no eval, and the stripped modules, the generated parser, and
// the dictionary are loaded into one sandboxed isolate. Import specifiers keep
// their `.ts` extension: to the loader those are just module names, and
// keeping them means upstream's relative imports resolve unchanged.

import { transform } from "sucrase";
import * as peggy from "peggy";
import {
  fetchUpstream,
  VersionMemo,
  ISOLATE_COMPAT_DATE,
  type Env,
  type WorkerCode,
} from "./upstream";
import { getGrammar, getParserSource, isolateCall, peggyDriftWarning } from "./parser";
import { getDictionary } from "./dictionary";

/** Served as a doc resource; see docs.ts. */
export const SEMANTICS_README_PATH = "web/src/semantics/README.md";

// Upstream path -> module name inside the isolate. The isolate layout mirrors
// the upstream directory layout under web/src/, so `../shared/places.js` and
// friends resolve without rewriting any import.
const CODE_FILES: { path: string; module: string; ts: boolean }[] = [
  ...["tree", "ir", "places", "lower", "print"].map((n) => ({
    path: `web/src/semantics/${n}.ts`,
    module: `semantics/${n}.ts`,
    ts: true,
  })),
  ...["dict-lint", "places", "particle-gloss"].map((n) => ({
    path: `web/src/shared/${n}.js`,
    module: `shared/${n}.js`,
    ts: false,
  })),
  {
    path: "web/src/visual-parser/compound-key.js",
    module: "visual-parser/compound-key.js",
    ts: false,
  },
];

const PARSER_MODULE = "grammar/eberban.peggy.js";
const DICTIONARY_MODULE = "dictionary.json";

// Bump when WRAPPER or the module layout changes, so stale isolates and stale
// gen:semantics entries are abandoned.
const WRAPPER_VERSION = 1;
const KV_LAST_GOOD_SEMANTICS = "gen:semantics";

const WRAPPER = `
import * as parser from "./${PARSER_MODULE}";
import { lowerText } from "./semantics/lower.ts";
import { printProgram } from "./semantics/print.ts";
import dictionary from "./${DICTIONARY_MODULE}";

export default {
  async fetch(req) {
    const { text, allDefaults } = await req.json();
    let tree;
    try {
      tree = parser.parse(text);
    } catch (e) {
      // Same shape parser.ts returns: a location means a genuine grammar
      // rejection, anything else is the parser malfunctioning.
      return Response.json({
        ok: false,
        parserError: !(e && e.location),
        error: String((e && e.message) ?? e),
        location: (e && e.location) ?? null,
        expected: e && Array.isArray(e.expected) ? e.expected.slice(0, 10) : null,
      });
    }
    try {
      const program = lowerText(tree, dictionary, { allDefaults: !!allDefaults });
      return Response.json({
        ok: true,
        formula: printProgram(program),
        unsupported: Array.isArray(program.unsupported) ? program.unsupported : [],
      });
    } catch (e) {
      // The text parsed, so it is Eberban; the printer is what broke.
      return Response.json({
        ok: false,
        lowerError: String((e && e.message) ?? e),
      });
    }
  },
};
`;

// The golden case from upstream's semantics README. gen:semantics is promoted
// only after this exact output comes back out of the real isolate, so a
// broken upstream revision cannot become the last-known-good copy.
export const GOLDEN_TEXT = "a mian bjan";
export const GOLDEN_FORMULA = [
  "bjan_1(c,e,a) := bjan(c,e,a)",
  "bjan_1^w(c,e) := ∃a. bjan_1(c,e,a)",
  "mian_1(c,e) := mian(c,e) ∧ bjan_1^w(c,e)",
  "mian_1^w(c) := ∃e. mian_1(c,e)",
  "assert mian_1^w(c)",
].join("\n");

export interface FormulaOutcome {
  ok: boolean;
  formula?: string;
  /** Constructs the lowering refuses to guess about. */
  unsupported?: string[];
  /** True when the parser itself malfunctioned (not a grammar rejection). */
  parserError?: boolean;
  error?: string;
  location?: unknown;
  expected?: unknown;
  /** Set when lowering or printing threw: a printer defect, not bad Eberban. */
  lowerError?: string;
  sha: string;
  stale: boolean;
  warnings: string[];
}

interface Bundle {
  /** Isolate module name -> source, for the upstream code files only. */
  modules: Record<string, string>;
  sha: string;
  fetchedAt: string;
  stale: boolean;
}

interface StoredBundle {
  sha: string;
  modules: Record<string, string>;
  fetchedAt: string;
}

function tryParse<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

// Stripping the five .ts files costs ~50 ms, so it is memoized per SHA
// exactly like the peggy codegen.
const bundleMemo = new VersionMemo<Record<string, string>>();

/**
 * Fetch the upstream semantics modules and strip the TypeScript ones.
 * `promote: false` throughout: this bundle is promoted as a whole, by
 * `gen:semantics`, and only after the golden case validates it.
 */
async function fetchBundle(env: Env, ctx: ExecutionContext): Promise<Bundle> {
  const files = await Promise.all(
    CODE_FILES.map(async (f) => ({
      ...f,
      content: await fetchUpstream(env, ctx, f.path, { promote: false }),
    })),
  );
  // All files come from one resolved SHA; a fallback copy of any one of them
  // makes the whole bundle stale.
  const sha = files[0].content.sha;
  const stale = files.some((f) => f.content.stale || f.content.sha !== sha);
  const fetchedAt = files
    .map((f) => f.content.fetchedAt)
    .reduce((a, b) => (a < b ? a : b));
  const strip = () => {
    const out: Record<string, string> = {};
    for (const f of files) {
      out[f.module] = f.ts
        ? transform(f.content.text, {
            transforms: ["typescript"],
            keepUnusedImports: false,
            filePath: f.module,
          }).code
        : f.content.text;
    }
    return out;
  };
  // Only a coherent bundle goes in the memo: a mixed one is keyed by a SHA
  // that does not describe all of its files.
  const modules = stale ? strip() : bundleMemo.get(sha, strip);
  return { modules, sha, fetchedAt, stale };
}

async function loadStoredBundle(env: Env): Promise<Bundle | null> {
  const kv = await env.CACHE.get(KV_LAST_GOOD_SEMANTICS);
  const d = kv ? tryParse<StoredBundle>(kv) : null;
  if (!d || !d.modules || !d.sha) return null;
  return { modules: d.modules, sha: d.sha, fetchedAt: d.fetchedAt, stale: true };
}

// One promotion per SHA per isolate; cleared on failure so a later request
// retries rather than silently never promoting (as in parser.ts).
const promoted = new Set<string>();

function promoteBundle(env: Env, ctx: ExecutionContext, bundle: Bundle): void {
  if (promoted.has(bundle.sha)) return;
  promoted.add(bundle.sha);
  ctx.waitUntil(
    (async () => {
      const prev = await env.CACHE.get(KV_LAST_GOOD_SEMANTICS);
      const p = prev ? tryParse<StoredBundle>(prev) : null;
      if (p && (p.sha === bundle.sha || (p.fetchedAt && p.fetchedAt > bundle.fetchedAt)))
        return;
      await env.CACHE.put(
        KV_LAST_GOOD_SEMANTICS,
        JSON.stringify({
          sha: bundle.sha,
          modules: bundle.modules,
          fetchedAt: bundle.fetchedAt,
        }),
      );
    })().catch(() => {
      promoted.delete(bundle.sha);
    }),
  );
}

interface IsolateSpec {
  key: string;
  code: WorkerCode;
}

function buildIsolate(
  bundle: Bundle,
  parserSource: string,
  parserSha: string,
  dictionary: Record<string, unknown>,
  dictionarySha: string,
): IsolateSpec {
  // Normally one commit SHA keys everything baked into the isolate. When a
  // component fell back to an older copy its SHA is folded into the key too,
  // so two different isolate contents can never share an ID.
  const parts = [bundle.sha];
  // A stale bundle may mix files from more than one commit (per-file KV
  // fallback during a partial outage), so its SHA does not describe its
  // contents; keep it out of the clean key's isolate and golden caches.
  if (bundle.stale) parts.push("stale");
  if (parserSha !== bundle.sha) parts.push(`g${parserSha}`);
  if (dictionarySha !== bundle.sha) parts.push(`d${dictionarySha}`);
  const peggyVer = peggy.VERSION ?? "unknown";
  return {
    key: `semantics-${parts.join("-")}-p${peggyVer}-v${WRAPPER_VERSION}`,
    code: {
      mainModule: "main.js",
      modules: {
        // Every source goes in as `{ js }`: without an explicit type the
        // loader infers it from the module name and rejects the `.ts` names,
        // which we keep so upstream's own imports resolve unchanged. The
        // dictionary goes in as `{ json }` with the already-parsed value, so
        // the isolate gets it as data.
        "main.js": { js: WRAPPER },
        ...Object.fromEntries(
          Object.entries(bundle.modules).map(([name, js]) => [name, { js }]),
        ),
        [PARSER_MODULE]: { js: parserSource },
        [DICTIONARY_MODULE]: { json: dictionary },
      },
      compatibilityDate: ISOLATE_COMPAT_DATE,
      globalOutbound: null, // upstream code runs fully sandboxed, no network
    },
  };
}

type RawOutcome = Omit<FormulaOutcome, "sha" | "stale" | "warnings">;

async function callIsolate(
  env: Env,
  spec: IsolateSpec,
  text: string,
  allDefaults: boolean,
): Promise<RawOutcome> {
  const worker = env.LOADER.get(spec.key, () => spec.code);
  return (await isolateCall(worker, { text, allDefaults })) as RawOutcome;
}

// Golden-gate results per isolate ID: null means validated, a string is the
// reason it failed. Both are memoized so the extra isolate call happens once
// per upstream version, not once per request.
const goldenChecked = new Map<string, string | null>();

async function checkGolden(env: Env, spec: IsolateSpec): Promise<string | null> {
  const seen = goldenChecked.get(spec.key);
  if (seen !== undefined) return seen;
  let reason: string | null = null;
  try {
    const r = await callIsolate(env, spec, GOLDEN_TEXT, false);
    if (r.ok !== true) {
      reason = r.error ?? r.lowerError ?? "golden sentence did not lower";
    } else if ((r.formula ?? "") !== GOLDEN_FORMULA) {
      reason = `golden sentence "${GOLDEN_TEXT}" printed an unexpected formula`;
    }
  } catch (e) {
    // A thrown error is infrastructure (loader failure, timeout), not a
    // verdict on the bundle; report it but let the next request retry rather
    // than pinning this version to the fallback for the isolate's lifetime.
    return e instanceof Error ? e.message : String(e);
  }
  goldenChecked.set(spec.key, reason);
  return reason;
}

/**
 * Lower `text` to its logical formula. Falls back to the last golden-validated
 * semantics bundle in KV when the current upstream one cannot be stripped,
 * cannot be loaded, or fails the golden case.
 */
export async function formula(
  env: Env,
  ctx: ExecutionContext,
  text: string,
  allDefaults: boolean,
): Promise<FormulaOutcome> {
  const warnings: string[] = [];

  const grammar = await getGrammar(env, ctx);
  const parserSource = await getParserSource(env, ctx, grammar);
  warnings.push(...parserSource.warnings);
  const { index, meta: dict } = await getDictionary(env, ctx);

  const isolateFor = (b: Bundle) =>
    buildIsolate(b, parserSource.source, parserSource.sha, index.raw, dict.sha);

  let fresh: Bundle | null = null;
  let bundleError: string | null = null;
  try {
    fresh = await fetchBundle(env, ctx);
    // Strip failure, load failure and a wrong formula all land here: the
    // golden case is the only evidence that this bundle actually works.
    bundleError = await checkGolden(env, isolateFor(fresh));
  } catch (e) {
    bundleError = e instanceof Error ? e.message : String(e);
  }

  let bundle: Bundle;
  let fellBack = false;
  if (fresh && !bundleError) {
    bundle = fresh;
  } else {
    const stored = await loadStoredBundle(env);
    if (!stored)
      throw new Error(
        `semantics unavailable (${bundleError ?? "unknown error"}) ` +
          `and no last-known-good copy is stored`,
      );
    warnings.push(
      `The semantics modules at ${(fresh?.sha ?? "the current commit").slice(0, 10)} ` +
        `could not be used (${bundleError}); falling back to the last working ` +
        `version ${stored.sha.slice(0, 10)}.`,
    );
    bundle = stored;
    fellBack = true;
  }
  const spec = isolateFor(bundle);

  const result = await callIsolate(env, spec, text, allDefaults);

  // Promotion gate: the bundle is fresh and its golden case passed through an
  // isolate carrying the current grammar, so it is known to work as shipped.
  // The dictionary is data, not part of the stored bundle, so its freshness
  // does not gate promotion; it does make the answer stale.
  const validated =
    !fellBack && !bundle.stale && !parserSource.fellBack && !grammar.stale;
  if (validated) promoteBundle(env, ctx, bundle);
  const stale = !validated || dict.stale;

  if (result.parserError) {
    warnings.push(
      "The parser itself failed on this input (grammar defect upstream?); " +
        "this is NOT evidence the input is invalid Eberban.",
    );
  }
  if (result.lowerError) {
    warnings.push(
      "The text parsed but the semantics printer failed on it (upstream " +
        "defect?); this is NOT evidence the input is invalid Eberban.",
    );
  }
  if (grammar.stale) {
    warnings.push(
      `Grammar was served from cache (upstream unreachable); ` +
        `last fetched ${grammar.fetchedAt}.`,
    );
  }
  if (dict.stale) {
    warnings.push(
      `Dictionary was served from cache (upstream unreachable); ` +
        `last fetched ${dict.fetchedAt}.`,
    );
  }
  const drift = await peggyDriftWarning(env, ctx);
  if (drift) warnings.push(drift);

  return {
    ...result,
    sha: bundle.sha,
    stale,
    warnings,
  };
}
