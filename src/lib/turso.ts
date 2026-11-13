// طبقة قاعدة بيانات Turso/libSQL — عميل واحد عبر HTTP مناسب لـ Vercel serverless.
// لا ملفات SQLite محلية: كل شيء عبر الشبكة إلى Turso.

import { createClient, type Client } from "@libsql/client";

const url = process.env.TURSO_DATABASE_URL;
const authToken = process.env.TURSO_AUTH_TOKEN;

if (!url || !authToken) {
  // في بيئة التطوير نُحذّر فقط؛ التطبيق قد يفشل لاحقًا عند أول استعلام لكن لا نسقط البناء.
  console.warn(
    "[turso] TURSO_DATABASE_URL أو TURSO_AUTH_TOKEN غير مضبوط — تأكد من متغيرات البيئة."
  );
}

// عميل واحد مشترك (libSQL يدعم التزامن عبر HTTP بدون تجمّع اتصالات تقليدي).
export const db: Client = createClient({
  url: url || "libsql://placeholder.turso.io",
  authToken: authToken || "",
});

// ضمان إنشاء الجداول عند أول وصول — لا حاجة لأداة migrations.
let schemaReady = false;
export async function ensureSchema(): Promise<void> {
  if (schemaReady) return;
  // جدولا المهام والمفاتيح كما في المواصفة بالضبط.
  await db.batch([
    {
      sql: `CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        provider TEXT,
        provider_task_id TEXT,
        key_id TEXT,
        model TEXT NOT NULL,
        type TEXT NOT NULL,
        prompt TEXT DEFAULT '',
        params_json TEXT DEFAULT '{}',
        status TEXT NOT NULL,
        progress INTEGER DEFAULT 0,
        result_urls_json TEXT,
        error_message TEXT,
        attempts_json TEXT DEFAULT '[]',
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        completed_at TEXT
      )`,
      args: [],
    },
    {
      sql: `CREATE TABLE IF NOT EXISTS api_keys (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        label TEXT DEFAULT '',
        api_key TEXT NOT NULL,
        status TEXT DEFAULT 'active',
        usage_count INTEGER DEFAULT 0,
        success_count INTEGER DEFAULT 0,
        fail_count INTEGER DEFAULT 0,
        last_used_at TEXT,
        last_checked_at TEXT,
        last_error TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      )`,
      args: [],
    },
    // --- جداول خدمة الدمج المدمجة (القسم 14) ---
    {
      sql: `CREATE TABLE IF NOT EXISTS merge_jobs (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL DEFAULT 'queued',
        progress INTEGER DEFAULT 0,
        video_url TEXT,
        download_url TEXT,
        size INTEGER,
        duration REAL,
        resolution TEXT,
        error TEXT,
        source_count INTEGER DEFAULT 0,
        total_duration REAL DEFAULT 0,
        expires_at TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      )`,
      args: [],
    },
    {
      sql: `CREATE TABLE IF NOT EXISTS merge_sources (
        job_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        kind TEXT NOT NULL,
        url TEXT,
        name TEXT,
        size INTEGER,
        mime TEXT,
        status TEXT DEFAULT 'pending',
        duration REAL,
        width INTEGER,
        height INTEGER,
        fps REAL,
        has_audio INTEGER DEFAULT 0,
        PRIMARY KEY (job_id, seq)
      )`,
      args: [],
    },
    // أجزاء ملفات المصدر المرفوعة (Blobs مجزأة 2MB — حد HTTP في Turso).
    {
      sql: `CREATE TABLE IF NOT EXISTS source_chunks (
        job_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        chunk INTEGER NOT NULL,
        data BLOB NOT NULL,
        PRIMARY KEY (job_id, seq, chunk)
      )`,
      args: [],
    },
    // أجزاء الفيديو الناتج بعد الترميز.
    {
      sql: `CREATE TABLE IF NOT EXISTS output_chunks (
        job_id TEXT NOT NULL,
        chunk INTEGER NOT NULL,
        data BLOB NOT NULL,
        PRIMARY KEY (job_id, chunk)
      )`,
      args: [],
    },
  ]);
  schemaReady = true;
}

// فحص صحة قاعدة البيانات: SELECT 1
export async function dbHealthy(): Promise<boolean> {
  try {
    await ensureSchema();
    await db.execute("SELECT 1");
    return true;
  } catch {
    return false;
  }
}

// ================= أنواع المهام =================
export interface TaskRow {
  id: string;
  provider: string | null;
  provider_task_id: string | null;
  key_id: string | null;
  model: string;
  type: string;
  prompt: string;
  params_json: string;
  status: string;
  progress: number;
  result_urls_json: string | null;
  error_message: string | null;
  attempts_json: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface AttemptRecord {
  provider: string;
  keyId: string;
  keyLabel: string;
  ok: boolean;
  errorClass?: string;
  error?: string;
  at: string;
}

// إدراج مهمة جديدة قبل أي نداء خارجي (حتى تنقطع تبقى قابلة للتتبع).
export async function insertTask(t: {
  id: string;
  provider?: string | null;
  provider_task_id?: string | null;
  key_id?: string | null;
  model: string;
  type: string;
  prompt?: string;
  params_json?: string;
  status: string;
}): Promise<void> {
  await ensureSchema();
  await db.execute({
    sql: `INSERT INTO tasks (id, provider, provider_task_id, key_id, model, type, prompt, params_json, status, progress, attempts_json)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, '[]')`,
    args: [
      t.id,
      t.provider ?? null,
      t.provider_task_id ?? null,
      t.key_id ?? null,
      t.model,
      t.type,
      t.prompt ?? "",
      t.params_json ?? "{}",
      t.status,
    ],
  });
}

export async function getTask(id: string): Promise<TaskRow | null> {
  await ensureSchema();
  const r = await db.execute({ sql: "SELECT * FROM tasks WHERE id = ?", args: [id] });
  return (r.rows[0] as unknown as TaskRow) ?? null;
}

// تحديث جزئي للمهمة: يضبط updated_at دائمًا، ويضيف محاولة لـ attempts_json،
// ويضبط completed_at تلقائيًا عند الاكتمال أو الفشل النهائي.
export async function updateTask(
  id: string,
  patch: Partial<Omit<TaskRow, "id" | "created_at">> & { addAttempt?: AttemptRecord }
): Promise<void> {
  await ensureSchema();
  const cur = await getTask(id);
  if (!cur) return;
  const fields: string[] = ["updated_at = datetime('now')"];
  const args: (string | number | null)[] = [];
  for (const [k, v] of Object.entries(patch)) {
    if (k === "addAttempt") continue;
    if (k === "progress" || k === "usage_count" || k === "success_count" || k === "fail_count") {
      fields.push(`${k} = ?`);
      args.push(v as number);
    } else {
      fields.push(`${k} = ?`);
      args.push((v as string) ?? null);
    }
  }
  if (patch.addAttempt) {
    const attempts: AttemptRecord[] = JSON.parse(cur.attempts_json || "[]");
    attempts.push(patch.addAttempt);
    fields.push("attempts_json = ?");
    args.push(JSON.stringify(attempts));
  }
  // ضبط completed_at عند الاكتمال أو الفشل النهائي.
  if (patch.status === "completed" || patch.status === "failed") {
    fields.push("completed_at = datetime('now')");
  }
  args.push(id);
  await db.execute({ sql: `UPDATE tasks SET ${fields.join(", ")} WHERE id = ?`, args });
}

export async function listRecentTasks(
  limit = 20,
  filter: { type?: string; status?: string } = {}
): Promise<TaskRow[]> {
  await ensureSchema();
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (filter.type) {
    where.push("type = ?");
    args.push(filter.type);
  }
  if (filter.status) {
    where.push("status = ?");
    args.push(filter.status);
  }
  const wsql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  args.push(limit);
  const r = await db.execute({
    sql: `SELECT * FROM tasks ${wsql} ORDER BY created_at DESC, id DESC LIMIT ?`,
    args,
  });
  return r.rows as unknown as TaskRow[];
}

export async function taskStats(): Promise<{
  total: number;
  completed: number;
  failed: number;
  processing: number;
}> {
  await ensureSchema();
  const r = await db.execute({
    sql: `SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) AS completed,
      SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed,
      SUM(CASE WHEN status IN ('pending','processing') THEN 1 ELSE 0 END) AS processing
    FROM tasks`,
    args: [],
  });
  const row = r.rows[0] as Record<string, unknown>;
  return {
    total: Number(row.total ?? 0),
    completed: Number(row.completed ?? 0),
    failed: Number(row.failed ?? 0),
    processing: Number(row.processing ?? 0),
  };
}

// ================= عمليات المفاتيح =================
export interface ApiKeyRow {
  id: string;
  provider: string;
  label: string;
  api_key: string;
  status: string;
  usage_count: number;
  success_count: number;
  fail_count: number;
  last_used_at: string | null;
  last_checked_at: string | null;
  last_error: string | null;
  created_at: string;
}

export async function listApiKeys(): Promise<ApiKeyRow[]> {
  await ensureSchema();
  const r = await db.execute({
    sql: "SELECT * FROM api_keys ORDER BY created_at ASC, id ASC",
    args: [],
  });
  return r.rows as unknown as ApiKeyRow[];
}

export async function getApiKey(id: string): Promise<ApiKeyRow | null> {
  await ensureSchema();
  const r = await db.execute({ sql: "SELECT * FROM api_keys WHERE id = ?", args: [id] });
  return (r.rows[0] as unknown as ApiKeyRow) ?? null;
}

export async function findDuplicateKey(provider: string, apiKey: string): Promise<ApiKeyRow | null> {
  await ensureSchema();
  const r = await db.execute({
    sql: "SELECT * FROM api_keys WHERE provider = ? AND api_key = ? LIMIT 1",
    args: [provider, apiKey],
  });
  return (r.rows[0] as unknown as ApiKeyRow) ?? null;
}

export async function insertApiKey(
  provider: string,
  apiKey: string,
  label = ""
): Promise<ApiKeyRow> {
  await ensureSchema();
  const id = crypto.randomUUID();
  await db.execute({
    sql: "INSERT INTO api_keys (id, provider, label, api_key, status) VALUES (?, ?, ?, ?, 'active')",
    args: [id, provider, label, apiKey],
  });
  return (await getApiKey(id))!;
}

export async function updateApiKeyStatus(id: string, status: string): Promise<void> {
  await db.execute({
    sql: `UPDATE api_keys SET status = ?, last_checked_at = datetime('now') WHERE id = ?`,
    args: [status, id],
  });
}

export async function deleteApiKey(id: string): Promise<void> {
  await db.execute({ sql: "DELETE FROM api_keys WHERE id = ?", args: [id] });
}

// تسجيل استخدام مفتاح (عدّادات + آخر خطأ).
export async function recordKeyUsage(
  id: string,
  ok: boolean,
  errorMsg: string | null = null
): Promise<void> {
  await db.execute({
    sql: `UPDATE api_keys SET
      usage_count = usage_count + 1,
      success_count = success_count + ?,
      fail_count = fail_count + ?,
      last_used_at = datetime('now'),
      last_error = ?
    WHERE id = ?`,
    args: [ok ? 1 : 0, ok ? 0 : 1, errorMsg, id],
  });
}
