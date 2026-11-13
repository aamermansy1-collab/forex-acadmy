// سجل الموديلات: الأسماء الكانونية + الصيغ البديلة (aliases) + المزودون + اسم الموديل لدى كل مزود.
// الأسماء قابلة للتجاوز بمتغيرات بيئة.

export type TaskProvider = ProviderId | "merger";
export type MediaType = "image" | "video" | "merge";
export type ProviderId = "kie" | "cometapi";

export interface ModelDef {
  canonical: string; // الاسم كما يراه عميل MCP
  aliases: string[]; // صيغ بديلة نقبلها ونوحّدها (نقاط بدل شرطات)
  type: MediaType;
  providers: ProviderId[]; // من يستطيع خدمته — تُجرَّب مفاتيحهم كلها بالترتيب
  providerModel: Record<ProviderId, string>; // اسم الموديل كما يُرسل لكل مزود
}

// الموديلان المدمجان كما هما في المواصفة، مع تجاوز اختياري بمتغيرات البيئة.
function envOr(v: string | undefined, fallback: string): string {
  return v && v.trim() ? v.trim() : fallback;
}

const KIE_IMAGE = envOr(process.env.KIE_IMAGE_MODEL, "gpt-image-2-6/flare-text-to-image");
const KIE_VIDEO = envOr(process.env.KIE_VIDEO_MODEL, "grok-imagine-video-1-5-preview");
const COMET_IMAGE = envOr(
  process.env.COMETAPI_IMAGE_MODEL,
  "gpt-image-2.6-flare-text-to-image"
);
const COMET_VIDEO = envOr(process.env.COMETAPI_VIDEO_MODEL, "grok-imagine-video-1-5-preview");

export const MODELS: ModelDef[] = [
  {
    canonical: "gpt-image-2-6/flare-text-to-image",
    aliases: [
      "gpt-image-2-6/flare-text-to-image",
      "gpt-image-2.6/flare-text-to-image",
      "gpt-image-2-6-flare-text-to-image",
      "gpt-image-2.6-flare-text-to-image",
    ],
    type: "image",
    providers: ["kie", "cometapi"],
    providerModel: {
      kie: KIE_IMAGE,
      cometapi: COMET_IMAGE,
    },
  },
  {
    canonical: "grok-imagine-video-1-5-preview",
    aliases: [
      "grok-imagine-video-1-5-preview",
      "grok-imagine-video-1.5-preview",
      "grok-imagine-video-15-preview",
    ],
    type: "video",
    providers: ["kie", "cometapi"],
    providerModel: {
      kie: KIE_VIDEO,
      cometapi: COMET_VIDEO,
    },
  },
];

// توحيد اسم الموديل عبر aliases. غير معروف → null (خطأ معطيات فوري).
export function resolveModel(name: string): ModelDef | null {
  if (!name) return null;
  const n = name.trim().toLowerCase();
  for (const m of MODELS) {
    if (m.canonical.toLowerCase() === n) return m;
    if (m.aliases.some((a) => a.toLowerCase() === n)) return m;
  }
  return null;
}

export function modelByCanonical(canonical: string): ModelDef | undefined {
  return MODELS.find((m) => m.canonical === canonical);
}
