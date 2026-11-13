// GET /api/tasks — قائمة أحدث المهام + إحصائيات (للواجهة).

import { listRecentTasks, taskStats } from "@/lib/turso";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const limit = Math.min(50, Number(url.searchParams.get("limit") || 20));
  const type = url.searchParams.get("type") || undefined;
  const status = url.searchParams.get("status") || undefined;
  const [rows, stats] = await Promise.all([
    listRecentTasks(limit, { type: type || undefined, status: status || undefined }),
    taskStats(),
  ]);
  const out = rows.map((t) => ({
    id: t.id,
    type: t.type,
    status: t.status,
    progress: t.progress,
    model: t.model,
    provider: t.provider,
    prompt: (t.prompt || "").slice(0, 120),
    result_urls: t.result_urls_json ? JSON.parse(t.result_urls_json) : [],
    error_message: t.error_message,
    attempts: JSON.parse(t.attempts_json || "[]"),
    created_at: t.created_at,
    updated_at: t.updated_at,
    completed_at: t.completed_at,
  }));
  return Response.json({ tasks: out, stats });
}
