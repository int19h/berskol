# berskol — Eberban MCP server

A remote MCP server at `https://berskol.app/mcp` giving any MCP client (Claude,
ChatGPT connectors, etc.) always-fresh access to the [Eberban](https://github.com/eberban/eberban)
constructed language: parser, dictionary, grammar, and reference documentation.

## Goals

1. **Zero maintainer touch.** The Eberban maintainer never rebuilds, republishes,
   or even knows this server exists. All content is fetched from the
   `eberban/eberban` GitHub repo (`master`) at runtime. New dictionary words,
   grammar tweaks, and doc edits become visible within the cache TTL (5 min).
2. **Works everywhere.** MCP-over-Streamable-HTTP is the lowest common
   denominator that reaches ChatGPT web (where skills cannot fetch) and every
   other MCP client.
3. **Skill-shaped.** Documents follow the SEP-2640 `skill://` resource
   convention so conforming hosts treat them as a first-class skill; for
   everyone else they are ordinary MCP resources plus a mirror tool.

## Stack

- Cloudflare Worker (personal account, paid plan), custom domain `berskol.app`,
  MCP endpoint at `/mcp`, minimal landing page at `/`.
- `createMcpHandler` from `agents/mcp/server` (stateless path; `McpAgent` is
  deprecated) + `McpServer` from `@modelcontextprotocol/server@2` + `zod`.
- `peggy` (pinned, currently ^5.0.6 matching upstream `web/package.json`)
  bundled at deploy time, used only for codegen-to-string and AST access —
  no eval on the host.
- **Worker Loaders** (Dynamic Workers) to execute the generated parser and
  upstream JS modules in sandboxed isolates. Verified working in production
  on this account.
- A YAML parser bundled at deploy time for the dictionary.
- `sucrase` (pinned) to strip types from upstream's TypeScript semantics
  modules: they are fetched at request time, so wrangler's deploy-time esbuild
  never sees them, and workerd has no stripper of its own
  (`node:module.stripTypeScriptTypes` throws `ERR_METHOD_NOT_IMPLEMENTED`).
  Pure text transform, no eval.
- KV namespace `CACHE` for last-known-good artifacts (see Resilience).

## Content pipeline

`master` is resolved to a commit SHA once per 5-minute window via the
commits atom feed (`github.com/.../commits/master.atom` — **not** the GitHub
API, whose unauthenticated rate limits are a footgun on shared Workers egress
IPs; verified empirically). Every artifact is then fetched at
`raw.githubusercontent.com/eberban/eberban/<sha>/...`: on the live path, all
artifacts served for one request are mutually coherent, and immutable URLs
cache long-term. (In degraded mode — per-file KV fallback during partial
outages — an older version of one artifact may be mixed in; such responses
are flagged `stale` with their own SHA.)
Caching uses the Cache API explicitly so only 200 responses are stored (no
404/500 poisoning). The SHA is the version key for all downstream caching.

| Upstream file | Used for |
|---|---|
| `web/src/grammar/eberban.peggy` | parser codegen; pure-PEG resource |
| `web/package.json` | peggy version drift detection |
| `dictionary/en.yaml` (~215 KB) | word lookup/search tools |
| `web/src/shared/particle-gloss.js` | particle_info tool (runs in isolate) |
| `web/src/semantics/{tree,ir,places,lower,print}.ts` | formula tool: lowering + printer (run in isolate) |
| `web/src/shared/{dict-lint,places}.js`, `web/src/visual-parser/compound-key.js` | their transitive imports |
| `web/src/semantics/README.md` | formula notation + coverage; served as a doc |
| `.ai/eberban-expert/SKILL.md` + `references/*.md` | skill resources |
| `books/refgram/src/**/*.md` + `SUMMARY.md` | refgram resources + ToC |

### Parser isolates

1. Fetch grammar at the resolved SHA.
2. `peggy.generate(grammar, { cache: true, format: "es", output: "source",
   allowedStartRules: ["*"] })` — the exact flags upstream's `build-peggy`
   script uses.
3. `env.LOADER.get("parser-" + sha + "-p" + peggyVersion + "-v" + WRAPPER_VERSION, ...)` with:
   - modules: generated parser + a small wrapper entrypoint,
   - `globalOutbound: null` (no network in the isolate — upstream grammar
     actions are executed but fully sandboxed),
   - `compatibilityDate` pinned.
4. Wrapper returns parse tree as JSON, or `{ error, location, expected }` on
   failure (grammar-authored error messages pass through).

Isolates are cached by ID; a new upstream commit yields a new SHA and a
one-time regeneration. Isolate calls carry a 10 s wall-clock timeout.
Measured: cold ≈ 250 ms, warm parse ≈ 30–70 ms.

### Semantics isolate

Upstream's `web/src/semantics/` turns a parse tree into its logical reading in
the reference grammar's notation. It is TypeScript (erasable syntax only), so:

1. Fetch the nine code files at the resolved SHA.
2. Host side, memoized per SHA: strip the five `.ts` files with sucrase
   (~50 ms for all five). Import specifiers keep their `.ts` extension, which
   to the loader is just part of a module name, so upstream's own relative
   imports resolve unchanged.
3. `env.LOADER.get("semantics-" + sha + "-p" + peggyVersion + "-v" + WRAPPER_VERSION, ...)`
   with the modules laid out at their upstream relative paths
   (`semantics/*.ts`, `shared/*.js`, `visual-parser/compound-key.js`), the
   same generated parser source the parse tool uses at
   `grammar/eberban.peggy.js`, and the parsed dictionary as a `json` module.
   Every source is passed in the explicit `{ js }` form: without it the loader
   infers the module type from the name and rejects the `.ts` names. The
   `json` module takes the already-parsed value, not JSON text. Again
   `globalOutbound: null` and the pinned compatibility date.
4. Wrapper takes `{ text, allDefaults }` and returns
   `{ ok, formula, unsupported }`, the parse-error shape above when the text
   does not parse, or `{ ok: false, lowerError }` when lowering or printing
   throws. That last case is a printer malfunction rather than invalid
   Eberban, and the tool says so in a warning.

One SHA keys the whole isolate, since every artifact resolves to one commit
per freshness window; when a component falls back to an older copy, its SHA is
folded into the isolate ID so two different contents can never share one.
Measured locally: cold ≈ 370 ms (fetch + strip + isolate build + golden gate),
warm ≈ 20 ms.

Tool `formula(text, ?all_defaults)` returns `{ formula, unsupported, sha,
stale, warnings }`. `unsupported` lists constructs the lowering refuses to
guess about; it never invents a reading for them.

### Dictionary

Host-side: fetch `en.yaml`, parse with bundled YAML lib, build an in-memory
index. Memoized in isolate global memory keyed by SHA; promoted to
last-known-good KV only after the YAML parses and yields a plausible entry
count, so broken upstream YAML falls back instead of poisoning. Tools:

- `lookup_word(word)` — exact match; returns the full entry.
- `search_words(query, ?limit, ?offset)` — ranked: exact word > whole-word
  gloss match > descriptions > substring anywhere; results annotate which
  field matched; paginated with a total count.

### Pure PEG

`peggy.parser.parse(grammar)` → AST → strip `action`/`initializer` code blocks
→ pretty-print rules as clean PEG. Tools/resources:

- resource `skill://eberban-expert/grammar.peg` — whole grammar, action-free,
  explicitly labeled a *structural sketch*: semantic predicates appear as
  `&{…}`/`!{…}` placeholders, and the header directs authoritative questions
  to the `parse` tool.
- tool `grammar_rule(?name)` — single rule + rules it directly references
  (one hop); with no argument, lists all rule names.

### Refgram and skill docs

Resources (all fetched live, SHA-cached):

- `skill://eberban-expert/SKILL.md` — upstream's own skill, served verbatim
  (named to match its frontmatter, per SEP-2640 conventions).
- `skill://eberban-expert/references/{name}.md` — the 9 reference files.
- `skill://eberban-expert/grammar.peg` — as above.
- `skill://eberban-expert/semantics.md` — upstream's semantics README: the
  formula notation table and the coverage list, for reading `formula` output.
- `skill://index.json` — discovery document (SEP-2640 draft layout; the SEP
  is in flux, so no conformance is claimed and no skills/* RPCs are exposed).
- `eberban://refgram/toc` — parsed `SUMMARY.md` as a path → title map.
- `eberban://refgram/{path}` — individual refgram sections; requested paths
  are validated against the SUMMARY.md ToC before any fetch.

Additionally, `search` and `fetch` facade tools implement the ChatGPT
deep-research connector contract over the dictionary and doc catalog.

Mirror tool `read_doc(uri)` returns any of the above as text, for hosts where
models reach tools more reliably than resources. `list_docs()` returns the
catalog.

### Server instructions

`McpServer` instructions field (surfaced at `initialize`) carries a ~12-line
routing table: which tool for which question, "read skill://eberban-expert/SKILL.md
for depth", parse-before-translating guidance. Tool descriptions stay short
and cross-reference the skill resource.

## Resilience

- **Upstream fetch failure** (GitHub down, file moved): serve last-known-good
  from KV. Validated artifacts (grammar, dictionary) are promoted to KV only
  *after* validation (codegen succeeds / YAML parses plausibly); plain
  documents are promoted on successful fetch. KV writes happen only when the
  content SHA changes. Tool responses carry `stale: true` + timestamp when
  serving fallback.
- **Semantics bundle failure**: KV key `gen:semantics` holds the stripped
  sources as `{ sha, modules, fetchedAt }`, promoted only
  after the golden sentence `a mian bjan` prints the exact formula from
  upstream's semantics README through the real isolate. A strip failure, an
  isolate load failure, or a golden mismatch falls back to that copy with a
  warning naming both SHAs.
- **Peggy codegen failure** (upstream grammar uses syntax our pinned peggy
  can't parse): fall back to last-good generated parser source from KV; report
  the codegen error and the drift warning in the tool response.
- **Version drift detection**: compare upstream `web/package.json` peggy
  major against the bundled version; on mismatch, append a warning to parse
  results.
- **Monitoring**: a cron trigger (every 6 h) runs golden checks (parse a
  known-good sentence, reject a known-bad one, dictionary lookup, particle
  gloss, formula, refgram ToC) and stores the outcome; `/health` reports upstream
  reachability + the last golden-check result and returns 503 on failure, so
  any external uptime monitor can watch it.
- **File moved upstream**: paths are constants in one config module; a 404 on
  a known path triggers the KV fallback and a `stale` marker, making breakage
  visible without taking the server down.

## Security / abuse

- Public, read-only, no auth (same posture as the eberban website itself).
- Parser isolates: `globalOutbound: null`, no bindings, 10 s timeout —
  upstream JS runs fully sandboxed.
- Input caps: parse text ≤ 8 KB; search query ≤ 200 chars; limits validated
  by zod schemas.
- Per-IP rate limiting (300 req/min) via the Workers rate-limit binding, plus
  Cloudflare's default DDoS protection.
- Host/Origin validation and CORS handled by `createMcpHandler` (public data,
  so browser origins are allowed).
- **Accepted risk — upstream trust**: repo content (docs, dictionary text,
  grammar-authored error messages) flows verbatim into model context, and
  upstream JS executes (sandboxed) per request. A compromised upstream repo
  is therefore a prompt-injection/code channel. This is inherent to the
  zero-touch freshness goal; the mitigation is the isolate sandbox plus the
  server instructions telling models to treat document text as data.

## Non-goals (initial release)

- No semantic/embedding search (lexical search only; can add Vectorize later).
- No worker-bundler / runtime npm installs — current upstream logic modules
  have zero npm deps; keep worker-bundler (pinned 0.2.2) in reserve.
- No SEP-2640 `skills/list`/`skills/get` RPC methods until the SEP stabilizes;
  the `skill://` resource layout is forward-compatible with it.
- No auth, no telemetry beyond Cloudflare's built-in analytics.

## Repo layout (`eberban-skill` repo)

```
DESIGN.md
wrangler.jsonc
package.json
src/
  index.ts        — worker entry: / (landing), /mcp, /health, cron checks
  mcp.ts          — server factory: tools/resources/instructions
  upstream.ts     — fetch layer: SHA resolution, Cache API, KV promotion
  parser.ts       — peggy codegen + Worker Loader isolates
  semantics.ts    — sucrase type-strip + lowering/printer isolate
  glosser.ts      — particle-gloss isolate
  purepeg.ts      — AST → action-free PEG printer
  dictionary.ts   — YAML parse + index + ranked search
  docs.ts         — skill/refgram resource catalog
```
