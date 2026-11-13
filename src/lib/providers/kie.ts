// مزود kie.ai — المزود الأساسي. Jobs API الموحّد.
// تم قياس الأشكال الحقيقية بـ curl:
//   POST https://api.kie.ai/api/v1/jobs/createTask
//     Authorization: Bearer <key>
//     {"model": "<providerModel>", "input": {...}}
//     → {"code":200,"msg":"success","data":{"taskId":"...","recordId":"..."}}
//   GET https://api.kie.ai/api/v1/jobs/recordInfo?taskId=<id>
//     → {"code":200,"data":{"state":"waiting|queuing|generating|success|fail",
//         "resultJson":"{\"resultUrls\":[\"https://...\"]}",  // نص JSON داخل JSON
//         "failMsg":"...", "successFlag":0|1}}

import { ProviderError, type GenerateInput, type ProviderAdapter } from "./types";
import type { ProviderId } from "../models";

const KIE_BASE = "https://api.kie.ai/api/v1";

// تحليل آمن لجسم الخطأ من الرد.
async function parseError(res: Response): Promise<ProviderError> {
  let body: unknown = null;
  let msg = `HTTP ${res.status}`;
  try {
    body = await res.json();
    const b = body as Record<string, unknown>;
    const m = typeof b.msg === "string" ? b.msg : typeof b.message === "string" ? b.message : "";
    const d = b.data as Record<string, unknown> | undefined;
    const dm = d && typeof d.failMsg === "string" ? d.failMsg : "";
    if (m) msg = m;
    if (dm) msg = msg + (msg ? " — " : "") + dm;
    if (!msg) msg = `HTTP ${res.status}`;
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

export const kieProvider: ProviderAdapter = {
  id: "kie" as ProviderId,

  async createTask(key, model, input) {
    const body = { model, input };
    const res = await fetch(`${KIE_BASE}/jobs/createTask`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw await parseError(res);
    const data = (await res.json()) as {
      code?: number;
      msg?: string;
      data?: { taskId?: string; recordId?: string };
    };
    if (data.code !== 200 || !data.data?.taskId) {
      throw new ProviderError(
        res.status,
        data.msg || "kie: استجابة غير متوقعة عند إنشاء المهمة",
        data
      );
    }
    return { providerTaskId: data.data.taskId };
  },

  async checkTask(key, providerTaskId) {
    const res = await fetch(
      `${KIE_BASE}/jobs/recordInfo?taskId=${encodeURIComponent(providerTaskId)}`,
      {
        headers: { Authorization: `Bearer ${key}` },
      }
    );
    if (!res.ok) throw await parseError(res);
    const data = (await res.json()) as {
      code?: number;
      data?: {
        state?: string;
        resultJson?: string;
        failMsg?: string | null;
        successFlag?: number;
      };
    };
    if (data.code !== 200 || !data.data) {
      throw new ProviderError(res.status, "kie: استجابة غير متوقعة عند الاستعلام", data);
    }
    const state = (data.data.state || "").toLowerCase();
    const failMsg = data.data.failMsg || "";

    // resultJson نص يحتاج JSON.parse ثانيًا — انتبه لهذا.
    let urls: string[] = [];
    if (data.data.resultJson) {
      try {
        const parsed = JSON.parse(data.data.resultJson) as { resultUrls?: string[] };
        urls = Array.isArray(parsed.resultUrls) ? parsed.resultUrls : [];
      } catch {
        /* resultJson تالف — نتجاهل */
      }
    }

    if (state === "success" || data.data.successFlag === 1) {
      return { status: "completed", urls, progress: 100 };
    }
    if (state === "fail" || state === "failed") {
      return { status: "failed", error: failMsg || "فشل التوليد لدى المزود", progress: 100 };
    }
    // waiting|queuing|generating → قيد المعالجة.
    const progress =
      state === "generating" ? 55 : state === "queuing" ? 25 : 10;
    return { status: "processing", progress };
  },
};
