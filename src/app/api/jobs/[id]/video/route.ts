// GET /api/jobs/[id]/video — بث الناتج بدعم Range (206 + Content-Range). ?download=1 للتحميل.

import { getMergeJob, streamJobVideo } from "@/lib/merger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const { id } = await params;
  const url = new URL(req.url);
  const isDownload = url.searchParams.get("download") === "1";
  const job = await getMergeJob(id);
  if (!job || job.status !== "done") {
    return new Response(JSON.stringify({ error: "الفيديو غير جاهز" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }
  const range = req.headers.get("range");
  const { status, headers, body } = await streamJobVideo(id, range);
  const finalHeaders: Record<string, string> = { ...headers };
  if (isDownload) {
    finalHeaders["Content-Disposition"] = `attachment; filename="merged_${id}.mp4"`;
  } else {
    finalHeaders["Content-Disposition"] = "inline";
  }
  return new Response(body as unknown as ReadableStream, { status, headers: finalHeaders });
}
