// واجهة المزودات الموحّدة: كل مزود ينفّذ createTask/checkTask،
// وبعض المزودين يدعم createImageSync للصور الفورية.

import type { ProviderId } from "../models";

export interface GenerateInput {
  prompt: string;
  aspect_ratio?: string;
  resolution?: string;
  background?: string;
  output_format?: string;
  image_url?: string; // image-to-video
  enable_audio?: boolean;
  duration?: number;
}

export interface ProviderAdapter {
  id: ProviderId;
  // مهمة غير متزامنة (فيديو، وبعض الصور): تعيد providerTaskId.
  createTask(
    key: string,
    model: string,
    input: GenerateInput
  ): Promise<{ providerTaskId: string }>;
  // صور متزامنة إن كان المزود يدعمها (CometAPI تعيد النتيجة فورًا).
  createImageSync?(key: string, model: string, input: GenerateInput): Promise<{ urls: string[] }>;
  // استعلام حالة مهمة جارية.
  checkTask(
    key: string,
    providerTaskId: string
  ): Promise<{
    status: "processing" | "completed" | "failed";
    urls?: string[];
    error?: string;
    progress?: number;
  }>;
}

// أي خطأ يُرمى كـ ProviderError { status, message, body } ليُصنَّف لاحقًا.
export class ProviderError extends Error {
  status: number;
  body?: unknown;
  constructor(status: number, message: string, body?: unknown) {
    super(message);
    this.name = "ProviderError";
    this.status = status;
    this.body = body;
  }
}
