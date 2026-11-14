// POST /api/generate — توليد صورة/فيديو مباشرة من الواجهة (بدون عميل MCP).
// يغلّف runGeneration بنفس منطق التبديل التسلسلي. للصور ينتظر حتى 120ث،
// للفيديو 30ث ثم يرجع task_id والواجهة تستطلع /api/tasks/[id].

import { runGeneration } from "@/lib/coordinator";
import type { GenerateInput } from "@/lib/providers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: Request): Promise<Response> {
  let body: {
    type?: string;
    prompt?: string;
    model?: string;
    aspect_ratio?: string;
    resolution?: string;
    background?: string;
    output_format?: string;
    image_url?: string;
    enable_audio?: boolean;
    duration?: number;
    wait_seconds?: number;
  };
  try {
    body = await req.json();
  } catch {
    return jsonError(400, "JSON تالف");
  }
  const type = (body.type || "").trim();
  const prompt = (body.prompt || "").trim();
  if (type !== "image" && type !== "video") {
    return jsonError(400, "النوع يجب أن يكون 'image' أو 'video'");
  }
  if (!prompt) return jsonError(400, "الـ prompt مطلوب");

  // الموديل الافتراضي حسب النوع.
  const defaultModel =
    type === "image"
      ? "gpt-image-2-6/flare-text-to-image"
      : "grok-imagine-video-1-5-preview";
  const modelInput = body.model || defaultModel;

  const input: GenerateInput = {
    prompt,
    aspect_ratio: body.aspect_ratio,
    resolution: body.resolution,
    background: body.background,
    output_format: body.output_format,
    image_url: body.image_url,
    enable_audio: body.enable_audio,
    duration: body.duration,
  };

  // نافذة الانتظار: صور 120ث، فيديو 30ث (الواجهة تستطلع بعدها).
  const waitSeconds = body.wait_seconds ?? (type === "image" ? 120 : 30);

  try {
    const r = await runGeneration({
      modelInput,
      type: type as "image" | "video",
      input,
      waitSeconds,
    });
    return Response.json({
      isCompleted: r.isCompleted,
      isProcessing: r.isProcessing,
      isError: r.isError,
      progress: r.progress,
      urls: r.urls,
      taskId: r.taskId,
      message: r.arabicMessage,
    });
  } catch (e) {
    return jsonError(500, (e as Error).message || "خطأ في التوليد");
  }
}

function jsonError(status: number, message: string): Response {
  return Response.json({ error: message, isError: true }, { status });
}
