// مزود CometAPI — المزود الثاني.
// صور متزامنة عبر نقطة /v1/images/generations المتوافقة مع OpenAI تعيد الرابط أو b64_json فورًا.
// فيديو عبر نقطة المهام غير المتزامنة بنفس نمط create/check (نموذج OpenAI-style للمهام).
// التوثيق المرجعي: api.cometapi.com — نتبع النمط الشائع المتوافق مع OpenAI.

import { ProviderError, type GenerateInput, type ProviderAdapter } from "./types";
import type { ProviderId } from "../models";

const COMET_BASE = process.env.COMETAPI_BASE || "https://api.cometapi.com";

async function parseError(res: Response): Promise<ProviderError> {
  let body: unknown = null;
  let msg = `HTTP ${res.status}`;
  try {
    body = await res.json();
    const b = body as Record<string, unknown>;
    const e = b.error as Record<string, unknown> | undefined;
    const m =
      (e && typeof e.message === "string" && e.message) ||
      (typeof b.message === "string" && b.message) ||
      "";
    if (m) msg = m;
  } catch {
    try {
      const t = await res.text();
      if (t) msg = t.slice(0, 300);
    } catch {
      /* ignore */
    }
  }
  return new ProviderError(res.status, msg, body);
}

export const cometapiProvider: ProviderAdapter = {
  id: "cometapi" as ProviderId,

  // صور متزامنة: تعيد رابط الصورة (أو b64_json نحوّله لـ data URL).
  async createImageSync(key, model, input) {
    const res = await fetch(`${COMET_BASE}/v1/images/generations`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        prompt: input.prompt,
        n: 1,
        size: aspectToSize(input.aspect_ratio),
        response_format: "url",
      }),
    });
    if (!res.ok) throw await parseError(res);
    const data = (await res.json()) as {
      data?: Array<{ url?: string; b64_json?: string }>;
    };
    const item = data.data?.[0];
    if (!item) throw new ProviderError(res.status, "cometapi: لا توجد بيانات صورة", data);
    const urls: string[] = [];
    if (item.url) urls.push(item.url);
    else if (item.b64_json) urls.push(`data:image/png;base64,${item.b64_json}`);
    if (urls.length === 0)
      throw new ProviderError(res.status, "cometapi: استجابة صورة بلا رابط", data);
    return { urls };
  },

  // فيديو: مهمة غير متزامنة عبر نمط المهام الشائع.
  async createTask(key, model, input) {
    const payload: Record<string, unknown> = {
      model,
      input: {
        prompt: input.prompt,
        aspect_ratio: input.aspect_ratio || "auto",
        resolution: input.resolution || "480p",
        enable_audio: input.enable_audio !== false,
        duration: input.duration || 8,
      },
    };
    if (input.image_url) (payload.input as Record<string, unknown>).image_url = input.image_url;

    const res = await fetch(`${COMET_BASE}/v1/video/generations/jobs`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw await parseError(res);
    const data = (await res.json()) as { id?: string; jobId?: string; task_id?: string };
    const id = data.id || data.jobId || data.task_id;
    if (!id) throw new ProviderError(res.status, "cometapi: لا معرّف مهمة فيديو", data);
    return { providerTaskId: id };
  },

  async checkTask(key, providerTaskId) {
    const res = await fetch(
      `${COMET_BASE}/v1/video/generations/jobs/${encodeURIComponent(providerTaskId)}`,
      { headers: { Authorization: `Bearer ${key}` } }
    );
    if (!res.ok) throw await parseError(res);
    const data = (await res.json()) as {
      status?: string;
      state?: string;
      progress?: number;
      video?: { url?: string };
      video_url?: string;
      url?: string;
      error?: string | { message?: string };
      output?: { url?: string } | string;
    };
    const st = (data.status || data.state || "").toLowerCase();
    const urls: string[] = [];
    const u =
      data.video?.url || data.video_url || data.url || (typeof data.output === "object" ? data.output?.url : undefined);
    if (u) urls.push(u);
    if (st === "succeeded" || st === "success" || st === "completed" || st === "done") {
      return { status: "completed", urls, progress: 100 };
    }
    if (st === "failed" || st === "error" || st === "cancelled") {
      const em =
        typeof data.error === "string"
          ? data.error
          : data.error?.message || "فشل توليد الفيديو لدى CometAPI";
      return { status: "failed", error: em, progress: 100 };
    }
    const progress =
      typeof data.progress === "number"
        ? data.progress <= 1
          ? Math.round(data.progress * 100)
          : data.progress
        : 30;
    return { status: "processing", progress };
  },
};

// تحويل نسبة العرض إلى حجم OpenAI-style تقريبي.
function aspectToSize(ar?: string): string {
  switch (ar) {
    case "1:1":
      return "1024x1024";
    case "16:9":
      return "1024x576";
    case "9:16":
      return "576x1024";
    case "3:2":
      return "1024x683";
    case "2:3":
      return "683x1024";
    default:
      return "1024x1024";
  }
}
