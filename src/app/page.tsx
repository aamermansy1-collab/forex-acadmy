"use client";

// لوحة الإدارة العربية RTL — ثلاث بطاقات: المفاتيح + المهام + ربط السيرفر.
// تتجدد تلقائيًا كل 5 ثوانٍ للمهام.

import { useCallback, useEffect, useRef, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { toast } from "sonner";
import {
  Activity,
  CheckCircle2,
  Copy,
  KeyRound,
  ListVideo,
  Plug,
  Plus,
  RefreshCw,
  Trash2,
  XCircle,
  ExternalLink,
  Loader2,
  Wand2,
  ImageIcon,
  VideoIcon,
} from "lucide-react";
import { Switch } from "@/components/ui/switch";

// ===== أنواع =====
interface KeyRow {
  id: string;
  provider: string;
  label: string;
  masked: string;
  status: string;
  usage_count: number;
  success_count: number;
  fail_count: number;
  last_used_at: string | null;
  last_checked_at: string | null;
  last_error: string | null;
  created_at: string;
}
interface TaskRow {
  id: string;
  type: string;
  status: string;
  progress: number;
  model: string;
  provider: string | null;
  prompt: string;
  result_urls: string[];
  error_message: string | null;
  attempts: unknown[];
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}
interface Stats {
  total: number;
  completed: number;
  failed: number;
  processing: number;
}
interface Health {
  ok: boolean;
  database: string;
  mcpEndpoint: string;
  models: { canonical: string; type: string; providers: string[] }[];
  merger: { base: string; healthy: boolean };
  authRequired: boolean;
}

const STATUS_LABEL: Record<string, string> = {
  active: "نشط",
  exhausted: "مستنزف",
  disabled: "معطّل",
  pending: "بالانتظار",
  processing: "قيد المعالجة",
  completed: "مكتمل",
  failed: "فاشل",
};
const STATUS_COLOR: Record<string, string> = {
  active: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/30",
  completed: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/30",
  exhausted: "bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-500/30",
  pending: "bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-500/30",
  processing: "bg-blue-500/15 text-blue-700 dark:text-blue-400 border-blue-500/30",
  disabled: "bg-zinc-500/15 text-zinc-600 dark:text-zinc-400 border-zinc-500/30",
  failed: "bg-red-500/15 text-red-700 dark:text-red-400 border-red-500/30",
};
const TYPE_LABEL: Record<string, string> = {
  image: "صورة",
  video: "فيديو",
  merge: "دمج",
};

export default function Home() {
  const [health, setHealth] = useState<Health | null>(null);
  const [keys, setKeys] = useState<KeyRow[]>([]);
  const [tasks, setTasks] = useState<TaskRow[]>([]);
  const [stats, setStats] = useState<Stats>({ total: 0, completed: 0, failed: 0, processing: 0 });
  const [origin, setOrigin] = useState("");

  // نموذج إضافة مفتاح.
  const [newProvider, setNewProvider] = useState("kie");
  const [newLabel, setNewLabel] = useState("");
  const [newKey, setNewKey] = useState("");
  const [adding, setAdding] = useState(false);

  const fetchHealth = useCallback(async () => {
    try {
      const r = await fetch("/api/health");
      const d = await r.json();
      setHealth(d);
    } catch {
      setHealth(null);
    }
  }, []);

  const fetchKeys = useCallback(async () => {
    try {
      const r = await fetch("/api/keys");
      const d = await r.json();
      setKeys(d.keys || []);
    } catch {
      /* ignore */
    }
  }, []);

  const fetchTasks = useCallback(async () => {
    try {
      const r = await fetch("/api/tasks?limit=20");
      const d = await r.json();
      setTasks(d.tasks || []);
      setStats(d.stats || { total: 0, completed: 0, failed: 0, processing: 0 });
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    setOrigin(window.location.origin);
    fetchHealth();
    fetchKeys();
    fetchTasks();
    // لوحة المهام تتحدث تلقائيًا كل ~5 ثوانٍ.
    const t = setInterval(fetchTasks, 5000);
    return () => clearInterval(t);
  }, [fetchHealth, fetchKeys, fetchTasks]);

  const addKey = async () => {
    if (!newKey.trim()) {
      toast.error("أدخل المفتاح");
      return;
    }
    setAdding(true);
    try {
      const r = await fetch("/api/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: newProvider, api_key: newKey.trim(), label: newLabel.trim() }),
      });
      const d = await r.json();
      if (!r.ok) {
        toast.error(d.error || "فشل الإضافة");
        return;
      }
      toast.success("تمت إضافة المفتاح");
      setNewKey("");
      setNewLabel("");
      fetchKeys();
    } catch {
      toast.error("خطأ في الشبكة");
    } finally {
      setAdding(false);
    }
  };

  const setKeyStatus = async (id: string, status: string) => {
    const r = await fetch(`/api/keys/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
    if (r.ok) {
      toast.success(status === "active" ? "تم التنشيط" : status === "disabled" ? "تم التعطيل" : "تم التحديث");
      fetchKeys();
    } else {
      toast.error("فشل التحديث");
    }
  };
  const deleteKey = async (id: string) => {
    const r = await fetch(`/api/keys/${id}`, { method: "DELETE" });
    if (r.ok) {
      toast.success("تم الحذف");
      fetchKeys();
    } else {
      toast.error("فشل الحذف");
    }
  };

  const copy = (text: string, msg = "تم النسخ") => {
    navigator.clipboard.writeText(text).then(() => toast.success(msg));
  };

  // ===== حالة توليد الوسائط المباشر =====
  const [genType, setGenType] = useState<"image" | "video">("image");
  const [genPrompt, setGenPrompt] = useState("");
  const [genAspect, setGenAspect] = useState("1:1");
  const [genResolution, setGenResolution] = useState("1K");
  const [genDuration, setGenDuration] = useState(8);
  const [genAudio, setGenAudio] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [genResult, setGenResult] = useState<{
    isCompleted?: boolean;
    isProcessing?: boolean;
    isError?: boolean;
    progress?: number;
    urls?: string[];
    taskId?: string;
    message?: string;
  } | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPolling = () => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  };
  useEffect(() => () => stopPolling(), []);

  const pollTask = (taskId: string) => {
    stopPolling();
    pollRef.current = setInterval(async () => {
      try {
        const r = await fetch(`/api/tasks/${taskId}`);
        const d = await r.json();
        setGenResult({
          isCompleted: d.isCompleted,
          isProcessing: d.isProcessing,
          isError: d.isError,
          progress: d.progress,
          urls: d.urls,
          taskId,
          message: d.message,
        });
        if (d.isCompleted || d.isError) {
          stopPolling();
          setGenerating(false);
          fetchTasks();
        }
      } catch {
        /* ignore */
      }
    }, 6000);
  };

  const generate = async () => {
    if (!genPrompt.trim()) {
      toast.error("اكتب وصف الصورة/الفيديو أولًا");
      return;
    }
    setGenerating(true);
    setGenResult(null);
    try {
      const payload: Record<string, unknown> = {
        type: genType,
        prompt: genPrompt.trim(),
        aspect_ratio: genAspect,
      };
      if (genType === "image") {
        payload.resolution = genResolution;
      } else {
        payload.resolution = genResolution === "1K" ? "480p" : genResolution === "2K" ? "720p" : "1080p";
        payload.duration = genDuration;
        payload.enable_audio = genAudio;
      }
      const r = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const d = await r.json();
      if (!r.ok) {
        toast.error(d.error || "فشل التوليد");
        setGenerating(false);
        return;
      }
      setGenResult(d);
      if (d.isProcessing && d.taskId) {
        // استطلع حتى الاكتمال.
        pollTask(d.taskId);
      } else {
        setGenerating(false);
        fetchTasks();
      }
    } catch {
      toast.error("خطأ في الشبكة");
      setGenerating(false);
    }
  };

  const mcpUrl = origin ? `${origin}/mcp` : "/mcp";
  const authHeader = health?.authRequired
    ? `, "headers": {"Authorization": "Bearer <MCP_ACCESS_TOKEN>"}`
    : "";
  const jsonChatgpt = `{"mcpServers":{"media-generator":{"url":"${mcpUrl}"${authHeader}}}}`;
  const jsonClaude = `{"mcpServers":{"media-generator":{"url":"${mcpUrl}","type":"http"${authHeader}}}}`;
  const jsonCursor = `{"mcpServers":{"media-generator":{"url":"${mcpUrl}"${authHeader}}}}`;

  const tools = [
    { name: "generate_image", desc: "توليد صورة من وصف نصي بـ gpt-image-2-6/flare-text-to-image." },
    { name: "generate_video", desc: "توليد فيديو بصوت متزامن بـ grok-imagine-video-1-5-preview." },
    { name: "merge_videos", desc: "دمج عدة مقاطع في فيديو واحد بالترتيب المطلوب (urls أو task_ids)." },
    { name: "get_task", desc: "تتبع أي مهمة بمعرّفها كل ~10 ثوانٍ حتى الاكتمال أو الفشل." },
    { name: "list_media", desc: "استرجاع أحدث الصور/الفيديوهات/الدمجات المخزنة بروابطها." },
  ];

  return (
    <div className="min-h-screen flex flex-col bg-gradient-to-b from-background to-muted/30">
      {/* الهيدر */}
      <header className="sticky top-0 z-40 border-b bg-background/80 backdrop-blur">
        <div className="mx-auto max-w-7xl px-4 py-3 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="size-9 rounded-xl bg-gradient-to-br from-sky-500 to-violet-500 grid place-items-center text-white shadow-sm">
              <Activity className="size-5" />
            </div>
            <div>
              <h1 className="text-base font-bold leading-tight">مولّد الوسائط MCP</h1>
              <p className="text-xs text-muted-foreground">إدارة المفاتيح والمهام ودمج الفيديو</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={() => { fetchHealth(); fetchKeys(); fetchTasks(); }}>
              <RefreshCw className="size-4" />
              تحديث
            </Button>
            {health ? (
              <Badge className={health.database === "turso-connected" ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/30" : "bg-red-500/15 text-red-700 dark:text-red-400 border-red-500/30"}>
                {health.database === "turso-connected" ? "Turso متصل" : "Turso غير متصل"}
              </Badge>
            ) : (
              <Badge variant="outline"><Loader2 className="size-3 animate-spin" /> فحص…</Badge>
            )}
          </div>
        </div>
      </header>

      {/* المحتوى */}
      <main className="mx-auto max-w-7xl w-full px-4 py-6 flex-1">
        {/* بطاقة توليد الوسائط المباشر */}
        <Card className="mb-6 border-sky-500/20">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Wand2 className="size-4 text-sky-500" /> توليد وسائط
            </CardTitle>
            <CardDescription className="text-xs">
              ولّد صورة أو فيديو مباشرة من هنا — بدون الحاجة لربط ChatGPT أو أي عميل.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* اختيار النوع */}
            <div className="flex gap-2">
              <Button
                type="button"
                variant={genType === "image" ? "default" : "outline"}
                className="flex-1 h-10"
                onClick={() => { setGenType("image"); setGenResolution("1K"); setGenResult(null); stopPolling(); setGenerating(false); }}
              >
                <ImageIcon className="size-4" /> صورة
              </Button>
              <Button
                type="button"
                variant={genType === "video" ? "default" : "outline"}
                className="flex-1 h-10"
                onClick={() => { setGenType("video"); setGenResolution("2K"); setGenResult(null); stopPolling(); setGenerating(false); }}
              >
                <VideoIcon className="size-4" /> فيديو
              </Button>
            </div>

            {/* البرومبت */}
            <div className="space-y-1">
              <Label className="text-xs">الوصف (Prompt)</Label>
              <Textarea
                value={genPrompt}
                onChange={(e) => setGenPrompt(e.target.value)}
                placeholder={genType === "image" ? "مثال: قط أبيض يجلس على نافذة وقت الغروب، إضاءة ناعمة" : "مثال: موجات البحر تضرب الشاطئ وقت الغروب، صوت الموج واضح"}
                className="text-sm min-h-[80px]"
                dir="auto"
              />
            </div>

            {/* الخيارات */}
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
              <div className="space-y-1">
                <Label className="text-xs">نسبة العرض</Label>
                <Select value={genAspect} onValueChange={setGenAspect}>
                  <SelectTrigger className="h-9 text-sm"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {genType === "image"
                      ? ["auto","1:1","3:2","2:3","4:3","3:4","16:9","9:16","2:1","1:2"].map((v) => <SelectItem key={v} value={v}>{v}</SelectItem>)
                      : ["auto","1:1","16:9","9:16","3:2","2:3"].map((v) => <SelectItem key={v} value={v}>{v}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label className="text-xs">{genType === "image" ? "الدقة" : "الدقة"}</Label>
                <Select value={genResolution} onValueChange={setGenResolution}>
                  <SelectTrigger className="h-9 text-sm"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {genType === "image"
                      ? ["1K","2K","4K"].map((v) => <SelectItem key={v} value={v}>{v}</SelectItem>)
                      : ["480p","720p","1080p"].map((v) => <SelectItem key={v} value={v}>{v}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              {genType === "video" && (
                <div className="space-y-1">
                  <Label className="text-xs">المدة (ث)</Label>
                  <Select value={String(genDuration)} onValueChange={(v) => setGenDuration(Number(v))}>
                    <SelectTrigger className="h-9 text-sm"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {[5, 8, 10, 12, 15].map((v) => <SelectItem key={v} value={String(v)}>{v}ث</SelectItem>)}
                  </SelectContent>
                  </Select>
                </div>
              )}
            </div>

            {genType === "video" && (
              <div className="flex items-center justify-between rounded-lg border p-2.5">
                <Label className="text-xs">تفعيل الصوت</Label>
                <Switch checked={genAudio} onCheckedChange={setGenAudio} />
              </div>
            )}

            {/* زر التوليد */}
            <Button onClick={generate} disabled={generating} className="w-full h-10 text-sm">
              {generating ? (
                <><Loader2 className="size-4 animate-spin" /> جاري التوليد…</>
              ) : (
                <><Wand2 className="size-4" /> توليد {genType === "image" ? "صورة" : "فيديو"}</>
              )}
            </Button>

            {/* النتيجة */}
            {genResult && (
              <div className="rounded-lg border p-3 space-y-2 bg-muted/20">
                {/* قيد المعالجة */}
                {genResult.isProcessing && (
                  <div className="space-y-2">
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <Loader2 className="size-3.5 animate-spin" />
                      قيد المعالجة — التقدم: {genResult.progress || 0}%
                    </div>
                    <Progress value={genResult.progress || 0} className="h-1.5" />
                    <div className="text-[11px] text-muted-foreground">
                      الفيديو يحتاج دقائق — تابع الشريط أو انتظر ظهور الرابط تلقائيًا.
                      {genResult.taskId && <span className="font-mono block mt-1" dir="ltr">task_id: {genResult.taskId.slice(0, 12)}…</span>}
                    </div>
                  </div>
                )}
                {/* مكتمل */}
                {genResult.isCompleted && genResult.urls && genResult.urls.length > 0 && (
                  <div className="space-y-2">
                    {genType === "image" ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={genResult.urls[0]} alt="الناتج" className="w-full rounded-lg border max-h-[28rem] object-contain bg-muted" />
                    ) : (
                      <video src={genResult.urls[0]} controls className="w-full rounded-lg border max-h-[28rem] bg-black" />
                    )}
                    <div className="flex items-center gap-2">
                      <a href={genResult.urls[0]} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-sky-600 hover:underline" dir="ltr">
                        <ExternalLink className="size-3" /> {genResult.urls[0].length > 50 ? genResult.urls[0].slice(0, 50) + "…" : genResult.urls[0]}
                      </a>
                      <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => copy(genResult.urls![0], "نُسخ الرابط")}>
                        <Copy className="size-3" /> نسخ الرابط
                      </Button>
                    </div>
                  </div>
                )}
                {/* فشل */}
                {genResult.isError && (
                  <div className="flex items-start gap-2 text-xs text-red-600">
                    <XCircle className="size-4 mt-0.5 shrink-0" />
                    <span>{genResult.message}</span>
                  </div>
                )}
              </div>
            )}
          </CardContent>
        </Card>

        <div className="grid gap-6 lg:grid-cols-3">
          {/* (أ) مدير المفاتيح */}
          <Card className="lg:col-span-1">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <KeyRound className="size-4 text-sky-500" /> مدير المفاتيح
              </CardTitle>
              <CardDescription className="text-xs leading-relaxed">
                أضف عدة مفاتيح لكل مزود — التجربة تسلسلية (أول مفتاح ثم التالي ثم التالي) مع تبديل فوري
                تلقائي عند أي خطأ أو نفاد رصيد دون توقف.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* نموذج الإضافة */}
              <div className="space-y-3 rounded-lg border p-3 bg-muted/20">
                <div className="grid grid-cols-2 gap-2">
                  <div className="space-y-1">
                    <Label className="text-xs">المزود</Label>
                    <Select value={newProvider} onValueChange={setNewProvider}>
                      <SelectTrigger className="h-9 text-sm"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="kie">kie.ai</SelectItem>
                        <SelectItem value="cometapi">CometAPI</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">تسمية (اختياري)</Label>
                    <Input value={newLabel} onChange={(e) => setNewLabel(e.target.value)} placeholder="مثال: حساب العمل" className="h-9 text-sm" />
                  </div>
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">المفتاح</Label>
                  <Input value={newKey} onChange={(e) => setNewKey(e.target.value)} placeholder="sk-..." className="text-sm font-mono" dir="ltr" />
                </div>
                <Button onClick={addKey} disabled={adding} className="w-full h-9 text-sm">
                  {adding ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
                  إضافة المفتاح
                </Button>
              </div>

              <Separator />

              {/* قائمة المفاتيح */}
              <div className="text-xs font-semibold text-muted-foreground">المفاتيح المضافة ({keys.length})</div>
              <ScrollArea className="max-h-[28rem] pr-1">
                <div className="space-y-2">
                  {keys.length === 0 && (
                    <div className="text-center text-xs text-muted-foreground py-6">لا توجد مفاتيح بعد.</div>
                  )}
                  {keys.map((k) => (
                    <div key={k.id} className="rounded-lg border p-3 space-y-2 bg-card">
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2 min-w-0">
                          <Badge variant="outline" className="text-[10px]">{k.provider === "kie" ? "kie.ai" : "CometAPI"}</Badge>
                          {k.label && <span className="text-xs text-muted-foreground truncate">{k.label}</span>}
                        </div>
                        <Badge className={`text-[10px] ${STATUS_COLOR[k.status] || ""}`}>{STATUS_LABEL[k.status] || k.status}</Badge>
                      </div>
                      <div className="font-mono text-xs text-muted-foreground truncate" dir="ltr">{k.masked}</div>
                      <div className="grid grid-cols-3 gap-1 text-[10px] text-muted-foreground">
                        <span>استخدام: {k.usage_count}</span>
                        <span className="text-emerald-600">نجاح: {k.success_count}</span>
                        <span className="text-red-600">فشل: {k.fail_count}</span>
                      </div>
                      {k.last_error && (
                        <div className="text-[10px] text-red-600 line-clamp-2" title={k.last_error}>آخر خطأ: {k.last_error}</div>
                      )}
                      <div className="flex gap-1 pt-1">
                        <Button size="sm" variant="outline" className="h-7 text-xs flex-1" onClick={() => setKeyStatus(k.id, k.status === "disabled" ? "active" : "disabled")}>
                          {k.status === "disabled" ? "تنشيط" : "تعطيل"}
                        </Button>
                        <Button size="sm" variant="outline" className="h-7 text-xs text-red-600 hover:text-red-700" onClick={() => deleteKey(k.id)}>
                          <Trash2 className="size-3.5" />
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              </ScrollArea>
            </CardContent>
          </Card>

          {/* (ب) لوحة المهام */}
          <Card className="lg:col-span-2">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <ListVideo className="size-4 text-violet-500" /> لوحة المهام
              </CardTitle>
              <CardDescription className="text-xs">تتحدث تلقائيًا كل 5 ثوانٍ.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* شرائح الإحصائيات */}
              <div className="grid grid-cols-4 gap-2">
                <StatTile label="الإجمالي" value={stats.total} icon={<Activity className="size-4" />} color="text-zinc-600" />
                <StatTile label="مكتملة" value={stats.completed} icon={<CheckCircle2 className="size-4" />} color="text-emerald-600" />
                <StatTile label="فاشلة" value={stats.failed} icon={<XCircle className="size-4" />} color="text-red-600" />
                <StatTile label="جارية" value={stats.processing} icon={<Loader2 className="size-4" />} color="text-blue-600" />
              </div>
              <Separator />
              {/* قائمة المهام */}
              <ScrollArea className="max-h-[32rem] pr-1">
                <div className="space-y-2">
                  {tasks.length === 0 && (
                    <div className="text-center text-xs text-muted-foreground py-8">لا توجد مهام بعد — استدعِ الأدوات من عميل MCP.</div>
                  )}
                  {tasks.map((t) => (
                    <div key={t.id} className="rounded-lg border p-3 space-y-2 bg-card">
                      <div className="flex items-center justify-between gap-2 flex-wrap">
                        <div className="flex items-center gap-2">
                          <Badge variant="outline" className="text-[10px]">{TYPE_LABEL[t.type] || t.type}</Badge>
                          <Badge className={`text-[10px] ${STATUS_COLOR[t.status] || ""}`}>{STATUS_LABEL[t.status] || t.status}</Badge>
                          <span className="text-[10px] text-muted-foreground font-mono truncate max-w-[8rem]" dir="ltr">{t.model}</span>
                        </div>
                        <span className="text-[10px] text-muted-foreground">{t.created_at}</span>
                      </div>
                      {(t.status === "processing" || t.status === "pending") && (
                        <div className="space-y-1">
                          <Progress value={t.progress} className="h-1.5" />
                          <div className="text-[10px] text-muted-foreground">{t.progress}% — تابع بـ get_task</div>
                        </div>
                      )}
                      {t.prompt && (
                        <div className="text-xs text-muted-foreground line-clamp-1" dir="auto">{t.prompt}</div>
                      )}
                      {t.result_urls.length > 0 && (
                        <div className="flex items-center gap-2 flex-wrap">
                          {t.result_urls.map((u, i) => (
                            <a key={i} href={u} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-sky-600 hover:underline" dir="ltr">
                              <ExternalLink className="size-3" /> {u.length > 50 ? u.slice(0, 50) + "…" : u}
                            </a>
                          ))}
                        </div>
                      )}
                      {t.error_message && (
                        <div className="text-[10px] text-red-600 line-clamp-2">خطأ: {t.error_message}</div>
                      )}
                      <div className="text-[10px] text-muted-foreground">المحاولات: {Array.isArray(t.attempts) ? t.attempts.length : 0}</div>
                    </div>
                  ))}
                </div>
              </ScrollArea>
            </CardContent>
          </Card>
        </div>

        {/* (ج) ربط السيرفر — بطاقة كاملة العرض */}
        <Card className="mt-6">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Plug className="size-4 text-emerald-500" /> ربط السيرفر
            </CardTitle>
            <CardDescription className="text-xs">انسخ إعدادات الربط لأي عميل MCP.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* رابط /mcp */}
            <div className="space-y-2">
              <Label className="text-xs">رابط خادم MCP</Label>
              <div className="flex gap-2">
                <Input readOnly value={mcpUrl} className="font-mono text-sm" dir="ltr" />
                <Button variant="outline" size="sm" onClick={() => copy(mcpUrl, "نُسخ رابط MCP")}>
                  <Copy className="size-4" /> نسخ
                </Button>
              </div>
            </div>

            {/* تبويبات JSON */}
            <Tabs defaultValue="chatgpt">
              <TabsList className="w-full justify-start">
                <TabsTrigger value="chatgpt" className="text-xs">ChatGPT / GPT Agents</TabsTrigger>
                <TabsTrigger value="claude" className="text-xs">Claude Desktop</TabsTrigger>
                <TabsTrigger value="cursor" className="text-xs">Cursor / Windsurf / Cline</TabsTrigger>
              </TabsList>
              <TabsContent value="chatgpt" className="space-y-2">
                <div className="flex gap-2">
                  <Textarea readOnly value={jsonChatgpt} className="font-mono text-xs" dir="ltr" rows={4} />
                  <Button variant="outline" size="sm" onClick={() => copy(jsonChatgpt)}>
                    <Copy className="size-4" />
                  </Button>
                </div>
                <p className="text-[11px] text-muted-foreground">
                  في ChatGPT: Settings ← Connectors ← Create ← Custom MCP server وضع الرابط في «Server URL».
                </p>
              </TabsContent>
              <TabsContent value="claude" className="space-y-2">
                <div className="flex gap-2">
                  <Textarea readOnly value={jsonClaude} className="font-mono text-xs" dir="ltr" rows={4} />
                  <Button variant="outline" size="sm" onClick={() => copy(jsonClaude)}>
                    <Copy className="size-4" />
                  </Button>
                </div>
                <p className="text-[11px] text-muted-foreground">
                  الصق هذا في ملف <code dir="ltr">claude_desktop_config.json</code>.
                </p>
              </TabsContent>
              <TabsContent value="cursor" className="space-y-2">
                <div className="flex gap-2">
                  <Textarea readOnly value={jsonCursor} className="font-mono text-xs" dir="ltr" rows={4} />
                  <Button variant="outline" size="sm" onClick={() => copy(jsonCursor)}>
                    <Copy className="size-4" />
                  </Button>
                </div>
                <p className="text-[11px] text-muted-foreground">
                  الصق هذا في ملف <code dir="ltr">mcp.json</code> الخاص بـ Cursor/Windsurf/Cline.
                </p>
              </TabsContent>
            </Tabs>

            {/* رقائق الأدوات */}
            <Separator />
            <div className="space-y-2">
              <div className="text-xs font-semibold">الأدوات الخمس</div>
              <div className="grid gap-2 sm:grid-cols-2">
                {tools.map((t) => (
                  <div key={t.name} className="rounded-lg border p-2.5 bg-muted/20">
                    <div className="font-mono text-xs font-semibold text-sky-600" dir="ltr">{t.name}</div>
                    <div className="text-[11px] text-muted-foreground mt-0.5">{t.desc}</div>
                  </div>
                ))}
              </div>
            </div>

            {/* ملاحظة كهرمانية */}
            <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-[11px] text-amber-800 dark:text-amber-300 leading-relaxed">
              الفيديو يحتاج دقائق: يعيد السيرفر task_id فورًا، ويتابَع تلقائيًا بـ get_task كل 10 ثوانٍ — وعند
              اكتمال المهمة يُعرض الرابط في الدردشة ويتوقف. أثناء الانتظار يُبَث تقدم حي (Progress notifications)
              حتى لا تنقطع العملية.
            </div>
          </CardContent>
        </Card>
      </main>

      {/* الفوتر اللاصق */}
      <footer className="border-t mt-auto">
        <div className="mx-auto max-w-7xl px-4 py-3 text-center text-xs text-muted-foreground">
          مولّد الوسائط MCP — {health?.ok ? "يعمل" : "قيد التشغيل…"} • {health?.models.length || 0} موديلات • دمج مدمج
        </div>
      </footer>
    </div>
  );
}

function StatTile({ label, value, icon, color }: { label: string; value: number; icon: React.ReactNode; color: string }) {
  return (
    <div className="rounded-lg border p-2.5 bg-card text-center">
      <div className={`flex items-center justify-center gap-1 ${color}`}>{icon}</div>
      <div className="text-lg font-bold mt-0.5">{value}</div>
      <div className="text-[10px] text-muted-foreground">{label}</div>
    </div>
  );
}
