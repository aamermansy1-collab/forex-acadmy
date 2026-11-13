// GET /api/cron — تنظيف يومي للمهام المنتهية (>24 ساعة).
// يُجدوَل في vercel.json على مدى يومي.

import { db } from "@/lib/turso";
import { deleteMergeJob } from "@/lib/merger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  try {
    const now = new Date().toISOString();
    const r = await db.execute({
      sql: "SELECT id FROM merge_jobs WHERE expires_at < ?",
      args: [now],
    });
    let deleted = 0;
    for (const row of r.rows) {
      const id = String((row as Record<string, unknown>).id);
      await deleteMergeJob(id);
      deleted++;
    }
    return Response.json({ cleaned: deleted, at: now });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
}
