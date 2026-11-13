// منسّق التوليد والدمج — يطبّق سياسة التبديل التسلسلي الصارم «لا توقف أبدًا».
// التدفق (قسم 6):
//  1) وحّد اسم الموديل — غير معروف → خطأ معطيات فوري.
//  2) getKeyPool(providers الموديل) — فارغ → رد no_keys.
//  3) سجّل المهمة في Turso قبل أي نداء خارجي.
//  4) جرّب المرشحين بالترتيب حتى نجاح الإنشاء.
//  5) نافذة انتظار: استعلم checkTask كل 3 ثوانٍ وأرسل تقدمًا حيًا.
//  6) اكتمل → خزّن الروابط. فشل مفتاح/رصيد → أعد الإنشاء على التالي بنفس task_id.
//  7) انتهت النافذة → أعد المهمة processing والعميل يتابع بـ get_task.

import { randomUUID } from "node:crypto";
import {
  db,
  ensureSchema,
  getTask,
  insertTask,
  updateTask,
  type AttemptRecord,
  type TaskRow,
} from "./turso";
import {
  applyKeyFailure,
  applyKeySuccess,
  classifyProviderError,
  getKeyPool,
  processInFlight,
  type ErrorClass,
  type ProviderError,
} from "./keys";
import { resolveModel } from "./models";
import { PROVIDERS, type GenerateInput } from "./providers";
import {
  createMergeJob,
  processMergeJob,
  refreshMergeJob,
  resolveMergeInputs,
  type MergeInput,
} from "./merger";

// رد الأداة: إما مكتمل بروابط، أو جارية بـ task_id، أو فاشلة.
export interface ToolResult {
  isCompleted: boolean;
  isProcessing: boolean;
  isError: boolean;
  taskId?: string;
  urls?: string[];
  errorMessage?: string;
  progress: number;
  arabicMessage: string; // صياغة عربية جاهزة للعرض للنموذج
}

// مُرسل تقدم اختياري (Progress notifications) — كل ~3 ثوانٍ.
export type ProgressSender = (progress: number, total: number, message: string) => void;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// هل رسالة الخطأ تشير لمشكلة مفتاح/رصيد؟ (لإعادة الإنشاء على المفتاح التالي في منتصف المهمة)
function isKeyBalanceError(msg: string): boolean {
  const t = (msg || "").toLowerCase();
  return /insufficient|balance|credit|quota|402|401|unauthorized|exhausted|out of credits|充值/.test(
    t
  );
}

// ===== توليد صورة أو فيديو =====
export async function runGeneration(args: {
  modelInput: string;
  type: "image" | "video";
  input: GenerateInput;
  waitSeconds: number;
  onProgress?: ProgressSender;
}): Promise<ToolResult> {
  const model = resolveModel(args.modelInput);
  if (!model) {
    // موديل غير معروف → خطأ معطيات فوري (لا تبديل مفاتيح يحله).
    return {
      isCompleted: false,
      isProcessing: false,
      isError: true,
      progress: 0,
      arabicMessage: `❌ موديل غير معروف: ${args.modelInput}. الموديلات المدعومة: gpt-image-2-6/flare-text-to-image (صور) و grok-imagine-video-1-5-preview (فيديو).`,
      errorMessage: `unknown model: ${args.modelInput}`,
    };
  }

  const pool = await getKeyPool(model.providers);
  if (pool.length === 0) {
    // لا مفاتيح نشطة → رد no_keys عربي.
    return {
      isCompleted: false,
      isProcessing: false,
      isError: true,
      progress: 0,
      arabicMessage: `❌ لا توجد مفاتيح نشطة لخدمة ${model.canonical}. أضف مفتاحًا واحدًا على الأقل من واجهة الإدارة، ثم أعد المحاولة.`,
      errorMessage: "no_keys",
    };
  }

  const taskId = randomUUID();
  // سجّل المهمة قبل أي نداء خارجي حتى تنقطع تبقى قابلة للتتبع.
  await insertTask({
    id: taskId,
    model: model.canonical,
    type: args.type,
    prompt: args.input.prompt,
    params_json: JSON.stringify(args.input),
    status: "pending",
  });

  // نافذة الانتظار الإجمالية (الافتراضي 90 للصور و25 للفيديو).
  const waitMs = Math.max(0, Math.min(240, args.waitSeconds)) * 1000;
  const deadline = Date.now() + waitMs;

  // جرّب المرشحين بالترتيب حتى نجاح الإنشاء (قسم 4.3).
  let created: {
    provider: (typeof model.providers)[number];
    keyId: string;
    keyLabel: string;
    providerTaskId: string;
  } | null = null;

  for (const key of pool) {
    const providerId = key.provider as (typeof model.providers)[number];
    const adapter = PROVIDERS[providerId];
    const providerModel = model.providerModel[providerId];
    try {
      // للصور: إن كان المزود يدعم createImageSync جرّبه أولًا (CometAPI).
      if (args.type === "image" && adapter.createImageSync) {
        try {
          const sync = await adapter.createImageSync(key.api_key, providerModel, args.input);
          await applyKeySuccess(key);
          const attempt: AttemptRecord = {
            provider: providerId,
            keyId: key.id,
            keyLabel: key.label || key.provider,
            ok: true,
            at: new Date().toISOString(),
          };
          await updateTask(taskId, {
            provider: providerId,
            key_id: key.id,
            status: "completed",
            progress: 100,
            result_urls_json: JSON.stringify(sync.urls),
            addAttempt: attempt,
          });
          return completedResult(args.type, sync.urls);
        } catch (e) {
          // فشل sync — نتصنّف ونسجل ثم نتابع للمسار غير المتزامن أو المفتاح التالي.
          const pe = e as ProviderError;
          const cls = classifyProviderError(pe);
          await applyKeyFailure(key, cls as ErrorClass, pe.message);
          const attempt: AttemptRecord = {
            provider: providerId,
            keyId: key.id,
            keyLabel: key.label || key.provider,
            ok: false,
            errorClass: cls,
            error: pe.message,
            at: new Date().toISOString(),
          };
          await updateTask(taskId, { addAttempt: attempt });
          // خطأ معطيات → توقف فوري.
          if (cls === "params") {
            return paramsError(taskId, pe.message);
          }
          continue; // انتقل للمفتاح التالي.
        }
      }

      // مسار غير متزامن: createTask.
      const { providerTaskId } = await adapter.createTask(key.api_key, providerModel, args.input);
      await applyKeySuccess(key);
      const attempt: AttemptRecord = {
        provider: providerId,
        keyId: key.id,
        keyLabel: key.label || key.provider,
        ok: true,
        at: new Date().toISOString(),
      };
      await updateTask(taskId, {
        provider: providerId,
        provider_task_id: providerTaskId,
        key_id: key.id,
        status: "processing",
        progress: 5,
        addAttempt: attempt,
      });
      created = { provider: providerId, keyId: key.id, keyLabel: key.label || key.provider, providerTaskId };
      break; // نجح الإنشاء → اخرج من الحلقة.
    } catch (e) {
      const pe = e as ProviderError;
      const cls = classifyProviderError(pe);
      await applyKeyFailure(key, cls as ErrorClass, pe.message);
      const attempt: AttemptRecord = {
        provider: providerId,
        keyId: key.id,
        keyLabel: key.label || key.provider,
        ok: false,
        errorClass: cls,
        error: pe.message,
        at: new Date().toISOString(),
      };
      await updateTask(taskId, { addAttempt: attempt });
      // خطأ معطيات → توقف فوري.
      if (cls === "params") {
        return paramsError(taskId, pe.message);
      }
      // غير ذلك: انتقل للمفتاح التالي (disabled/exhausted/provider/temporary).
    }
  }

  if (!created) {
    // فشل الإنشاء على كل المفاتيح → تبقى processing وتُعاد محاولتها مع get_task (بتهدئة ~45 ثانية).
    await updateTask(taskId, {
      status: "processing",
      progress: 0,
      error_message: "بانتظار توفر مفتاح صالح…",
    });
    return processingResult(taskId, 0);
  }

  // نافذة الانتظار: استعلم كل 3 ثوانٍ وأرسل تقدمًا حيًا.
  const adapter = PROVIDERS[created.provider];
  const providerModel = model.providerModel[created.provider];
  let lastProgress = 5;
  while (Date.now() < deadline) {
    await sleep(3000);
    try {
      const checked = await adapter.checkTask(createdKey(created), created.providerTaskId);
      if (checked.status === "completed" && checked.urls && checked.urls.length > 0) {
        await updateTask(taskId, {
          status: "completed",
          progress: 100,
          result_urls_json: JSON.stringify(checked.urls),
        });
        return completedResult(args.type, checked.urls);
      }
      if (checked.status === "failed") {
        // فشل في منتصف المهمة: إن كان مشكلة مفتاح/رصيد → أعد الإنشاء على المفتاح التالي بنفس task_id.
        if (isKeyBalanceError(checked.error || "")) {
          const switched = await switchToNextKey(
            taskId,
            model,
            args.input,
            created.provider,
            created.keyId
          );
          if (switched) {
            created = switched;
            continue;
          }
          // لا مفتاح تالي → تبقى processing.
          await updateTask(taskId, {
            status: "processing",
            error_message: "بانتظار توفر مفتاح صالح…",
          });
          return processingResult(taskId, lastProgress);
        }
        // فشل حقيقي (سياسة/معطيات) → failed.
        await updateTask(taskId, {
          status: "failed",
          progress: 100,
          error_message: checked.error || "فشل غير معروف",
        });
        return failedResult(checked.error || "فشل غير معروف");
      }
      // processing → حدّث التقدم.
      lastProgress = checked.progress ?? lastProgress;
      await updateTask(taskId, { progress: lastProgress });
      if (args.onProgress) {
        const pct = Math.min(99, lastProgress);
        args.onProgress(pct, 100, `قيد التوليد… ${pct}%`);
      }
    } catch (e) {
      // خطأ مؤقت أثناء الاستعلام → استمر حتى انتهاء النافذة دون توقف.
      const pe = e as ProviderError;
      const cls = classifyProviderError(pe);
      if (cls === "disabled" || cls === "exhausted") {
        // المفتاح صار غير صالح أثناء الاستعلام → حاول التبديل.
        const switched = await switchToNextKey(
          taskId,
          model,
          args.input,
          created.provider,
          created.keyId
        );
        if (switched) {
          created = switched;
          continue;
        }
      }
      // غير ذلك: استمر بالاستعلام.
    }
  }

  // انتهت النافذة ولم تكتمل → processing والعميل يتابع بـ get_task.
  await updateTask(taskId, { status: "processing", progress: lastProgress });
  return processingResult(taskId, lastProgress);

  // دالة مساعدة لتمرير مفتاح الإنشاء الحالي (نجلب المفتاح من القاعدة لضمان الحالة).
  function createdKey(c: NonNullable<typeof created>): string {
    // نستخدم مفتاح المهمة المسجّل؛ نقرأه من القاعدة لضمان الحالة الحالية.
    // للأداء نستخدم قيمة مخزّنة عبر closure — لكن هنا نمرّرها مباشرة من المتغير المحلي.
    // نقرأ المفتاح من القاعدة لضمان الحالة.
    return pool.find((k) => k.id === c.keyId)?.api_key || "";
  }
}

// تبديل المفتاح في منتصف المهمة: أعد الإنشاء على المفتاح التالي بنفس task_id.
async function switchToNextKey(
  taskId: string,
  model: ReturnType<typeof resolveModel>,
  input: GenerateInput,
  usedProvider: string,
  usedKeyId: string
): Promise<{
  provider: (NonNullable<typeof model> extends infer M ? M extends { providers: infer P } ? P : never : never)[number];
  keyId: string;
  keyLabel: string;
  providerTaskId: string;
} | null> {
  if (!model) return null;
  const pool = await getKeyPool(model.providers);
  // ابدأ بعد المفتاح المستخدم بالترتيب التسلسلي.
  const idx = pool.findIndex((k) => k.id === usedKeyId);
  const rest = idx >= 0 ? pool.slice(idx + 1) : pool;
  for (const key of rest) {
    const providerId = key.provider as (typeof model.providers)[number];
    const adapter = PROVIDERS[providerId];
    const providerModel = model.providerModel[providerId];
    try {
      const { providerTaskId } = await adapter.createTask(key.api_key, providerModel, input);
      await applyKeySuccess(key);
      const attempt: AttemptRecord = {
        provider: providerId,
        keyId: key.id,
        keyLabel: key.label || key.provider,
        ok: true,
        at: new Date().toISOString(),
      };
      await updateTask(taskId, {
        provider: providerId,
        provider_task_id: providerTaskId,
        key_id: key.id,
        status: "processing",
        progress: 5,
        addAttempt: attempt,
      });
      return {
        provider: providerId as never,
        keyId: key.id,
        keyLabel: key.label || key.provider,
        providerTaskId,
      };
    } catch (e) {
      const pe = e as ProviderError;
      const cls = classifyProviderError(pe);
      await applyKeyFailure(key, cls as ErrorClass, pe.message);
      const attempt: AttemptRecord = {
        provider: providerId,
        keyId: key.id,
        keyLabel: key.label || key.provider,
        ok: false,
        errorClass: cls,
        error: pe.message,
        at: new Date().toISOString(),
      };
      await updateTask(taskId, { addAttempt: attempt });
      if (cls === "params") break; // توقف فوري لمعطيات.
    }
  }
  return null;
}

// ===== الدمج =====
export async function runMerge(args: {
  inputs: MergeInput[];
  waitSeconds: number;
  onProgress?: ProgressSender;
}): Promise<ToolResult> {
  const taskId = randomUUID();
  // تحقق صارم: ≥2 وكلها روابط مباشرة.
  if (args.inputs.length < 2) {
    return {
      isCompleted: false,
      isProcessing: false,
      isError: true,
      progress: 0,
      arabicMessage:
        "❌ الدمج يحتاج مقطعَين على الأقل. مرّر urls (روابط مباشرة) أو task_ids لمهام مكتملة.",
      errorMessage: "merge_needs_two",
    };
  }
  if (args.inputs.length > 10) {
    return {
      isCompleted: false,
      isProcessing: false,
      isError: true,
      progress: 0,
      arabicMessage:
        "❌ أقصى عدد مقاطع للدمج هو 10 (خدمة الدمج تقبل 10 مقاطع كحد أقصى).",
      errorMessage: "merge_too_many",
    };
  }

  // سجّل مهمة الدمج في Turso أولًا.
  await insertTask({
    id: taskId,
    provider: "merger",
    model: "video-merger",
    type: "merge",
    prompt: args.inputs.map((i) => i.url).join(" "),
    params_json: JSON.stringify({ inputs: args.inputs }),
    status: "pending",
  });

  try {
    // أنشئ مهمة الدمج في خدمة الدمج المدمجة.
    const job = await createMergeJob(args.inputs, taskId);
    await updateTask(taskId, {
      provider_task_id: job.jobId,
      status: "processing",
      progress: 0,
    });

    // نفّذ process مباشرةً (blocking) خلال نافذة الانتظار — أنسب لـ serverless
    // لأن العمل الخلفي يُقتل بعد إرجاع الرد. القفل في الذاكرة يمنع التزامن
    // إن حاول get_task تشغيل process على نفس المهمة.
    let result: { status: string; videoUrl?: string; error?: string; size?: number; duration?: number; resolution?: string };
    if (processInFlight.has(job.jobId)) {
      // قيد المعالجة فعلًا من استدعاء متزامن آخر → استعلم الحالة.
      result = await refreshMergeJobRaw(job.jobId);
    } else {
      processInFlight.add(job.jobId);
      try {
        result = await processMergeJob(job.jobId);
      } finally {
        processInFlight.delete(job.jobId);
      }
    }

    if (result.status === "done" && result.videoUrl) {
      const urls = [result.videoUrl];
      await updateTask(taskId, {
        status: "completed",
        progress: 100,
        result_urls_json: JSON.stringify(urls),
      });
      return mergeCompletedResult(urls);
    }
    if (result.status === "failed") {
      await updateTask(taskId, {
        status: "failed",
        progress: 100,
        error_message: result.error || "فشل الدمج",
      });
      return failedResult(result.error || "فشل الدمج");
    }

    // إن كانت ما زالت processing (نادرة) → أعد processing والعميل يتابع.
    await updateTask(taskId, { status: "processing", progress: 50 });
    return processingResult(taskId, 50);
  } catch (e) {
    const msg = (e as Error).message || "خطأ في الدمج";
    await updateTask(taskId, { status: "failed", progress: 100, error_message: msg });
    return failedResult(msg);
  }
}

// غلاف لتحويل نتيجة refreshMergeJob إلى صيغة processMergeJob.
async function refreshMergeJobRaw(jobId: string): Promise<{
  status: string;
  videoUrl?: string;
  error?: string;
}> {
  const r = await refreshMergeJob(jobId);
  if (r.status === "done") return { status: "done", videoUrl: r.videoUrl };
  if (r.status === "failed") return { status: "failed", error: r.error };
  return { status: "processing" };
}

// ===== تحديث مهمة جارية عبر get_task =====
// مع إعادة المحاولة التلقائية للمهام العالقة (بتهدئة ~45 ثانية).
const RETRY_COOLDOWN_MS = 45_000;

export async function refreshTask(taskId: string): Promise<ToolResult> {
  await ensureSchema();
  const task = await getTask(taskId);
  if (!task) {
    return failedResult("المهمة غير موجودة");
  }
  if (task.status === "completed") {
    const urls = task.result_urls_json ? JSON.parse(task.result_urls_json) : [];
    return completedResult(task.type as "image" | "video", urls);
  }
  if (task.status === "failed") {
    return failedResult(task.error_message || "فشلت المهمة");
  }

  // مهمة جارية: حدّث من المزود/الخدمة.
  if (task.type === "merge") {
    if (task.provider_task_id) {
      // إن كانت المهمة queued/processing ولم يُنفَّذ process بعد → نفّذه الآن (بقفل).
      const cur = await refreshMergeJob(task.provider_task_id);
      if ((cur.status === "queued" || cur.status === "processing") && cur.progress === 0 && !processInFlight.has(task.provider_task_id)) {
        processInFlight.add(task.provider_task_id);
        try {
          const res = await processMergeJob(task.provider_task_id);
          if (res.status === "done" && res.videoUrl) {
            const urls = [res.videoUrl];
            await updateTask(taskId, {
              status: "completed",
              progress: 100,
              result_urls_json: JSON.stringify(urls),
            });
            return mergeCompletedResult(urls);
          }
          if (res.status === "failed") {
            await updateTask(taskId, {
              status: "failed",
              progress: 100,
              error_message: res.error || "فشل الدمج",
            });
            return failedResult(res.error || "فشل الدمج");
          }
        } finally {
          processInFlight.delete(task.provider_task_id);
        }
      }
      const r = await refreshMergeJob(task.provider_task_id);
      if (r.status === "done") {
        const urls = [r.videoUrl].filter(Boolean) as string[];
        await updateTask(taskId, {
          status: "completed",
          progress: 100,
          result_urls_json: JSON.stringify(urls),
        });
        return mergeCompletedResult(urls);
      }
      if (r.status === "failed") {
        await updateTask(taskId, {
          status: "failed",
          progress: 100,
          error_message: r.error || "فشل الدمج",
        });
        return failedResult(r.error || "فشل الدمج");
      }
      await updateTask(taskId, { progress: r.progress });
      return processingResult(taskId, r.progress);
    }
    return failedResult("مهمة الدمج غير موجودة في الخدمة");
  }

  // مهمة توليد جارية.
  if (task.provider && task.provider_task_id) {
    const model = resolveModel(task.model);
    if (!model) return failedResult("موديل المهمة غير معروف");
    const pool = await getKeyPool(model.providers);
    const key = pool.find((k) => k.id === task.key_id) || pool[0];
    if (!key) {
      // لا مفتاح حاليًا → تبقى processing بانتظار توفر مفتاح.
      return processingResult(taskId, task.progress);
    }
    const adapter = PROVIDERS[task.provider as (typeof model.providers)[number]];
    try {
      const checked = await adapter.checkTask(key.api_key, task.provider_task_id);
      if (checked.status === "completed" && checked.urls && checked.urls.length > 0) {
        await updateTask(taskId, {
          status: "completed",
          progress: 100,
          result_urls_json: JSON.stringify(checked.urls),
        });
        return completedResult(task.type as "image" | "video", checked.urls);
      }
      if (checked.status === "failed") {
        if (isKeyBalanceError(checked.error || "")) {
          // أعد المحاولة على مفتاح تالي (بتهدئة 45 ثانية).
          const updated = new Date(task.updated_at).getTime();
          if (Date.now() - updated >= RETRY_COOLDOWN_MS) {
            const switched = await switchToNextKey(
              taskId,
              model,
              JSON.parse(task.params_json || "{}") as GenerateInput,
              task.provider,
              task.key_id || ""
            );
            if (switched) {
              return processingResult(taskId, 5);
            }
          }
          return processingResult(taskId, task.progress);
        }
        await updateTask(taskId, {
          status: "failed",
          progress: 100,
          error_message: checked.error || "فشل التوليد",
        });
        return failedResult(checked.error || "فشل التوليد");
      }
      await updateTask(taskId, { progress: checked.progress ?? task.progress });
      return processingResult(taskId, checked.progress ?? task.progress);
    } catch {
      return processingResult(taskId, task.progress);
    }
  }

  // مهمة pending بدون provider_task_id → حاول الإنشاء الآن (بتهدئة).
  if (task.status === "pending" || task.status === "processing") {
    const updated = new Date(task.updated_at).getTime();
    if (Date.now() - updated >= RETRY_COOLDOWN_MS) {
      // أعد محاولة الإنشاء من البداية على المفتاح التالي.
      const model = resolveModel(task.model);
      if (model && (task.type === "image" || task.type === "video")) {
        const input = JSON.parse(task.params_json || "{}") as GenerateInput;
        // إعادة التشغيل الموجز: نُعيد runGeneration بنفس المدخلات لكن نوجّه النتيجة لنفس task_id.
        // للأبسط: نُعيد الإنشاء عبر switchToNextKey بدءًا من لا شيء.
        const pool = await getKeyPool(model.providers);
        for (const key of pool) {
          const providerId = key.provider as (typeof model.providers)[number];
          const adapter = PROVIDERS[providerId];
          const providerModel = model.providerModel[providerId];
          try {
            const { providerTaskId } = await adapter.createTask(
              key.api_key,
              providerModel,
              input
            );
            await applyKeySuccess(key);
            await updateTask(taskId, {
              provider: providerId,
              provider_task_id: providerTaskId,
              key_id: key.id,
              status: "processing",
              progress: 5,
              addAttempt: {
                provider: providerId,
                keyId: key.id,
                keyLabel: key.label || key.provider,
                ok: true,
                at: new Date().toISOString(),
              },
            });
            return processingResult(taskId, 5);
          } catch (e) {
            const pe = e as ProviderError;
            const cls = classifyProviderError(pe);
            await applyKeyFailure(key, cls as ErrorClass, pe.message);
            await updateTask(taskId, {
              addAttempt: {
                provider: providerId,
                keyId: key.id,
                keyLabel: key.label || key.provider,
                ok: false,
                errorClass: cls,
                error: pe.message,
                at: new Date().toISOString(),
              },
            });
            if (cls === "params") break;
          }
        }
      }
    }
    return processingResult(taskId, task.progress);
  }

  return processingResult(taskId, task.progress);
}

// ===== دوال صياغة الردود العربية =====
function completedResult(type: "image" | "video", urls: string[]): ToolResult {
  if (type === "image") {
    const u = urls[0] || "";
    return {
      isCompleted: true,
      isProcessing: false,
      isError: false,
      progress: 100,
      urls,
      arabicMessage: `✅ تم توليد الصورة بنجاح\n\n![image](${u})\n\nالرابط المباشر: ${u}`,
    };
  }
  const lines = urls.map((u) => `الرابط المباشر: ${u}`).join("\n");
  return {
    isCompleted: true,
    isProcessing: false,
    isError: false,
    progress: 100,
    urls,
    arabicMessage: `✅ تم توليد الفيديو بنجاح\n\n${lines}`,
  };
}

function mergeCompletedResult(urls: string[]): ToolResult {
  const lines = urls.map((u) => `الرابط المباشر: ${u}`).join("\n");
  return {
    isCompleted: true,
    isProcessing: false,
    isError: false,
    progress: 100,
    urls,
    arabicMessage: `✅ تم دمج المقاطع بنجاح\n\n${lines}\n\n⚠️ ملف الدمج يُحذف من خدمة الدمج بعد ~24 ساعة — شاهده/نزّله سريعًا.`,
  };
}

function processingResult(taskId: string, progress: number): ToolResult {
  return {
    isCompleted: false,
    isProcessing: true,
    isError: false,
    progress,
    taskId,
    arabicMessage: `⏳ المهمة قيد المعالجة — task_id: ${taskId}\nتابع بـ get_task كل ~10 ثوانٍ حتى تكتمل.`,
  };
}

function failedResult(reason: string): ToolResult {
  return {
    isCompleted: false,
    isProcessing: false,
    isError: true,
    progress: 100,
    arabicMessage: `❌ فشلت المهمة: ${reason}`,
    errorMessage: reason,
  };
}

function paramsError(taskId: string, reason: string): ToolResult {
  void taskId;
  return failedResult(reason);
}

// قائمة الوسائط المخزنة (list_media).
export async function listMedia(opts: {
  type?: string;
  status?: string;
  limit?: number;
}): Promise<TaskRow[]> {
  const { listRecentTasks } = await import("./turso");
  return listRecentTasks(opts.limit || 10, {
    type: opts.type,
    status: opts.status,
  });
}

// إعادة تصدير للاستخدام في الأدوات.
export { resolveMergeInputs };
