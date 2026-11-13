// POST /api/jobs/[id]/process — تنفيذ الدمج كاملًا (متزامن blocking ~10-15ث).
// يعيد done + videoUrl + downloadUrl + size + duration + resolution.
// إن كانت المهمة قيد المعالجة فعلاً يعيد 202.

import { getMergeJob, processMergeJob } from "@/lib/merger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const { id } = await params;
  const job = await getMergeJob(id);
  if (!job) return jsonError(404, "مهمة الدمج غير موجودة");
  if (job.status === "done") {
    return Response.json({
      status: "done",
      videoUrl: job.video_url,
      downloadUrl: job.download_url,
      size: job.size,
      duration: job.duration,
      resolution: job.resolution,
      expiresAt: job.expires_at,
    });
  }
  if (job.status === "processing") {
    return Response.json({ status: "processing", progress: job.progress }, { status: 202 });
  }
  // شغّل الدمج متزامنًا.
  const r = await processMergeJob(id);
  if (r.status === "done") {
    return Response.json({
      status: "done",
      videoUrl: r.videoUrl,
      downloadUrl: r.downloadUrl,
      size: r.size,
      duration: r.duration,
      resolution: r.resolution,
      expiresAt: job.expires_at,
    });
  }
  if (r.status === "processing") {
    return Response.json({ status: "processing" }, { status: 202 });
  }
  return Response.json({ status: "failed", error: r.error }, { status: 500 });
}

function jsonError(status: number, message: string): Response {
  return Response.json({ error: message }, { status });
}
