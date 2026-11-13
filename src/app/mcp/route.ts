// مسار خادم MCP — /mcp — نقل Streamable HTTP حسب مواصفات MCP.
// نستخدم SDK الرسمي: McpServer + WebStandardStreamableHTTPServerTransport.
//
// وضع التشغيل: STATELESS (بدون جلسات) — مناسب لـ Vercel serverless حيث لا تُحفظ
// حالة بين الطلبات. نُعطّل sessionIdGenerator ونفعّل enableJsonResponse ليردّ
// كل POST بنتيجة JSON مستقلة دون الحاجة لـ mcp-session-id. هذا النمط مدعوم رسميًا
// من MCP SDK لبيئات serverless ويعمل على Vercel بدون تخزين جلسات.

import { createMcpServer } from "@/lib/mcp-tools";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { ensureSchema } from "@/lib/turso";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// التحقق من توكن الوصول إن ضُبط MCP_ACCESS_TOKEN.
function checkAuth(req: Request): boolean {
  const token = process.env.MCP_ACCESS_TOKEN;
  if (!token) return true; // لا حماية.
  const auth = req.headers.get("authorization") || "";
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  return !!m && m[1] === token;
}

// كل طلب POST ننشئ خادمًا + transport جديدين (stateless)، نعالج الطلب، ونرد.
export async function POST(req: Request): Promise<Response> {
  if (!checkAuth(req)) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }
  try {
    await ensureSchema();
    const server = createMcpServer();
    // stateless: لا sessionIdGenerator + ردود JSON.
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    const res = await transport.handleRequest(req);
    // أغلق الخادم بعد الرد (لا حالة بين الطلبات في serverless).
    try {
      await server.close();
    } catch {
      /* ignore */
    }
    return res;
  } catch (e) {
    const msg = (e as Error).message || "internal error";
    return new Response(JSON.stringify({ error: msg }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}

// GET لاستئناف SSE — غير مدعوم في الوضع stateless.
export async function GET(req: Request): Promise<Response> {
  if (!checkAuth(req)) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }
  return new Response(JSON.stringify({ error: "GET not supported in stateless mode" }), {
    status: 405,
    headers: { "Content-Type": "application/json" },
  });
}

// DELETE — لا حالة للحذف في الوضع stateless.
export async function DELETE(req: Request): Promise<Response> {
  if (!checkAuth(req)) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }
  return new Response(null, { status: 200 });
}
