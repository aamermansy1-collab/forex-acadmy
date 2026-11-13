// GET/DELETE /api/jobs/[id] — حالة مهمة الدمج + الحذف الشامل.

import { deleteMergeJob, getMergeJob, refreshMergeJob } from "@/lib/merger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const { id } = await params;
  const job = await getMergeJob(id);
  if (!job) return jsonError(404, "مهمة الدمج غير موجودة");
  const r = await refreshMergeJob(id);
  // إن كان هناك error بلا status صريح → عاملها failed فورًا.
  const status = r.status === "failed" || job.error ? "failed" : r.status;
  return Response.json({
    jobId: id,
    status,
    progress: r.progress,
    videoUrl: r.videoUrl || job.video_url || null,
    downloadUrl: r.downloadUrl || job.download_url || null,
    size: job.size,
    duration: job.duration,
    resolution: job.resolution,
    error: r.error || job.error || null,
    expiresAt: job.expires_at,
  });
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const { id } = await params;
  const job = await getMergeJob(id);
  if (!job) return jsonError(404, "مهمة الدمج غير موجودة");
  await deleteMergeJob(id);
  return Response.json({ deleted: id });
}

function jsonError(status: number, message: string): Response {
  return Response.json({ error: message }, { status });
}
