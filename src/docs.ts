// Document catalog: upstream's own skill files served verbatim under the
// SEP-2640 `skill://` convention (named `eberban-expert`, matching upstream's
// SKILL.md frontmatter), plus the reference grammar (refgram) book.
//
// The skill reference list is derived from SKILL.md itself (which links every
// reference file), with a pinned list as fallback — so upstream can add or
// remove reference documents without any change here.
//
// Refgram paths are validated against the book's own SUMMARY.md ToC before
// any fetch, so model-supplied URIs can only reach files the book links.

import { fetchUpstream, VersionMemo, type Env } from "./upstream";
import { GRAMMAR_PATH, getParseableGrammar } from "./parser";
import { pureGrammar } from "./purepeg";

export const SKILL_NAME = "eberban-expert";
const SKILL_DIR = ".ai/eberban-expert/";
export const SKILL_REFERENCES = [
  "eberbanization",
  "grammar-deep-dive",
  "numbers-quotes-vocab",
  "open-design-problems",
  "particle-families",
  "vocabulary-gaps",
  "word-form-design",
  "worked-examples",
  "writing-and-tooling",
];

const REFGRAM_DIR = "books/refgram/src/";
const REPO_BLOB = "https://github.com/eberban/eberban/blob/master/";
const REFGRAM_SITE = "https://eberban.github.io/eberban/books/refgram/book/";

/** Canonical human-facing URL for a doc URI (for citations). */
export function docUrl(uri: string): string {
  if (uri === URI_SKILL) return `${REPO_BLOB}${SKILL_DIR}SKILL.md`;
  const ref = uri.match(/^skill:\/\/[a-z-]+\/references\/([a-z0-9-]+\.md)$/);
  if (ref) return `${REPO_BLOB}${SKILL_DIR}references/${ref[1]}`;
  if (uri === URI_GRAMMAR_PEG) return `${REPO_BLOB}web/src/grammar/eberban.peggy`;
  const refgram = uri.match(/^eberban:\/\/refgram\/(.+)\.md$/);
  if (refgram) return `${REFGRAM_SITE}${refgram[1]}.html`;
  return "https://berskol.app/";
}

export const URI_SKILL = `skill://${SKILL_NAME}/SKILL.md`;
export const URI_GRAMMAR_PEG = `skill://${SKILL_NAME}/grammar.peg`;
export const URI_SKILL_INDEX = "skill://index.json";
export const URI_REFGRAM_TOC = "eberban://refgram/toc";

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
  if (uri === URI_SKILL) return fetchDoc(env, ctx, `${SKILL_DIR}SKILL.md`);

  const ref = uri.match(
    new RegExp(`^skill://${SKILL_NAME}/references/([a-z0-9-]+)\\.md$`),
  );
  if (ref && (await skillReferences(env, ctx)).includes(ref[1]))
    return fetchDoc(env, ctx, `${SKILL_DIR}references/${ref[1]}.md`);

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

  if (uri === URI_SKILL_INDEX) {
    return {
      text: JSON.stringify(skillIndex(), null, 2),
      stale: false,
      fetchedAt: new Date().toISOString(),
    };
  }

  if (uri === URI_REFGRAM_TOC) {
    const toc = await refgramToc(env, ctx);
    return {
      text: toc.entries
        .map(
          (e) =>
            `${"  ".repeat(e.depth)}- ${e.title}: eberban://refgram/${e.path}`,
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

/** Reference names parsed from SKILL.md's own links; pinned list as fallback. */
const refsMemo = new VersionMemo<string[]>();

export async function skillReferences(
  env: Env,
  ctx: ExecutionContext,
): Promise<string[]> {
  try {
    const skill = await fetchUpstream(env, ctx, `${SKILL_DIR}SKILL.md`);
    return refsMemo.get(skill.sha, () => {
      const found = [
        ...new Set(
          [...skill.text.matchAll(/references\/([a-z0-9-]+)\.md/g)].map(
            (m) => m[1],
          ),
        ),
      ];
      return found.length > 0 ? found.sort() : SKILL_REFERENCES;
    });
  } catch {
    return SKILL_REFERENCES;
  }
}

export interface TocEntry {
  title: string;
  path: string;
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
    for (const line of summary.text.split("\n")) {
      const m = line.match(/^(\s*)- \[([^\]]+)\]\(([^)]+\.md)\)/);
      if (m && !m[3].includes(".."))
        out.push({
          depth: Math.floor(m[1].length / 2),
          title: m[2],
          path: m[3],
        });
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
    { uri: URI_SKILL, title: "Eberban expert skill (main instructions)" },
    ...(await skillReferences(env, ctx)).map((name) => ({
      uri: `skill://${SKILL_NAME}/references/${name}.md`,
      title: `Skill reference: ${name.replace(/-/g, " ")}`,
    })),
    { uri: URI_GRAMMAR_PEG, title: "Full grammar as pure PEG (structural sketch, no code)" },
    { uri: URI_SKILL_INDEX, title: "Skill discovery index (SEP-2640 draft)" },
    { uri: URI_REFGRAM_TOC, title: "Reference grammar: table of contents" },
  ];
  try {
    const toc = await refgramToc(env, ctx);
    for (const e of toc.entries) {
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

function skillIndex(): unknown {
  return {
    skills: [
      {
        name: SKILL_NAME,
        description:
          "Expert knowledge of the Eberban constructed language: grammar, " +
          "vocabulary, translation, and design principles.",
        skillPath: URI_SKILL,
        resources: [
          URI_SKILL,
          ...SKILL_REFERENCES.map(
            (n) => `skill://${SKILL_NAME}/references/${n}.md`,
          ),
          URI_GRAMMAR_PEG,
        ],
      },
    ],
  };
}
