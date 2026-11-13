// GET/POST /api/keys — إدارة المفاتيح.
// القائمة دائمًا بمفاتيح مُقنّعة (maskKey). POST يرفض التكرار لنفس المزود.

import {
  insertApiKey,
  listApiKeys,
  findDuplicateKey,
} from "@/lib/turso";
import { maskKey } from "@/lib/keys";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const rows = await listApiKeys();
  // إخفاء المفاتيح إلزامي في كل الاستجابات.
  const masked = rows.map((k) => ({
    id: k.id,
    provider: k.provider,
    label: k.label,
    masked: maskKey(k.api_key),
    status: k.status,
    usage_count: k.usage_count,
    success_count: k.success_count,
    fail_count: k.fail_count,
    last_used_at: k.last_used_at,
    last_checked_at: k.last_checked_at,
    last_error: k.last_error,
    created_at: k.created_at,
  }));
  return Response.json({ keys: masked });
}

export async function POST(req: Request): Promise<Response> {
  let body: { provider?: string; api_key?: string; label?: string };
  try {
    body = await req.json();
  } catch {
    return jsonError(400, "JSON تالف");
  }
  const provider = (body.provider || "").trim();
  const apiKey = (body.api_key || "").trim();
  const label = (body.label || "").trim();
  if (!["kie", "cometapi"].includes(provider)) {
    return jsonError(400, "المزود يجب أن يكون 'kie' أو 'cometapi'");
  }
  if (!apiKey) return jsonError(400, "المفتاح مطلوب");

  // رفض التكرار لنفس المزود.
  const dup = await findDuplicateKey(provider, apiKey);
  if (dup) {
    return jsonError(409, "هذا المفتاح موجود بالفعل لنفس المزود");
  }
  const row = await insertApiKey(provider, apiKey, label);
  return Response.json(
    {
      id: row.id,
      provider: row.provider,
      label: row.label,
      masked: maskKey(row.api_key),
      status: row.status,
      created_at: row.created_at,
    },
    { status: 201 }
  );
}

function jsonError(status: number, message: string): Response {
  return Response.json({ error: message }, { status });
}
