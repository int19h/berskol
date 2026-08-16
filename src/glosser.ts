// Particle gloss engine: upstream's particle-gloss.js executed verbatim in a
// sandboxed isolate (it is upstream code we must not eval on the host).

import { fetchUpstream, ISOLATE_COMPAT_DATE, type Env } from "./upstream";
import { isolateCall } from "./parser";

const GLOSS_PATH = "web/src/shared/particle-gloss.js";
const WRAPPER_VERSION = 3;

const WRAPPER = `
import { generateParticleInfo } from "./particle-gloss.js";
export default {
  async fetch(req) {
    const { word } = await req.json();
    try {
      return Response.json({ ok: true, info: generateParticleInfo(word) ?? null });
    } catch (e) {
      return Response.json({ ok: false, error: String((e && e.message) ?? e) });
    }
  },
};
`;

export interface GlossOutcome {
  ok: boolean;
  info?: unknown;
  error?: string;
  stale: boolean;
}

export async function particleInfo(
  env: Env,
  ctx: ExecutionContext,
  word: string,
): Promise<GlossOutcome> {
  const src = await fetchUpstream(env, ctx, GLOSS_PATH);
  const worker = env.LOADER.get(
    `gloss-${src.sha}-v${WRAPPER_VERSION}`,
    () => ({
      mainModule: "main.js",
      modules: { "main.js": WRAPPER, "particle-gloss.js": src.text },
      compatibilityDate: ISOLATE_COMPAT_DATE,
      globalOutbound: null,
    }),
  );
  const result = (await isolateCall(worker, { word })) as Omit<
    GlossOutcome,
    "stale"
  >;
  return { ...result, stale: src.stale };
}
