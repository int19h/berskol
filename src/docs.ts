// Document catalog: upstream's AI notes (`.ai/notes/`), the reference grammar
// (refgram) book, and two documents berskol derives or relays for its own
// tools: the structural PEG and the semantics README.
//
// The note list is derived from the notes README itself (which links every
// note), with a pinned list as fallback, so upstream can add or remove notes
// without any change here.
//
// Note and refgram paths are validated against those indexes before any fetch,
// so model-supplied URIs can only reach files the indexes link.

import { fetchUpstream, VersionMemo, type Env } from "./upstream";
import { GRAMMAR_PATH, getParseableGrammar } from "./parser";
import { SEMANTICS_README_PATH } from "./semantics";
import { pureGrammar } from "./purepeg";

const NOTES_DIR = ".ai/notes/";
export const NOTES_FALLBACK = [
  "01-grammar-overview",
  "02-semantics",
  "03-context",
  "04-time-layer",
  "05-layering-and-modules",
  "06-provers",
  "07-tooling-plan",
  "08-course",
  "09-vocabulary-design",
  "open-questions",
];

const REFGRAM_DIR = "books/refgram/src/";
const REPO_BLOB = "https://github.com/eberban/eberban/blob/master/";
const REFGRAM_SITE = "https://eberban.github.io/eberban/books/refgram/book/";

export const URI_NOTES_INDEX = "eberban://notes/README.md";
export const URI_GRAMMAR_PEG = "eberban://grammar.peg";
export const URI_SEMANTICS = "eberban://semantics.md";
export const URI_REFGRAM_TOC = "eberban://refgram/toc";

// URIs from the retired `skill://eberban-expert/` layout whose content still
// exists. Readable, never listed, so old links and cached instructions work.
const LEGACY_URIS: Record<string, string> = {
  "skill://eberban-expert/grammar.peg": URI_GRAMMAR_PEG,
  "skill://eberban-expert/semantics.md": URI_SEMANTICS,
};

const NOTE_URI = /^eberban:\/\/notes\/([a-z0-9-]+)\.md$/;

/** Canonical human-facing URL for a doc URI (for citations). */
export function docUrl(uri: string): string {
  uri = LEGACY_URIS[uri] ?? uri;
  if (uri === URI_NOTES_INDEX) return `${REPO_BLOB}${NOTES_DIR}README.md`;
  const note = uri.match(NOTE_URI);
  if (note) return `${REPO_BLOB}${NOTES_DIR}${note[1]}.md`;
  if (uri === URI_GRAMMAR_PEG) return `${REPO_BLOB}${GRAMMAR_PATH}`;
  if (uri === URI_SEMANTICS) return `${REPO_BLOB}${SEMANTICS_README_PATH}`;
  if (uri === URI_REFGRAM_TOC) return REFGRAM_SITE;
  const refgram = uri.match(/^eberban:\/\/refgram\/(.+)\.md$/);
  if (refgram) return `${REFGRAM_SITE}${refgram[1]}.html`;
  return "https://berskol.app/";
}

export interface DocContent {
  text: string;
  stale: boolean;
  fetchedAt: string;
}

/** Resolve a berskol doc URI to upstream content. Returns null if unknown. */
export async function readDoc(
  env: Env,
  ctx: ExecutionContext,
  uri: string,
): Promise<DocContent | null> {
  uri = LEGACY_URIS[uri] ?? uri;

  if (uri === URI_NOTES_INDEX)
    return fetchDoc(env, ctx, `${NOTES_DIR}README.md`);

  if (uri === URI_SEMANTICS) return fetchDoc(env, ctx, SEMANTICS_README_PATH);

  const note = uri.match(NOTE_URI);
  if (note && (await noteNames(env, ctx)).includes(note[1]))
    return fetchDoc(env, ctx, `${NOTES_DIR}${note[1]}.md`);

  if (uri === URI_GRAMMAR_PEG) {
    const grammar = await getParseableGrammar(env, ctx);
    const { text } = pureGrammar(grammar.sha, grammar.text);
    return {
      text:
        `# Eberban grammar — structural PEG sketch\n` +
        `# Derived from ${GRAMMAR_PATH} @ ${grammar.sha.slice(0, 10)}.\n` +
        `# JS actions are removed and semantic predicates appear as &{…} / !{…}\n` +
        `# placeholders, so this shows rule structure but is NOT the executable\n` +
        `# grammar; acceptance can differ where predicates apply. Use the parse\n` +
        `# tool for authoritative results.\n\n${text}`,
      stale: grammar.stale,
      fetchedAt: grammar.fetchedAt,
    };
  }

  if (uri === URI_REFGRAM_TOC) {
    const toc = await refgramToc(env, ctx);
    return {
      text: toc.entries
        .map(
          (e) =>
            `${"  ".repeat(e.depth)}- ${e.title}` +
            (e.path ? `: eberban://refgram/${e.path}` : ""),
        )
        .join("\n"),
      stale: toc.stale,
      fetchedAt: toc.fetchedAt,
    };
  }

  const refgram = uri.match(/^eberban:\/\/refgram\/(.+)$/);
  if (refgram) {
    const toc = await refgramToc(env, ctx);
    if (toc.entries.some((e) => e.path === refgram[1]))
      return fetchDoc(env, ctx, REFGRAM_DIR + refgram[1]);
  }

  return null;
}

async function fetchDoc(
  env: Env,
  ctx: ExecutionContext,
  path: string,
): Promise<DocContent> {
  const r = await fetchUpstream(env, ctx, path);
  return { text: r.text, stale: r.stale, fetchedAt: r.fetchedAt };
}

/** Note names parsed from the notes README's links; pinned list as fallback. */
const notesMemo = new VersionMemo<string[]>();

export async function noteNames(
  env: Env,
  ctx: ExecutionContext,
): Promise<string[]> {
  try {
    const index = await fetchUpstream(env, ctx, `${NOTES_DIR}README.md`);
    return notesMemo.get(index.sha, () => {
      const found = [
        ...new Set(
          [...index.text.matchAll(/\]\(([a-z0-9-]+)\.md\)/g)].map((m) => m[1]),
        ),
      ];
      return found.length > 0 ? found.sort() : NOTES_FALLBACK;
    });
  } catch {
    return NOTES_FALLBACK;
  }
}

export interface TocEntry {
  title: string;
  /** Null for a heading without a page of its own, such as "Morphonology". */
  path: string | null;
  depth: number;
}

const tocMemo = new VersionMemo<TocEntry[]>();

export async function refgramToc(
  env: Env,
  ctx: ExecutionContext,
): Promise<{ entries: TocEntry[]; stale: boolean; fetchedAt: string }> {
  const summary = await fetchUpstream(env, ctx, `${REFGRAM_DIR}SUMMARY.md`);
  const entries = tocMemo.get(summary.sha, () => {
    const out: TocEntry[] = [];
    // Chapters inside HTML comments are unpublished drafts: the book does
    // not render them, so they are not served either.
    const published = summary.text.replace(/<!--[\s\S]*?(-->|$)/g, "");
    // Headings without a page are kept, so the chapters under them keep
    // their place in the hierarchy.
    for (const line of published.split("\n")) {
      const m = line.match(/^(\s*)- \[([^\]]+)\]\(([^)]*)\)/);
      if (!m) continue;
      const path = m[3].trim();
      if (path === "")
        out.push({ depth: Math.floor(m[1].length / 2), title: m[2], path: null });
      else if (path.endsWith(".md") && !path.includes(".."))
        out.push({ depth: Math.floor(m[1].length / 2), title: m[2], path });
    }
    return out;
  });
  return { entries, stale: summary.stale, fetchedAt: summary.fetchedAt };
}

/** All doc URIs this server exposes, for list_docs and resource listing. */
export async function docCatalog(
  env: Env,
  ctx: ExecutionContext,
): Promise<{ uri: string; title: string }[]> {
  const items: { uri: string; title: string }[] = [
    { uri: URI_NOTES_INDEX, title: "AI notes: index and working rules" },
    ...(await noteNames(env, ctx)).map((name) => ({
      uri: `eberban://notes/${name}.md`,
      title: `AI notes: ${name.replace(/^\d+-/, "").replace(/-/g, " ")}`,
    })),
    { uri: URI_GRAMMAR_PEG, title: "Full grammar as pure PEG (structural sketch, no code)" },
    {
      uri: URI_SEMANTICS,
      title: "Semantics: formula notation and coverage (for the formula tool)",
    },
    { uri: URI_REFGRAM_TOC, title: "Reference grammar: table of contents" },
  ];
  try {
    const toc = await refgramToc(env, ctx);
    for (const e of toc.entries) {
      if (!e.path) continue;
      items.push({
        uri: `eberban://refgram/${e.path}`,
        title: `Refgram: ${e.title}`,
      });
    }
  } catch {
    // refgram ToC unavailable and no KV fallback yet — serve the rest
  }
  return items;
}
