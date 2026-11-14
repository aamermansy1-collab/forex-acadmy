// GET /api/tasks/[id] — حالة مهمة واحدة (للاستطلاع من الواجهة).
// يستدعي refreshTask لتحديث المهمة الجارية من المزود/الخدمة.

import { refreshTask } from "@/lib/coordinator";
import { getTask } from "@/lib/turso";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const { id } = await params;
  const existing = await getTask(id);
  if (!existing) {
    return Response.json({ error: "المهمة غير موجودة" }, { status: 404 });
  }
  // حدّث من المزود/الخدمة إن كانت جارية.
  const r = await refreshTask(id);
  // اقرأ الحالة النهائية من القاعدة بعد التحديث.
  const updated = await getTask(id);
  const urls = updated?.result_urls_json ? JSON.parse(updated.result_urls_json) : [];
  return Response.json({
    id,
    type: updated?.type || existing.type,
    status: updated?.status || existing.status,
    progress: updated?.progress ?? existing.progress,
    urls,
    error_message: updated?.error_message ?? existing.error_message,
    message: r.arabicMessage,
    isCompleted: r.isCompleted,
    isProcessing: r.isProcessing,
    isError: r.isError,
  });
}
