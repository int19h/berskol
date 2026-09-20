// Dictionary: en.yaml fetched live, parsed host-side, indexed in isolate
// memory keyed by content version. Promoted to last-known-good only after
// it parses and looks sane; on parse failure the last good copy is used.

import { parse as parseYaml } from "yaml";
import {
  fetchUpstream,
  promote,
  VersionMemo,
  type Env,
  type Upstream,
} from "./upstream";

export const DICTIONARY_PATH = "dictionary/en.yaml";
const MIN_PLAUSIBLE_ENTRIES = 100;

export type Entry = Record<string, unknown>;

interface IndexedWord {
  word: string;
  entry: Entry;
  // Lowercased text per field group, for ranked search.
  gloss: string;
  short: string;
  rest: string;
}

export interface Index {
  entries: Map<string, Entry>;
  words: IndexedWord[];
  /**
   * The parsed YAML exactly as upstream's own loadDictionary() returns it.
   * Kept alongside the index so the semantics lowering, which wants that raw
   * map, does not have to parse the 215 KB of YAML a second time.
   */
  raw: Record<string, Entry>;
}

const indexMemo = new VersionMemo<Index>();

export async function getDictionary(
  env: Env,
  ctx: ExecutionContext,
): Promise<{ index: Index; meta: Upstream }> {
  const meta = await fetchUpstream(env, ctx, DICTIONARY_PATH, { promote: false });
  try {
    const index = indexMemo.get(meta.sha, () => buildIndex(meta.text));
    promote(env, ctx, DICTIONARY_PATH, meta); // validated: parsed & plausible
    return { index, meta };
  } catch (e) {
    // Broken YAML upstream: retry from last-known-good if that's not what we
    // just tried.
    const kv = await env.CACHE.get(`up:${DICTIONARY_PATH}`);
    let d: { text: string; sha: string; fetchedAt: string } | null = null;
    try {
      d = kv ? JSON.parse(kv) : null;
    } catch {
      d = null;
    }
    if (d) {
      if (d.sha !== meta.sha) {
        const index = indexMemo.get(d.sha, () => buildIndex(d.text));
        return {
          index,
          meta: { text: d.text, sha: d.sha, stale: true, fetchedAt: d.fetchedAt },
        };
      }
    }
    throw e;
  }
}

function buildIndex(yamlText: string): Index {
  const doc = parseYaml(yamlText, { maxAliasCount: 100 }) as
    | Record<string, Entry>
    | null;
  const entries = new Map<string, Entry>();
  const words: IndexedWord[] = [];
  const raw: Record<string, Entry> =
    doc && typeof doc === "object" ? doc : {};
  if (doc && typeof doc === "object") {
    for (const [key, value] of Object.entries(doc)) {
      if (!value || typeof value !== "object") continue;
      const word = String(key);
      const entry = value as Entry;
      entries.set(word, entry);
      words.push({
        word,
        entry,
        gloss: str(entry.gloss).toLowerCase(),
        short: str(entry.short).toLowerCase(),
        rest: collectStrings(entry).join(" ").toLowerCase(),
      });
    }
  }
  if (entries.size < MIN_PLAUSIBLE_ENTRIES) {
    throw new Error(
      `dictionary parse produced only ${entries.size} entries; ` +
        `refusing to serve (upstream format change?)`,
    );
  }
  return { entries, words, raw };
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function collectStrings(value: unknown, depth = 0): string[] {
  if (depth > 4) return [];
  if (typeof value === "string") return [value];
  if (typeof value === "number") return [String(value)];
  if (Array.isArray(value))
    return value.flatMap((v) => collectStrings(v, depth + 1));
  if (value && typeof value === "object")
    return Object.values(value).flatMap((v) => collectStrings(v, depth + 1));
  return [];
}

export function lookupWord(index: Index, word: string): Entry | null {
  return index.entries.get(word) ?? index.entries.get(word.toLowerCase()) ?? null;
}

export interface SearchResult {
  word: string;
  matched: string;
  entry: Entry;
}

/**
 * Ranked search: exact word > whole-word in gloss > whole-word in short
 * description > substring anywhere. Stable within ranks (dictionary order).
 */
export function searchWords(
  index: Index,
  query: string,
  limit: number,
  offset: number,
): { results: SearchResult[]; total: number } {
  const q = query.toLowerCase().trim();
  // Dictionary glosses use inflected English ("likes", "eating"), so accept
  // common suffixes on whole-word matches: "like" matches "likes"/"liked".
  const wordRe = new RegExp(
    `(^|[^a-z0-9])${escapeRe(q)}(s|es|d|ed|ing)?($|[^a-z0-9])`,
  );
  const ranked: [number, SearchResult][] = [];
  for (const w of index.words) {
    let rank: number | undefined;
    let matched: string | undefined;
    if (w.word.toLowerCase() === q) {
      rank = 0;
      matched = "word";
    } else if (wordRe.test(w.gloss)) {
      rank = 1;
      matched = "gloss";
    } else if (wordRe.test(w.short)) {
      rank = 2;
      matched = "short";
    } else if (w.rest.includes(q)) {
      rank = 3;
      matched = "other";
    }
    if (rank !== undefined)
      ranked.push([rank, { word: w.word, matched: matched!, entry: w.entry }]);
  }
  ranked.sort((a, b) => a[0] - b[0]); // stable in modern JS
  return {
    results: ranked.slice(offset, offset + limit).map(([, r]) => r),
    total: ranked.length,
  };
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
