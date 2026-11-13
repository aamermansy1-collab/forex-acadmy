// POST /api/upload?job=<id>&seq=<n>&chunk=<k> — رفع أجزاء ملفات ثنائية ≤4MB.
// Content-Type: application/octet-stream. الجسم هو البايتات الخام.

import { appendSourceChunk, getMergeJob, markSourceUploaded, mergeConfig } from "@/lib/merger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const jobId = url.searchParams.get("job");
  const seqStr = url.searchParams.get("seq");
  const chunkStr = url.searchParams.get("chunk");
  if (!jobId || seqStr === null || chunkStr === null) {
    return jsonError(400, "job و seq و chunk مطلوبة في الـ query");
  }
  const seq = Number(seqStr);
  const chunk = Number(chunkStr);
  if (!Number.isFinite(seq) || !Number.isFinite(chunk)) {
    return jsonError(400, "seq و chunk يجب أن يكونا أرقامًا");
  }
  const job = await getMergeJob(jobId);
  if (!job) return jsonError(404, "مهمة الدمج غير موجودة");
  const cfg = mergeConfig();
  const maxChunk = 4 * 1024 * 1024;
  const buf = Buffer.from(await req.arrayBuffer());
  if (buf.byteLength > maxChunk) {
    return jsonError(413, `حجم الجزء يتجاوز ${maxChunk} بايت`);
  }
  // إعادة محاولة بسيطة: المحاولة الأولى. العميل يعيد عند الفشل.
  await appendSourceChunk(jobId, seq, chunk, buf);
  // إن كان هذا آخر جزء (Content-Length صغير) نعلّم المصدر كمرفوع.
  // نستخدم علامة نهاية: chunk=-1 يعلّم الاكتمال.
  if (chunk === -1) {
    await markSourceUploaded(jobId, seq, Number(buf.byteLength));
  }
  return Response.json({ ok: true, job: jobId, seq, chunk, bytes: buf.byteLength, maxSources: cfg.maxSources });
}

function jsonError(status: number, message: string): Response {
  return Response.json({ error: message }, { status });
}
