// POST /api/jobs — إنشاء مهمة دمج.
// يقبل {"videos":["url1","url2"]} أو {"sources":[{"kind":"url"|"file",...}]}.
// إعادة 201 مع jobId + statusUrl + processUrl + expiresAt (+ uploads[] للملفات).

import { createMergeJob, mergeConfig, type MergeInput } from "@/lib/merger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  let body: {
    videos?: string[];
    sources?: MergeInput[];
  };
  try {
    body = await req.json();
  } catch {
    return jsonError(400, "JSON تالف");
  }
  const cfg = mergeConfig();
  let inputs: MergeInput[] = [];
  if (Array.isArray(body.sources) && body.sources.length > 0) {
    inputs = body.sources;
  } else if (Array.isArray(body.videos) && body.videos.length > 0) {
    for (const u of body.videos) {
      if (typeof u !== "string" || !/^https?:\/\//i.test(u)) {
        return jsonError(400, `رابط غير صالح: ${u}`);
      }
      inputs.push({ kind: "url", url: u });
    }
  } else {
    return jsonError(400, "أرسل videos (روابط) أو sources");
  }
  if (inputs.length < 2) return jsonError(400, "الدمج يتطلب مقطعين على الأقل");
  if (inputs.length > cfg.maxSources)
    return jsonError(400, `أقصى عدد مقاطع للدمج هو ${cfg.maxSources}`);

  try {
    const job = await createMergeJob(inputs);
    // إن وُجدت ملفات مرفوعة، نُرجع روابط الرفع لكل مصدر + حجم الجزء.
    const uploads = inputs
      .map((s, i) =>
        s.kind === "file"
          ? { seq: i, uploadUrl: `/api/upload?job=${job.jobId}&seq=${i}&chunk=` }
          : null
      )
      .filter(Boolean) as { seq: number; uploadUrl: string }[];
    return Response.json(
      {
        jobId: job.jobId,
        status: job.status,
        statusUrl: job.statusUrl,
        processUrl: job.processUrl,
        expiresAt: job.expiresAt,
        uploads,
        uploadChunkBytes: 4 * 1024 * 1024,
      },
      { status: 201 }
    );
  } catch (e) {
    return jsonError(400, (e as Error).message || "خطأ في إنشاء المهمة");
  }
}

function jsonError(status: number, message: string): Response {
  return Response.json({ error: message }, { status });
}
