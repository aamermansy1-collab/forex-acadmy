// GET /api/health — حالة السيرفر: قاعدة Turso + نقطة MCP + الموديلات + خدمة الدمج + الحماية.

import { dbHealthy } from "@/lib/turso";
import { MODELS } from "@/lib/models";
import { mergeConfig } from "@/lib/merger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const dbOk = await dbHealthy();
  const mergerBase = process.env.MERGER_API_BASE || "";
  // خدمة الدمج مدمجة: نفحص config المحلي.
  let mergerHealthy = true;
  try {
    const cfg = mergeConfig();
    void cfg;
  } catch {
    mergerHealthy = false;
  }
  const authRequired = !!process.env.MCP_ACCESS_TOKEN;

  return Response.json({
    ok: true,
    database: dbOk ? "turso-connected" : "turso-disconnected",
    mcpEndpoint: "/mcp",
    models: MODELS.map((m) => ({
      canonical: m.canonical,
      type: m.type,
      providers: m.providers,
    })),
    merger: {
      base: mergerBase || "(integrated)",
      healthy: mergerHealthy,
    },
    authRequired,
  });
}
