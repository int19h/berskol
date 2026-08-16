# berskol

An [MCP](https://modelcontextprotocol.io) server for the
[Eberban](https://github.com/eberban/eberban) constructed language, live at
**`https://berskol.app/mcp`** (Streamable HTTP, no auth).

Everything it serves — parser, dictionary, grammar, reference documentation —
is fetched from the eberban repository at request time, pinned to a single
upstream commit per request for coherence. Nothing is bundled, so nothing
ever needs rebuilding when the language evolves; the Eberban maintainers
don't need to do anything (and don't need to know this exists).

## What it serves

**Tools**

| Tool | Purpose |
|---|---|
| `parse` | Parse Eberban text with the official grammar (tree or check-only) |
| `lookup_word` | Exact dictionary lookup |
| `search_words` | Ranked dictionary search with pagination |
| `particle_info` | Decode generated particle forms (SI/VI/FI/VEI/TI families) |
| `grammar_rule` | One grammar rule as structural PEG (+ list all rules) |
| `list_docs` / `read_doc` | Document catalog + reads (mirror of resources) |
| `search` / `fetch` | ChatGPT deep-research connector compatibility facade |

**Resources** — upstream's own `eberban-expert` skill (SKILL.md + references)
under the SEP-2640 `skill://` layout, the full grammar as action-free PEG,
and the reference grammar book section by section (`eberban://refgram/...`).

## How it works

- Cloudflare Worker; `master` resolved to a commit SHA every 5 minutes via
  the commits atom feed; all files fetched at that immutable SHA.
- The `.peggy` grammar is compiled to parser source **on the host with
  `output: "source"`** (no eval), then executed in a network-less
  [dynamic worker isolate](https://developers.cloudflare.com/dynamic-workers/)
  keyed on the commit SHA — one-time codegen per upstream commit, warm parses
  in tens of milliseconds.
- Last-known-good copies of validated artifacts are kept in KV; upstream
  outages degrade to stale-but-working responses flagged `stale: true`.
- A cron trigger runs golden checks every 6 h; `/health` reports upstream
  reachability and the last check (503 on failure — point an uptime monitor
  at it).

See [DESIGN.md](DESIGN.md) for the full architecture and threat model.

## Development

```sh
npm install
npm run dev        # wrangler dev on localhost:8787
npm run check      # tsc --noEmit
npm run deploy     # wrangler deploy
```

Requires a Cloudflare paid Workers plan (Worker Loaders) and the KV namespace
+ rate-limit binding declared in `wrangler.jsonc`.
