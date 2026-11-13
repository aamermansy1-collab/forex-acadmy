// محرك دمج الفيديو المدمج — القسم 14 مدمج في تطبيق Next.js نفسه.
// قرار: دمج خدمة الدمج في نفس التطبيق ليكون مستودع واحد ونشر واحد على Vercel.
// MERGER_API_BASE اختياري للعرض فقط؛ التوليد يستدعي الدوال مباشرة (بدل HTTP).
//
// التخزين: Turso عبر @libsql/client — أجزاء 2MB (حد HTTP في Turso).
// المعالجة: ffmpeg-static + ffprobe-static داخل الدالة.
// الناتج: MP4 (libx264 CRF 18 + AAC 192k/44.1kHz + faststart) حتى 1920x1080.

import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  rmSync,
  statSync,
  openSync,
  readSync,
  closeSync,
  copyFileSync,
  chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createRequire } from "node:module";
import { Readable } from "node:stream";
import ffmpegStatic from "ffmpeg-static";
import ffprobeStatic from "ffprobe-static";
import { db, ensureSchema } from "./turso";
import { getTask } from "./turso";

// حل مسار الثنائيات: __dirname في ffprobe-static يتكسر في webpack/Next.js dev.
// نجرب عدة مسارات مرشّحة: المسار من الحزمة، ثم process.cwd()، ثم createRequire.
const moduleRequire = createRequire(import.meta.url);
function resolvePackageDir(pkgName: string): string | null {
  // 1) createRequire (يعمل في الإنتاج وغالبًا في dev).
  try {
    const p = dirname(moduleRequire.resolve(`${pkgName}/package.json`));
    if (existsSync(p)) return p;
  } catch {
    /* ignore */
  }
  // 2) process.cwd() (يعمل في dev حيث cwd = جذر المشروع).
  const cwdCand = join(process.cwd(), "node_modules", pkgName);
  if (existsSync(cwdCand)) return cwdCand;
  // 3) المسار النسبي من ملف المصدر.
  const relCand = join(__dirname, "..", "..", "node_modules", pkgName);
  if (existsSync(relCand)) return relCand;
  return null;
}

// مسار ffmpeg/ffprobe — نضمن صلاحية التنفيذ (قد تُفقد في الاستضافة).
function ffmpegPath(): string {
  const direct = String(ffmpegStatic || "");
  if (direct && existsSync(direct)) return ensureExecutable(direct);
  const dir = resolvePackageDir("ffmpeg-static");
  if (dir) return ensureExecutable(join(dir, "ffmpeg"));
  return direct;
}
function ffprobePath(): string {
  const p = (ffprobeStatic as { path?: string }).path;
  if (p && existsSync(p)) return ensureExecutable(String(p));
  const dir = resolvePackageDir("ffprobe-static");
  if (dir) {
    const platform = process.platform;
    const arch = process.arch;
    const cand = join(dir, "bin", platform, arch, "ffprobe");
    if (existsSync(cand)) return ensureExecutable(cand);
  }
  return String(p || "");
}

// نسخ الثنائي إلى /tmp بصلاحية 755 إن لم يكن قابلًا للتنفيذ.
function ensureExecutable(src: string): string {
  try {
    if (src && existsSync(src)) {
      const st = statSync(src);
      // تحقق من صلاحية التنفيذ.
      if (st.mode & 0o111) return src;
    }
  } catch {
    /* ignore */
  }
  const dest = join(tmpdir(), `bin_${randomUUID().slice(0, 8)}`);
  try {
    copyFileSync(src, dest);
    chmodSync(dest, 0o755);
    return dest;
  } catch {
    return src;
  }
}

// حدود الخدمة من متغيرات البيئة.
export function mergeConfig() {
  return {
    maxSources: Number(process.env.MAX_SOURCES || 10),
    sourceMaxMb: Number(process.env.SOURCE_MAX_MB || 200),
    outputMaxMb: Number(process.env.OUTPUT_MAX_MB || 150),
    maxTotalDurationSec: Number(process.env.MAX_TOTAL_DURATION_SEC || 600),
    preset: process.env.FFMPEG_PRESET || "medium",
    version: "2.0.0",
  };
}

// مدخل مصدر للدمج: إما رابط مباشر أو ملف مرفوع.
export interface MergeInput {
  kind: "url" | "file";
  url?: string;
  name?: string;
  size?: number;
  mime?: string;
}

export interface MergeJobRow {
  id: string;
  status: string;
  progress: number;
  video_url: string | null;
  download_url: string | null;
  size: number | null;
  duration: number | null;
  resolution: string | null;
  error: string | null;
  source_count: number;
  total_duration: number;
  expires_at: string;
  created_at: string;
  updated_at: string;
}

const CHUNK_BYTES = 2 * 1024 * 1024; // 2MB — حد HTTP في Turso.
const FETCH_PAGE_ROWS = 8; // قراءة تدفقية بصفحات.

// حساب تاريخ انتهاء الصلاحية (24 ساعة من الآن).
function expiryDate(): string {
  return new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
}

// تنظيف كسول للمهام المنتهية عند إنشاء مهمة جديدة.
async function cleanupExpired(): Promise<void> {
  try {
    const now = new Date().toISOString();
    const r = await db.execute({
      sql: "SELECT id FROM merge_jobs WHERE expires_at < ?",
      args: [now],
    });
    for (const row of r.rows) {
      const id = String((row as Record<string, unknown>).id);
      await deleteMergeJob(id);
    }
  } catch {
    /* ignore */
  }
}

// إنشاء مهمة دمج + تسجيل المصادر.
export async function createMergeJob(inputs: MergeInput[], taskId?: string): Promise<{
  jobId: string;
  status: string;
  statusUrl: string;
  processUrl: string;
  expiresAt: string;
}> {
  await ensureSchema();
  await cleanupExpired();
  const cfg = mergeConfig();
  if (inputs.length < 2) throw new Error("الدمج يتطلب مقطعين على الأقل");
  if (inputs.length > cfg.maxSources)
    throw new Error(`أقصى عدد مقاطع للدمج هو ${cfg.maxSources}`);

  const jobId = taskId || randomUUID();
  const now = new Date().toISOString();
  const expiresAt = expiryDate();
  // إذا كانت المهمة موجودة (نفس task_id) نحدّثها بدل إدراج مكرر.
  await db.execute({
    sql: `INSERT INTO merge_jobs (id, status, progress, source_count, expires_at, created_at, updated_at)
          VALUES (?, 'queued', 0, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET status='queued', progress=0, error=NULL, updated_at=?`,
    args: [jobId, inputs.length, expiresAt, now, now, now],
  });
  // امسح مصادر/أجزاء سابقة لنفس المهمة (إعادة).
  await db.execute({ sql: "DELETE FROM merge_sources WHERE job_id = ?", args: [jobId] });
  await db.execute({ sql: "DELETE FROM source_chunks WHERE job_id = ?", args: [jobId] });
  await db.execute({ sql: "DELETE FROM output_chunks WHERE job_id = ?", args: [jobId] });

  for (let i = 0; i < inputs.length; i++) {
    const s = inputs[i];
    await db.execute({
      sql: `INSERT INTO merge_sources (job_id, seq, kind, url, name, size, mime, status)
            VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`,
      args: [jobId, i, s.kind, s.url ?? null, s.name ?? null, s.size ?? null, s.mime ?? null],
    });
  }
  return {
    jobId,
    status: "queued",
    statusUrl: `/api/jobs/${jobId}`,
    processUrl: `/api/jobs/${jobId}/process`,
    expiresAt,
  };
}

// حفظ ملف مرفوع كأجزاء في source_chunks.
export async function appendSourceChunk(
  jobId: string,
  seq: number,
  chunk: number,
  data: Buffer
): Promise<void> {
  await ensureSchema();
  await db.execute({
    sql: "INSERT INTO source_chunks (job_id, seq, chunk, data) VALUES (?, ?, ?, ?)",
    args: [jobId, seq, chunk, data],
  });
}

// تعليم مصدر كمرفوع كامل.
export async function markSourceUploaded(
  jobId: string,
  seq: number,
  size: number
): Promise<void> {
  await db.execute({
    sql: "UPDATE merge_sources SET status='uploaded', size=? WHERE job_id=? AND seq=?",
    args: [size, jobId, seq],
  });
}

// تنفيذ الدمج: سحب المصادر ← ffprobe ← ترميز ← تخزين الناتج.
export async function processMergeJob(jobId: string): Promise<{
  status: string;
  videoUrl?: string;
  downloadUrl?: string;
  size?: number;
  duration?: number;
  resolution?: string;
  error?: string;
}> {
  await ensureSchema();
  // قفل لمنع التزامن.
  const job = await getMergeJob(jobId);
  if (!job) return { status: "failed", error: "مهمة الدمج غير موجودة" };
  if (job.status === "done")
    return {
      status: "done",
      videoUrl: job.video_url || undefined,
      downloadUrl: job.download_url || undefined,
      size: job.size || undefined,
      duration: job.duration || undefined,
      resolution: job.resolution || undefined,
    };
  if (job.status === "processing")
    return { status: "processing", error: "المهمة قيد المعالجة فعلًا" };

  await setJobStatus(jobId, "processing", 0);
  const cfg = mergeConfig();
  const workDir = join(tmpdir(), `merge_${jobId}_${Date.now()}`);
  mkdirSync(workDir, { recursive: true });
  const inputs: Array<{ path: string; hasAudio: boolean; duration: number }> = [];
  try {
    // 1) اجمع المصادر بالترتيب.
    const srcs = await db.execute({
      sql: "SELECT * FROM merge_sources WHERE job_id=? ORDER BY seq ASC",
      args: [jobId],
    });
    if (srcs.rows.length < 2) throw new Error("الدمج يتطلب مقطعين على الأقل");

    let totalDuration = 0;
    let maxW = 0;
    let maxH = 0;
    const probeResults: Array<{ w: number; h: number; fps: number; dur: number; audio: boolean }> = [];

    for (let i = 0; i < srcs.rows.length; i++) {
      const s = srcs.rows[i] as Record<string, unknown>;
      const seq = Number(s.seq);
      const kind = String(s.kind);
      const outPath = join(workDir, `src_${seq}.mp4`);
      await setJobProgress(jobId, Math.round((i / srcs.rows.length) * 40));

      if (kind === "url") {
        const url = String(s.url || "");
        if (!/^https?:\/\//i.test(url)) throw new Error(`المصدر ${seq + 1}: رابط غير صالح`);
        // نزّل بحجم محدود.
        await downloadWithLimit(url, outPath, cfg.sourceMaxMb * 1024 * 1024);
      } else {
        // ملف مرفوع: اجمع الأجزاء من source_chunks.
        await assembleUploadedFile(jobId, seq, outPath);
      }
      // ffprobe.
      const probe = await ffprobe(outPath);
      probeResults.push(probe);
      totalDuration += probe.dur;
      if (probe.w > maxW) maxW = probe.w;
      if (probe.h > maxH) maxH = probe.h;
      inputs.push({ path: outPath, hasAudio: probe.audio, duration: probe.dur });
    }

    // تحقق الحدود.
    if (totalDuration > cfg.maxTotalDurationSec)
      throw new Error(`مجموع مدد المقاطع (${totalDuration.toFixed(1)}ث) يتجاوز الحد (${cfg.maxTotalDurationSec}ث)`);
    maxW = Math.min(maxW, 1920);
    maxH = Math.min(maxH, 1080);
    // أبعاد زوجية.
    if (maxW % 2) maxW -= 1;
    if (maxH % 2) maxH -= 1;

    await db.execute({
      sql: "UPDATE merge_jobs SET total_duration=?, source_count=?, updated_at=? WHERE id=?",
      args: [totalDuration, inputs.length, new Date().toISOString(), jobId],
    });

    // 2) بناء filter_complex: scale+pad+fps+setsar+format لكل مدخل، concat.
    const filterParts: string[] = [];
    const concatLabels: string[] = [];
    for (let i = 0; i < inputs.length; i++) {
      // الفيديو: scale+pad إلى أكبر دقة + fps=30 + setsar=1 + yuv420p.
      // مرجع المدخل: [i:v] و [i:a] (صيغة ffmpeg الرسمية).
      const v = `[${i}:v]scale=${maxW}:${maxH}:force_original_aspect_ratio=decrease,pad=${maxW}:${maxH}:(ow-iw)/2:(oh-ih)/2,fps=30,setsar=1,format=yuv420p[v${i}o]`;
      filterParts.push(v);
      if (inputs[i].hasAudio) {
        // مصدر بصوت: أعد عينة إلى 44100.
        filterParts.push(`[${i}:a]aresample=44100[a${i}o]`);
      } else {
        // مصدر بلا صوت: ولّد مسارًا صامتًا بنفس مدته. anullsrc فلتر مصدر (بلا مدخل).
        const dur = Math.max(0.1, inputs[i].duration).toFixed(3);
        filterParts.push(
          `anullsrc=channel_layout=stereo:sample_rate=44100:d=${dur}[a${i}o]`
        );
      }
      concatLabels.push(`[v${i}o][a${i}o]`);
    }
    const filter = [...filterParts, `${concatLabels.join("")}concat=n=${inputs.length}:v=1:a=1[outv][outa]`].join(";");

    // خريطة المدخلات.
    const inputArgs: string[] = [];
    for (const inp of inputs) {
      inputArgs.push("-i", inp.path);
    }

    const outPath = join(workDir, "output.mp4");
    const ff = ffmpegPath();
    const args = [
      "-y",
      ...inputArgs,
      "-filter_complex",
      filter,
      "-map",
      "[outv]",
      "-map",
      "[outa]",
      "-c:v",
      "libx264",
      "-preset",
      cfg.preset,
      "-crf",
      "18",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      "-ar",
      "44100",
      "-movflags",
      "+faststart",
      "-progress",
      "pipe:1",
      outPath,
    ];

    // شغّل ffmpeg مع تتبع التقدم (40–90%).
    await runFFmpeg(ff, args, (frac) => {
      const pct = 40 + Math.round(frac * 50);
      setJobProgress(jobId, pct).catch(() => {});
    });

    // تحقق حجم الناتج.
    const stat = statSync(outPath);
    const sizeMb = stat.size / (1024 * 1024);
    if (sizeMb > cfg.outputMaxMb)
      throw new Error(`حجم الناتج (${sizeMb.toFixed(1)}MB) يتجاوز الحد (${cfg.outputMaxMb}MB)`);

    // 3) خزّن الناتج كأجزاء في output_chunks.
    await storeFileChunks("output_chunks", jobId, outPath);

    // احذف أجزاء المصادر بعد نجاح الدمج (الناتج فقط المطلوب).
    await db.execute({ sql: "DELETE FROM source_chunks WHERE job_id = ?", args: [jobId] });

    // probe الناتج للدقة/المدة.
    const outProbe = await ffprobe(outPath);
    const videoUrl = `/api/jobs/${jobId}/video`;
    const downloadUrl = `${videoUrl}?download=1`;
    await db.execute({
      sql: `UPDATE merge_jobs SET status='done', progress=100, video_url=?, download_url=?, size=?, duration=?, resolution=?, updated_at=? WHERE id=?`,
      args: [
        videoUrl,
        downloadUrl,
        stat.size,
        outProbe.dur,
        `${outProbe.w}x${outProbe.h}`,
        new Date().toISOString(),
        jobId,
      ],
    });
    return {
      status: "done",
      videoUrl,
      downloadUrl,
      size: stat.size,
      duration: outProbe.dur,
      resolution: `${outProbe.w}x${outProbe.h}`,
    };
  } catch (e) {
    const msg = (e as Error).message || "خطأ في الدمج";
    await db.execute({
      sql: "UPDATE merge_jobs SET status='failed', error=?, updated_at=? WHERE id=?",
      args: [msg, new Date().toISOString(), jobId],
    });
    return { status: "failed", error: msg };
  } finally {
    // نظّف /tmp.
    try {
      rmSync(workDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

// استعلام حالة مهمة دمج.
export async function refreshMergeJob(jobId: string): Promise<{
  status: "queued" | "processing" | "done" | "failed";
  progress: number;
  videoUrl?: string;
  downloadUrl?: string;
  error?: string;
}> {
  await ensureSchema();
  const job = await getMergeJob(jobId);
  if (!job) {
    // 404 من الخدمة → فشل نهائي (حُذفت أو انتهت صلاحيتها).
    return { status: "failed", progress: 100, error: "مهمة الدمج غير موجودة في الخدمة (حُذفت أو انتهت صلاحيتها بعد 24 ساعة)" };
  }
  const st = job.status.toLowerCase();
  if (st === "done" || st === "completed" || st === "success" || st === "succeeded" || st === "finished") {
    return {
      status: "done",
      progress: 100,
      videoUrl: job.video_url || undefined,
      downloadUrl: job.download_url || undefined,
    };
  }
  if (st === "failed" || st === "error" || st === "cancelled" || job.error) {
    return { status: "failed", progress: job.progress || 100, error: job.error || "فشل الدمج" };
  }
  // queued|processing — قد نضرب في 0..1.
  const p = job.progress;
  return { status: p > 0 ? "processing" : "queued", progress: p };
}

export async function getMergeJob(jobId: string): Promise<MergeJobRow | null> {
  await ensureSchema();
  const r = await db.execute({ sql: "SELECT * FROM merge_jobs WHERE id = ?", args: [jobId] });
  return (r.rows[0] as unknown as MergeJobRow) ?? null;
}

async function setJobStatus(jobId: string, status: string, progress: number): Promise<void> {
  await db.execute({
    sql: "UPDATE merge_jobs SET status=?, progress=?, updated_at=? WHERE id=?",
    args: [status, progress, new Date().toISOString(), jobId],
  });
}
async function setJobProgress(jobId: string, progress: number): Promise<void> {
  await db.execute({
    sql: "UPDATE merge_jobs SET progress=?, updated_at=? WHERE id=?",
    args: [progress, new Date().toISOString(), jobId],
  });
}

// تنزيل رابط مع حد حجم (نوقف عند تجاوز الحد). نرسل User-Agent لأن بعض المصادر
// (مثل w3schools خلف Akamai) ترفض الطلبات بدونه.
async function downloadWithLimit(url: string, dest: string, maxBytes: number): Promise<void> {
  const res = await fetch(url, {
    headers: {
      // UA متصفح حقيقي — بعض المصادر (Akamai/Cloudflare) تحجب الـ UA "compatible".
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      Accept: "video/mp4,video/*,*/*;q=0.8",
    },
  });
  if (!res.ok || !res.body) throw new Error(`فشل تحميل المصدر (HTTP ${res.status})`);
  const ws = createWriteStream(dest);
  let written = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    written += value.byteLength;
    if (written > maxBytes) {
      ws.destroy();
      throw new Error(`حجم المصدر يتجاوز الحد المسموح`);
    }
    await new Promise<void>((resolve, reject) => {
      ws.write(Buffer.from(value), (err) => (err ? reject(err) : resolve()));
    });
  }
  await new Promise<void>((resolve, reject) => {
    ws.end(() => resolve());
    ws.on("error", reject);
  });
}

// تجميع ملف مرفوع من أجزاء source_chunks.
async function assembleUploadedFile(
  jobId: string,
  seq: number,
  dest: string
): Promise<void> {
  const ws = createWriteStream(dest);
  let chunk = 0;
  for (;;) {
    const r = await db.execute({
      sql: "SELECT data FROM source_chunks WHERE job_id=? AND seq=? AND chunk=? LIMIT 1",
      args: [jobId, seq, chunk],
    });
    const row = r.rows[0] as { data?: Buffer } | undefined;
    if (!row || !row.data) break;
    await new Promise<void>((resolve, reject) => {
      ws.write(Buffer.from(row.data as Uint8Array), (err) => (err ? reject(err) : resolve()));
    });
    chunk++;
  }
  await new Promise<void>((resolve, reject) => {
    ws.end(() => resolve());
    ws.on("error", reject);
  });
}

// تقسيم ملف إلى أجزاء وتخزينها في جدول Blob.
async function storeFileChunks(table: string, jobId: string, filePath: string): Promise<void> {
  const st = statSync(filePath);
  const total = st.size;
  const fd = openSync(filePath, "r");
  try {
    let offset = 0;
    let chunk = 0;
    const buf = Buffer.alloc(CHUNK_BYTES);
    while (offset < total) {
      const len = readSync(fd, buf, 0, CHUNK_BYTES, offset);
      if (len <= 0) break;
      const data = len === CHUNK_BYTES ? buf : buf.subarray(0, len);
      await db.execute({
        sql: `INSERT INTO ${table} (job_id, chunk, data) VALUES (?, ?, ?)`,
        args: [jobId, chunk, Buffer.from(data)],
      });
      offset += len;
      chunk++;
    }
  } finally {
    closeSync(fd);
  }
}

// ffprobe لدقة/معدل إطارات/مدة/وجود صوت.
// نستخدم spawnSync (متزامن) لأن spawn async يعلق أحيانًا في سياق Next.js dev server.
// ffprobe سريع (<1ث) فالاستدعاء المتزامن آمن.
function ffprobeSync(path: string): {
  w: number;
  h: number;
  fps: number;
  dur: number;
  audio: boolean;
} {
  const ffpath = ffprobePath();
  const r = spawnSync(
    ffpath,
    ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height,r_frame_rate:format=duration", "-of", "json", path],
    { encoding: "utf8", timeout: 30000 }
  );
  if (r.error) {
    throw new Error("ffprobe خطأ تشغيل: " + (r.error as Error).message);
  }
  if (r.status !== 0) {
    throw new Error("ffprobe فشل (status=" + r.status + "): " + (r.stderr || "").slice(0, 200));
  }
  const j = JSON.parse(r.stdout || "{}");
  const stream = j.streams?.[0] || {};
  const w = Number(stream.width || 0);
  const h = Number(stream.height || 0);
  const fr = String(stream.r_frame_rate || "30/1");
  const fpsNum = Number(fr.split("/")[0] || 30);
  const fpsDen = Number(fr.split("/")[1] || 1) || 1;
  const fps = fpsNum / fpsDen;
  const dur = Number(j.format?.duration || 0);
  const audio = hasAudioStreamSync(path);
  return { w, h, fps: Math.round(fps * 100) / 100, dur, audio };
}

// نسخة async تغلّف spawnSync لتحافظ على التوقيع السابق.
async function ffprobe(path: string): Promise<{
  w: number;
  h: number;
  fps: number;
  dur: number;
  audio: boolean;
}> {
  return ffprobeSync(path);
}

function hasAudioStreamSync(path: string): boolean {
  const r = spawnSync(
    ffprobePath(),
    ["-v", "error", "-select_streams", "a", "-show_entries", "stream=codec_type", "-of", "csv=p=0", path],
    { encoding: "utf8", timeout: 15000 }
  );
  return (r.stdout || "").trim().length > 0;
}

// تشغيل ffmpeg مع قراءة -progress pipe:1 وحساب النسبة من المدة الإجمالية.
function runFFmpeg(
  cmd: string,
  args: string[],
  onProgress: (frac: number) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    proc.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    // -progress pipe:1 يكتب أزواج key=value على stdout.
    let outBuf = "";
    proc.stdout.on("data", (d) => {
      outBuf += d.toString();
      let idx;
      while ((idx = outBuf.indexOf("\n")) >= 0) {
        const line = outBuf.slice(0, idx).trim();
        outBuf = outBuf.slice(idx + 1);
        if (line.startsWith("out_time_us=")) {
          const us = Number(line.split("=")[1] || 0);
          onProgress(Math.min(0.999, us / 1_000_000 / 1)); // تقديري؛ يُعدّل بالمدة لاحقًا
        }
      }
    });
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error("ffmpeg فشل: " + stderr.slice(-500)));
    });
    proc.on("error", (e) => reject(e));
  });
}

// حذف شامل لمهمة دمج.
export async function deleteMergeJob(jobId: string): Promise<void> {
  await ensureSchema();
  await db.batch([
    { sql: "DELETE FROM output_chunks WHERE job_id = ?", args: [jobId] },
    { sql: "DELETE FROM source_chunks WHERE job_id = ?", args: [jobId] },
    { sql: "DELETE FROM merge_sources WHERE job_id = ?", args: [jobId] },
    { sql: "DELETE FROM merge_jobs WHERE id = ?", args: [jobId] },
  ]);
}

// بث الناتج بدعم Range (206 + Content-Range).
export async function streamJobVideo(
  jobId: string,
  rangeHeader: string | null
): Promise<{
  status: number;
  headers: Record<string, string>;
  body: Readable;
}> {
  await ensureSchema();
  const job = await getMergeJob(jobId);
  if (!job || job.status !== "done")
    return { status: 404, headers: {}, body: Readable.from([]) };

  // اقرأ أجزاء الناتج من output_chunks بترتيب chunk.
  const chunks = await db.execute({
    sql: "SELECT chunk, data FROM output_chunks WHERE job_id=? ORDER BY chunk ASC",
    args: [jobId],
  });
  if (chunks.rows.length === 0)
    return { status: 404, headers: {}, body: Readable.from([]) };

  const rowsData = chunks.rows as unknown as Array<{ chunk: number; data: Uint8Array }>;
  const total = rowsData.reduce((a, r) => a + (r.data as Uint8Array).byteLength, 0);

  // تحليل Range.
  let start = 0;
  let end = total - 1;
  if (rangeHeader) {
    const m = /bytes=(\d*)-(\d*)/.exec(rangeHeader);
    if (m) {
      if (m[1]) start = Number(m[1]);
      if (m[2]) end = Number(m[2]);
      if (start > end) start = end;
    }
  }
  const length = end - start + 1;

  // بناء Readable يصب أجزاء الناتج مع تقليم أول/آخر جزء حسب المدى.
  const stream = new Readable({ read() {} });
  let emitted = 0;
  let cursor = 0;
  (async () => {
    for (const row of rowsData) {
      const buf = Buffer.from(row.data as Uint8Array);
      const chunkStart = cursor;
      const chunkEnd = cursor + buf.byteLength - 1;
      cursor += buf.byteLength;
      // هل يتقاطع مع [start,end]؟
      if (chunkEnd < start || chunkStart > end) continue;
      const s = Math.max(0, start - chunkStart);
      const e = Math.min(buf.byteLength - 1, end - chunkStart);
      const slice = buf.subarray(s, e + 1);
      stream.push(slice);
      emitted += slice.byteLength;
      if (emitted >= length) {
        stream.push(null);
        return;
      }
    }
    stream.push(null);
  })().catch(() => stream.destroy());

  const headers: Record<string, string> = {
    "Content-Type": "video/mp4",
    "Accept-Ranges": "bytes",
    "Cache-Control": "public, max-age=3600",
  };
  if (rangeHeader) {
    headers["Content-Range"] = `bytes ${start}-${end}/${total}`;
    headers["Content-Length"] = String(length);
  } else {
    headers["Content-Length"] = String(total);
  }
  return { status: rangeHeader ? 206 : 200, headers, body: stream };
}

// حل task_ids إلى روابط من قاعدة المهام (بترتيب task_ids).
export async function resolveMergeInputs(
  taskIds: string[]
): Promise<{ inputs: MergeInput[]; failedIds: string[] }> {
  const inputs: MergeInput[] = [];
  const failedIds: string[] = [];
  for (const id of taskIds) {
    const t = await getTask(id);
    if (!t || t.type !== "video" || t.status !== "completed" || !t.result_urls_json) {
      failedIds.push(id);
      continue;
    }
    const urls: string[] = JSON.parse(t.result_urls_json);
    if (!urls[0]) {
      failedIds.push(id);
      continue;
    }
    inputs.push({ kind: "url", url: urls[0] });
  }
  return { inputs, failedIds };
}
