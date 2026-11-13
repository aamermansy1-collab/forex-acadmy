// GET /api/config — حدود خدمة الدمج + الإصدار.

import { mergeConfig } from "@/lib/merger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const cfg = mergeConfig();
  return Response.json({
    version: cfg.version,
    maxSources: cfg.maxSources,
    sourceMaxMb: cfg.sourceMaxMb,
    outputMaxMb: cfg.outputMaxMb,
    maxTotalDurationSec: cfg.maxTotalDurationSec,
    preset: cfg.preset,
    uploadChunkBytes: 4 * 1024 * 1024,
    retentionHours: 24,
  });
}
