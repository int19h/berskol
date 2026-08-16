// Fetch layer: everything comes from the eberban repo at runtime.
//
// Design (post-review):
// - `master` is resolved to a commit SHA once per freshness window via the
//   commits atom feed (github.com, not the rate-limited api.github.com), and
//   every artifact is fetched at that immutable SHA. All artifacts served for
//   one request are therefore mutually coherent, and immutable URLs cache
//   indefinitely without 404/500 poisoning.
// - Caching uses the Cache API explicitly so only 200 responses are stored.
// - Last-known-good copies live in KV. Artifacts that can be validated
//   (grammar, dictionary) are promoted by their owners *after* validation via
//   `promote()`; plain documents are promoted on successful fetch.

export interface Env {
  LOADER: {
    get(
      id: string,
      loader?: () => Promise<WorkerCode> | WorkerCode,
    ): DynamicWorker;
  };
  CACHE: KVNamespace;
  RL?: { limit(opts: { key: string }): Promise<{ success: boolean }> };
}

export interface WorkerCode {
  mainModule: string;
  modules: Record<string, string>;
  compatibilityDate: string;
  globalOutbound?: null;
}

export interface DynamicWorker {
  getEntrypoint(): { fetch(url: string, init?: RequestInit): Promise<Response> };
}

export interface Upstream {
  text: string;
  /** Commit SHA this content was fetched at (or last seen at, if stale). */
  sha: string;
  stale: boolean;
  fetchedAt: string;
}

const REPO = "eberban/eberban";
const ATOM_URL = `https://github.com/${REPO}/commits/master.atom`;
const SHA_TTL_SECONDS = 300; // freshness window for master -> SHA resolution
const FILE_TTL_SECONDS = 7 * 86400; // immutable SHA-addressed content
const FETCH_TIMEOUT_MS = 15_000;
const MAX_FILE_BYTES = 5 * 1024 * 1024; // upstream files are ≤ ~250 KB today
const USER_AGENT = "berskol-mcp (https://berskol.app)";

// Synthetic cache-key host — never actually fetched.
const CACHE_HOST = "https://berskol-cache.invalid/";

// Compatibility date for dynamic-worker isolates. Kept near the fetch layer
// so there is one definition; update alongside wrangler.jsonc's
// compatibility_date to keep host and isolate semantics aligned.
export const ISOLATE_COMPAT_DATE = "2026-08-01";

async function cachedFetch(
  ctx: ExecutionContext,
  cacheKey: string,
  url: string,
  ttlSeconds: number,
): Promise<string | null> {
  const cache = caches.default;
  const key = new Request(CACHE_HOST + cacheKey);
  const hit = await cache.match(key);
  if (hit) return hit.text();
  const r = await fetch(url, {
    headers: { "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!r.ok) return null;
  const text = await readCapped(r, MAX_FILE_BYTES);
  if (text === null) return null; // oversized — treat like a fetch failure
  ctx.waitUntil(
    cache
      .put(
        key,
        new Response(text, {
          headers: { "Cache-Control": `s-maxage=${ttlSeconds}` },
        }),
      )
      .catch(() => {}),
  );
  return text;
}

// In-isolate SHA memo + in-flight dedup: keeps one request (and concurrent
// requests in one isolate) on a single SHA, and prevents a cold colo from
// issuing redundant atom fetches that race the async cache.put. A request
// spanning the TTL boundary can still observe a SHA change — accepted.
let shaMemo: { sha: string; stale: boolean; expires: number } | null = null;
let shaInflight: Promise<{ sha: string; stale: boolean }> | null = null;

/** Read a response body up to `cap` bytes; null if it exceeds the cap. */
async function readCapped(r: Response, cap: number): Promise<string | null> {
  const reader = r.body?.getReader();
  if (!reader) {
    const text = await r.text();
    return text.length > cap ? null : text;
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > cap) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const buf = new Uint8Array(size);
  let off = 0;
  for (const c of chunks) {
    buf.set(c, off);
    off += c.byteLength;
  }
  return new TextDecoder().decode(buf);
}

/** Resolve master to a commit SHA; falls back to the last known SHA in KV. */
export async function resolveSha(
  env: Env,
  ctx: ExecutionContext,
): Promise<{ sha: string; stale: boolean }> {
  if (shaMemo && Date.now() < shaMemo.expires && !shaMemo.stale)
    return { sha: shaMemo.sha, stale: false };
  if (shaInflight) return shaInflight;
  shaInflight = resolveShaUncached(env, ctx).finally(() => {
    shaInflight = null;
  });
  return shaInflight;
}

async function resolveShaUncached(
  env: Env,
  ctx: ExecutionContext,
): Promise<{ sha: string; stale: boolean }> {
  try {
    const atom = await cachedFetch(ctx, "meta/sha-atom", ATOM_URL, SHA_TTL_SECONDS);
    if (atom) {
      const sha =
        atom.match(/Grit::Commit\/([0-9a-f]{40})/)?.[1] ??
        atom.match(/\/commit\/([0-9a-f]{40})/)?.[1];
      if (sha) {
        ctx.waitUntil(
          env.CACHE.get("meta:sha").then((prev) => {
            if (prev !== sha) return env.CACHE.put("meta:sha", sha);
          }).catch(() => {}),
        );
        shaMemo = { sha, stale: false, expires: Date.now() + SHA_TTL_SECONDS * 1000 };
        return { sha, stale: false };
      }
    }
  } catch {
    // fall through to KV
  }
  const last = await env.CACHE.get("meta:sha");
  if (last) return { sha: last, stale: true };
  throw new Error("cannot resolve upstream commit (GitHub unreachable, no cached SHA)");
}

export async function fetchUpstream(
  env: Env,
  ctx: ExecutionContext,
  path: string,
  opts: { promote?: boolean } = {},
): Promise<Upstream> {
  const promoteOnFetch = opts.promote ?? true;
  let resolveError: unknown;
  try {
    const { sha, stale: shaStale } = await resolveSha(env, ctx);
    const text = await cachedFetch(
      ctx,
      `file/${sha}/${path}`,
      `https://raw.githubusercontent.com/${REPO}/${sha}/${path}`,
      FILE_TTL_SECONDS,
    );
    if (text !== null) {
      const fetchedAt = new Date().toISOString();
      const result = { text, sha, stale: shaStale, fetchedAt };
      if (promoteOnFetch) promote(env, ctx, path, result);
      return result;
    }
    resolveError = new Error(`upstream ${path}: not found at ${sha.slice(0, 10)}`);
  } catch (e) {
    resolveError = e;
  }

  // Last-known-good fallback.
  const kv = await env.CACHE.get(`up:${path}`);
  if (kv) {
    try {
      const d = JSON.parse(kv) as { text: string; sha: string; fetchedAt: string };
      return { text: d.text, sha: d.sha, stale: true, fetchedAt: d.fetchedAt };
    } catch {
      // corrupt KV entry — fall through to the fetch error
    }
  }
  throw resolveError instanceof Error
    ? resolveError
    : new Error(`upstream ${path}: ${String(resolveError)}`);
}

// Per-isolate memo of the last promoted SHA per path: KV writes happen only
// when content version changes (also respects KV's 1 write/sec/key limit).
const lastPromoted = new Map<string, string>();

/**
 * Record content as last-known-good. Called automatically on fetch for plain
 * documents; called explicitly *after validation* by owners of parseable
 * artifacts (grammar, dictionary), which fetch with `promote: false`.
 */
export function promote(
  env: Env,
  ctx: ExecutionContext,
  path: string,
  content: Upstream,
): void {
  if (content.stale || lastPromoted.get(path) === content.sha) return;
  lastPromoted.set(path, content.sha);
  ctx.waitUntil(
    (async () => {
      // Re-check KV: after a cold start the in-memory memo is empty, and the
      // stored copy is usually already current (also avoids piling writes
      // onto KV's 1 write/sec/key limit during cold-start bursts).
      const prev = await env.CACHE.get(`up:${path}`);
      if (prev) {
        try {
          const p = JSON.parse(prev) as { sha: string; fetchedAt?: string };
          if (p.sha === content.sha) return;
          // Ordering guard: never overwrite a more recently fetched entry
          // (two concurrent promotions at different SHAs can interleave).
          if (p.fetchedAt && p.fetchedAt > content.fetchedAt) return;
        } catch {
          // corrupt — overwrite below
        }
      }
      await env.CACHE.put(
        `up:${path}`,
        JSON.stringify({
          text: content.text,
          sha: content.sha,
          fetchedAt: content.fetchedAt,
        }),
      );
    })().catch(() => {
      // Write failed (e.g. KV per-key rate limit): forget the memo so a
      // later request retries instead of silently never promoting.
      lastPromoted.delete(path);
    }),
  );
}

/** Single-slot memo keyed on the content version (SHA). */
export class VersionMemo<T> {
  private version: string | undefined;
  private value: T | undefined;

  get(version: string, compute: () => T): T {
    if (this.version !== version || this.value === undefined) {
      this.value = compute();
      this.version = version;
    }
    return this.value;
  }
}
