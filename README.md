# مولّد الوسائط MCP — خادم MCP لتوليد الصور والفيديو ودمج المقاطع

خادم **MCP** (Model Context Protocol) يولّد الصور والفيديو بالذكاء الاصطناعي عبر **kie.ai** و **CometAPI**، مع **تبديل تلقائي تسلسلي للمفاتيح** عند أي خطأ أو نفاد رصيد دون توقف المهمة، و**دمج عدة مقاطع فيديو** في مقطع واحد عالي الجودة — كل ذلك في تطبيق Next.js واحد مع لوحة إدارة عربية RTL.

## الميزات

- **خادم MCP** على المسار `/mcp` بخمس أدوات: `generate_image`, `generate_video`, `merge_videos`, `get_task`, `list_media`.
- **تبديل تسلسلي صارم للمفاتيح**: أول مفتاح يُجرَّب أولًا، وعند أي خطأ (نفاد رصيد/مفتاح غير صالح/حد معدّل) يُبدَّل تلقائيًا للمفتاح التالي **بنفس `task_id`** دون أن يرى النموذج أي خطأ.
- **دمج الفيديو مدمج**: خدمة دمج ffmpeg داخل نفس التطبيق (TURSO blobs + `ffmpeg-static`)، بـ API عام على `/api/jobs/*` مع بث بدعم Range (206).
- **لا تنزيل للوسائط**: نُخزّن روابط النتائج فقط في Turso (للتوليد) وBlobs للفيديو الناتج من الدمج (يُحذف بعد 24 ساعة).
- **واجهة عربية RTL**: إدارة المفاتيح + لوحة المهام الحية + بطاقة ربط السيرفر (JSON جاهز لـ ChatGPT/Claude/Cursor).

## التقنيات

- **Next.js 16** (App Router) + **TypeScript** + **Tailwind CSS 4** + **shadcn/ui**
- **`@modelcontextprotocol/sdk`** — `McpServer` + `WebStandardStreamableHTTPServerTransport`
- **`@libsql/client`** — قاعدة **Turso** عبر HTTP (مناسبة لـ Vercel serverless)
- **`ffmpeg-static`** + **`ffprobe-static`** — معالجة الفيديو داخل الدالة

## المتغيرات المطلوبة (Vercel → Settings → Environment Variables)

| المتغير | الوصف | إلزامي |
|---|---|---|
| `TURSO_DATABASE_URL` | رابط قاعدة Turso (`libsql://...`) | نعم |
| `TURSO_AUTH_TOKEN` | توكن Turso بصلاحيات كتابة | نعم |
| `MCP_ACCESS_TOKEN` | (اختياري) Bearer token لحماية `/mcp` | لا |
| `KIE_IMAGE_MODEL` / `KIE_VIDEO_MODEL` | تجاوز أسماء موديلات kie | لا |
| `COMETAPI_IMAGE_MODEL` / `COMETAPI_VIDEO_MODEL` | تجاوز أسماء موديلات CometAPI | لا |
| `MAX_SOURCES` | أقصى عدد مقاطع للدمج (افتراضي 10) | لا |
| `SOURCE_MAX_MB` | أقصى حجم لمصدر الدمج (افتراضي 200) | لا |
| `OUTPUT_MAX_MB` | أقصى حجم للناتج (افتراضي 150) | لا |
| `MAX_TOTAL_DURATION_SEC` | أقصى مجموع مدد (افتراضي 600) | لا |
| `FFMPEG_PRESET` | preset للترميز (افتراضي medium) | لا |

> خدمة الدمج مدمجة في نفس التطبيق — `MERGER_API_BASE` اختياري للعرض فقط.

## التشغيل محليًا

```bash
bun install
# أنشئ ملف .env.local بالمتغيرات أعلاه
bun run dev
```

ثم افتح `http://localhost:3000`.

## إنشاء قاعدة Turso والحصول على التوكن

```bash
# ثبّت Turso CLI
curl -sSfL https://get.tur.so/install.sh | bash

# أنشئ قاعدة مجانية
turso db create forex-academy

# اجلب رابط القاعدة
turso db show forex-academy --url
# → libsql://forex-academy-<org>.turso.io

# أنشئ توكن بصلاحيات كتابة
turso db tokens create forex-academy
```

ضع `TURSO_DATABASE_URL` و `TURSO_AUTH_TOKEN` في Vercel.

## النشر على Vercel

1. اربط المستودع بـ Vercel (New Project → Import Git Repository).
2. أضف متغيرات البيئة (الجدول أعلاه) في Settings → Environment Variables.
3. Deploy — لا حاجة لأي إعداد إضافي:
   - `libSQL` يتصل عبر HTTP (مناسب serverless).
   - مسار `/mcp` يعمل في الوضع **stateless** (بدون جلسات) مع `enableJsonResponse`.
   - `vercel.json` يضبط `maxDuration: 300` لمسار `/mcp` و `/api/jobs/*`، و cron يومي لتنظيف المهام المنتهية.

## ربط عميل MCP

### ChatGPT / GPT Agents
Settings → Connectors → Create → Custom MCP server → ضع الرابط:
```
https://<your-vercel-app>.vercel.app/mcp
```

### Claude Desktop (`claude_desktop_config.json`)
```json
{"mcpServers":{"media-generator":{"url":"https://<your-vercel-app>.vercel.app/mcp","type":"http"}}}
```

### Cursor / Windsurf / Cline (`mcp.json`)
```json
{"mcpServers":{"media-generator":{"url":"https://<your-vercel-app>.vercel.app/mcp"}}}
```

## اختبار الـ API بـ curl بعد النشر

```bash
# حالة السيرفر
curl https://<app>.vercel.app/api/health

# تهيئة MCP
curl -X POST https://<app>.vercel.app/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}'

# قائمة الأدوات
curl -X POST https://<app>.vercel.app/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'

# توليد صورة
curl -X POST https://<app>.vercel.app/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"generate_image","arguments":{"prompt":"قط أبيض على نافذة","wait_seconds":90}}}'

# دمج فيديوهين
curl -X POST https://<app>.vercel.app/api/jobs \
  -H 'Content-Type: application/json' \
  -d '{"videos":["https://url1.mp4","https://url2.mp4"]}'
curl -X POST https://<app>.vercel.app/api/jobs/<jobId>/process
curl https://<app>.vercel.app/api/jobs/<jobId>
```

## حدود الخطة المجانية (Vercel + Turso)

| المورد | حد Hobby المجاني |
|---|---|
| مدة الدالة (Function duration) | 60ث افتراضيًا، حتى 300ث مع `vercel.json` |
| حجم طلب HTTP | ~4.5MB (لذلك رفع الملفات بأجزاء 4MB) |
| حجم قاعدة Turso | 9GB |
| عمليات Turso للشهر | 1 مليار قراءة / 25 مليون كتابة |
| مساحة /tmp | محدودة (نظّف في `finally`) |

## بنية المشروع

```
src/
├── lib/
│   ├── turso.ts          # عميل Turso + المخطط + عمليات المهام/المفاتيح
│   ├── keys.ts           # نظام المفاتيح المتسلسلة + classifyProviderError + maskKey
│   ├── models.ts         # سجل الموديلات (aliases + providers)
│   ├── providers/        # مزودات: kie.ts + cometapi.ts + types.ts
│   ├── coordinator.ts    # منسّق التوليد/الدمج بالتبديل التسلسلي
│   ├── merger.ts         # محرك دمج ffmpeg + Turso blobs
│   └── mcp-tools.ts      # تعريف الأدوات الخمس
├── app/
│   ├── mcp/route.ts              # خادم MCP (stateless)
│   ├── api/
│   │   ├── health/route.ts       # حالة السيرفر
│   │   ├── keys/                 # إدارة المفاتيح
│   │   ├── tasks/route.ts        # قائمة المهام + إحصائيات
│   │   ├── jobs/                 # API الدمج العام (create/process/video/delete)
│   │   ├── upload/route.ts       # رفع أجزاء الملفات
│   │   ├── config/route.ts       # حدود الخدمة
│   │   └── cron/route.ts         # تنظيف يومي
│   ├── layout.tsx        # RTL + خط Cairo
│   └── page.tsx          # لوحة الإدارة العربية
└── vercel.json           # maxDuration + crons
```

## القواعد الذهبية المطبّقة

1. روابط فقط — لا تنزيل وسائط للتوليد (الدمج يخزّن الناتج مؤقتًا 24ث).
2. ترتيب المفاتيح تسلسلي صارم (`created_at ASC, id ASC`).
3. لا توقف عند نفاد رصيد — تبديل تلقائي ونفس `task_id`.
4. النموذج لا يرى أخطاء مفاتيح/رصيد أبدًا.
5. المهام الفاشلة على كل المفاتيح تبقى `processing` وتُعاد مع `get_task` (تهدئة 45ث).
6. أخطاء خدمة الدمج المعلنة = فشل حتمي؛ أخطاء الشبكة = مؤقتة.
7. ملفات الدمج تُحذف بعد 24 ساعة (مذكور في وصف الأداة والـ instructions).
8. كل الرسائل عربية (المصطلحات التقنية وأسماء الأدوات بالإنجليزية).
9. إخفاء المفاتيح إلزامي (`maskKey`).
10. `.env*` في `.gitignore` منذ أول commit.
