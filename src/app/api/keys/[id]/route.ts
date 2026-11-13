// PATCH/DELETE /api/keys/[id] — تعطيل/تنشيط يدوي + حذف.

import { deleteApiKey, getApiKey, updateApiKeyStatus } from "@/lib/turso";
import { maskKey } from "@/lib/keys";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const { id } = await params;
  const key = await getApiKey(id);
  if (!key) return jsonError(404, "المفتاح غير موجود");
  let body: { status?: string };
  try {
    body = await req.json();
  } catch {
    return jsonError(400, "JSON تالف");
  }
  const status = (body.status || "").trim();
  if (!["active", "exhausted", "disabled"].includes(status)) {
    return jsonError(400, "الحالة يجب أن تكون active أو exhausted أو disabled");
  }
  await updateApiKeyStatus(id, status);
  return Response.json({ id, status, masked: maskKey(key.api_key) });
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const { id } = await params;
  const key = await getApiKey(id);
  if (!key) return jsonError(404, "المفتاح غير موجود");
  await deleteApiKey(id);
  return Response.json({ deleted: id });
}

function jsonError(status: number, message: string): Response {
  return Response.json({ error: message }, { status });
}
