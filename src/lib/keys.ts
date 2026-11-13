// نظام المفاتيح المتسلسلة — قلب المشروع.
// الترتيب الصارم: أول مفتاح أُضيف يُجرَّب أولًا (created_at ASC, id ASC) — لا round-robin.
// التبديل التلقائي عند أي خطأ أو نفاد رصيد دون توقف المهمة.

import {
  listApiKeys,
  updateApiKeyStatus,
  recordKeyUsage,
  type ApiKeyRow,
} from "./turso";

export type ProviderId = "kie" | "cometapi";
export type KeyStatus = "active" | "exhausted" | "disabled";

// إخفاء المفاتيح إلزامي في كل الاستجابات والسجلات.
// للمفاتيح الطويلة: أول 7 + •••••••• + آخر 4. للقصيرة: أول 3 + ••••.
export function maskKey(key: string): string {
  if (!key) return "";
  const k = String(key);
  if (k.length <= 12) {
    return k.slice(0, Math.min(3, k.length)) + "••••";
  }
  return k.slice(0, 7) + "••••••••" + k.slice(-4);
}

// جلب كل المفاتيح غير المعطّلة لهذه المزودات بالترتيب التسلسلي الصارم.
// المفتاح المستنزف (exhausted) يبقى في القائمة — الاستثناء الوحيد هو التعطيل اليدوي (disabled).
export async function getKeyPool(providers: ProviderId[]): Promise<ApiKeyRow[]> {
  const all = await listApiKeys();
  return all.filter(
    (k) => providers.includes(k.provider as ProviderId) && k.status !== "disabled"
  );
}

// فئات الأخطاء — تحدّد الإجراء (تعطيل/استنزاف/انتقال للتالي/توقف).
export type ErrorClass = "disabled" | "exhausted" | "provider" | "params" | "temporary";

export interface ProviderError extends Error {
  status: number;
  body?: unknown;
}

export function makeProviderError(status: number, message: string, body?: unknown): ProviderError {
  const e = new Error(message) as ProviderError;
  e.status = status;
  e.body = body;
  e.name = "ProviderError";
  return e;
}

// دالة موحّدة لتصنيف أخطاء المزود وفق جدول 4.2.
// الترتيب مهم: نفاد الرصيد يُفحص قبل 400 لأن بعض المزودين يرسلونه بحالة 400.
export function classifyProviderError(err: ProviderError): ErrorClass {
  const status = err.status || 0;
  const msg = (err.message || "").toLowerCase();
  const bodyStr = typeof err.body === "string" ? err.body : JSON.stringify(err.body ?? "");
  const text = (msg + " " + bodyStr).toLowerCase();

  // 1) مفتاح مرفوض → تعطيل تلقائي والانتقال للتالي.
  if (
    status === 401 ||
    status === 403 ||
    /invalid api key|unauthorized|forbidden|authentication|api[_ ]?key.*(invalid|wrong|incorrect)/.test(
      text
    )
  ) {
    return "disabled";
  }

  // 2) نفاد الرصيد — يُفحص قبل 400 (بعض المزودين يرسل 400 بدل 402).
  if (
    status === 402 ||
    /insufficient|quota|balance|credit|out of credits|exhausted|充值|no.*credit|rate.*limit.*balance/.test(
      text
    )
  ) {
    return "exhausted";
  }

  // 3) موديل غير مدعوم لدى هذا المزود → انتقل للتالي.
  if (
    /model not found|unsupported model|model.*not.*available|no such model/.test(text) &&
    (status === 400 || status === 404 || status === 422)
  ) {
    return "provider";
  }

  // 4) خطأ معطيات الطلب → توقف فوري (تبديل المفاتيح لن يحله).
  if (status === 400 || status === 422) {
    return "params";
  }

  // 5) مؤقت: 429، 5xx، شبكة، timeout → انتقل للتالي الآن والمفتاح يبقى سليمًا.
  if (status === 429 || status >= 500 || status === 0) {
    return "temporary";
  }

  // افتراضي: اعتبره مؤقتًا (ننتقل للتالي دون تعطيل).
  return "temporary";
}

// تطبيق الإجراء بعد التصنيف: تحديث حالة المفتاح + تسجيل الاستخدام.
export async function applyKeyFailure(
  key: ApiKeyRow,
  cls: ErrorClass,
  errorMsg: string
): Promise<void> {
  // تعطيل تلقائي للمفاتيح المرفوضة، واستنزاف للمفاتيح بلا رصيد. غيرها تبقى سليمة.
  if (cls === "disabled") await updateApiKeyStatus(key.id, "disabled");
  else if (cls === "exhausted") await updateApiKeyStatus(key.id, "exhausted");
  await recordKeyUsage(key.id, false, errorMsg);
}

export async function applyKeySuccess(key: ApiKeyRow): Promise<void> {
  await recordKeyUsage(key.id, true, null);
}

// قفل في الذاكرة لمنع تزامن عمليات الدمج على نفس المهمة (section 7.3).
export const processInFlight: Set<string> = new Set();
