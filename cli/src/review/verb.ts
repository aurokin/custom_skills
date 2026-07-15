// `skm review` (ADR 0013) — read-only reporting verb. Phase 1: --json emits
// the review model; the HTML renderer lands in phase 2.

import { loadContext } from "../context";
import type { SkmEnv } from "../env";
import type { VerbOptions, VerbOutcome } from "../types";
import { buildReviewModel } from "./model";

export async function runReview(env: SkmEnv, opts: VerbOptions): Promise<VerbOutcome> {
  const ctx = loadContext(env);
  const model = buildReviewModel(env, ctx);
  if (!opts.json) {
    return {
      exitCode: 1,
      json: { error: "html renderer not yet implemented; run with --json" },
      human: "skm review: the HTML renderer lands in phase 2 (ADR 0013); run with --json for the review model.",
    };
  }
  return {
    exitCode: 0,
    json: model,
    human: JSON.stringify(model, null, 2),
  };
}
