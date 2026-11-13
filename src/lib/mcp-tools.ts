// أدوات MCP الخمس — تعريفات ومُعالِجات.
// الأوصاف بالإنجليزية (العميل يقرأها)، ونتائج الاستدعاء تُصاغ بالعربية.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { runGeneration, runMerge, refreshTask, listMedia } from "./coordinator";
import { resolveMergeInputs } from "./merger";
import type { GenerateInput } from "./providers";

export const SERVER_INFO = { name: "media-generator-mcp", version: "1.2.0" };

export const SERVER_INSTRUCTIONS = `AI media generation server (kie.ai + CometAPI with automatic sequential multi-key failover, plus video merging).
Workflow: call generate_image or generate_video. If the response contains finished URLs, show them to the user.
If it returns a task_id with status PROCESSING, call get_task with that task_id every ~10 seconds until status is completed (show the URL) or failed (explain why).
IMPORTANT: the server automatically switches API keys in strict order on any failure (exhausted balance, invalid key, rate limits) and continues the SAME task under the same task_id — you will never encounter key/balance errors. Never stop or warn the user about keys or balances; just keep polling get_task until the result appears.
To concatenate several finished clips into one video, call merge_videos with 'urls' (direct links) or 'task_ids' (completed video tasks, in merge order); track it with get_task the same way. Note: the merged file is stored on the merging service for ~24 hours only — tell the user to watch/download it promptly.
Use list_media to recall previously generated media from the database.`;

// بناء خادم MCP وتسجيل الأدوات الخمس عليه.
export function createMcpServer(): McpServer {
  const server = new McpServer(SERVER_INFO, { instructions: SERVER_INSTRUCTIONS });

  // 1) generate_image
  server.registerTool(
    "generate_image",
    {
      description:
        "Generate an image with gpt-image-2-6/flare-text-to-image (automatic failover across all active keys). Returns the image URL if completed within the wait window, otherwise returns a task_id — call get_task every ~10 seconds until completed, then show the URL and stop.",
      inputSchema: {
        prompt: z.string().min(1).describe("What to draw. Detailed prompts give better results."),
        model: z
          .enum(["gpt-image-2-6/flare-text-to-image", "gpt-image-2.6/flare-text-to-image"])
          .default("gpt-image-2-6/flare-text-to-image"),
        aspect_ratio: z
          .enum([
            "auto","1:1","3:2","2:3","4:3","3:4","5:4","4:5","16:9","9:16","2:1","1:2","21:9","9:21","3:1","1:3",
          ])
          .default("auto"),
        resolution: z.enum(["1K","2K","4K"]).default("1K"),
        background: z
          .enum(["auto","transparent","opaque"])
          .default("auto")
          .describe("Only applied at 1K."),
        output_format: z.enum(["png","jpeg","webp","gif"]).default("png"),
        wait_seconds: z.number().int().min(0).max(240).default(90),
      },
    },
    async (args) => {
      const input: GenerateInput = {
        prompt: args.prompt,
        aspect_ratio: args.aspect_ratio,
        resolution: args.resolution,
        background: args.background,
        output_format: args.output_format,
      };
      const r = await runGeneration({
        modelInput: args.model,
        type: "image",
        input,
        waitSeconds: args.wait_seconds,
      });
      return { content: [{ type: "text", text: r.arabicMessage }], isError: r.isError };
    }
  );

  // 2) generate_video
  server.registerTool(
    "generate_video",
    {
      description:
        "Generate a video with grok-imagine-video-1-5-preview (native synchronized audio, optional image-to-video). Video takes minutes: short wait with progress streaming then a task_id — track with get_task every ~10 seconds.",
      inputSchema: {
        prompt: z
          .string()
          .max(4096)
          .describe("Scene description. Dialogue in the prompt is spoken in the video."),
        image_url: z
          .string()
          .optional()
          .describe("Optional public image URL as the first frame (image-to-video)."),
        model: z
          .enum(["grok-imagine-video-1-5-preview", "grok-imagine-video-1.5-preview"])
          .default("grok-imagine-video-1-5-preview"),
        aspect_ratio: z.enum(["auto","1:1","16:9","9:16","3:2","2:3"]).default("auto"),
        resolution: z.enum(["480p","720p","1080p"]).default("480p"),
        enable_audio: z.boolean().default(true),
        duration: z.number().int().min(1).max(15).default(8).describe("Duration in seconds."),
        wait_seconds: z.number().int().min(0).max(240).default(25),
      },
    },
    async (args) => {
      const input: GenerateInput = {
        prompt: args.prompt,
        image_url: args.image_url,
        aspect_ratio: args.aspect_ratio,
        resolution: args.resolution,
        enable_audio: args.enable_audio,
        duration: args.duration,
      };
      const r = await runGeneration({
        modelInput: args.model,
        type: "video",
        input,
        waitSeconds: args.wait_seconds,
      });
      return { content: [{ type: "text", text: r.arabicMessage }], isError: r.isError };
    }
  );

  // 3) merge_videos
  server.registerTool(
    "merge_videos",
    {
      description:
        "Merge several clips into ONE final video in the given order. Pass 'urls' (public direct video URLs — like those from generate_video) or 'task_ids' (of COMPLETED video generation tasks — their result URLs are merged in this order). Merging is usually fast: short wait with progress streaming then a task_id for the merge — track it with get_task. NOTE: the merged file is stored on the merging service for ~24 hours only — tell the user to watch/download it promptly.",
      inputSchema: {
        urls: z
          .array(z.string())
          .min(2)
          .max(10)
          .optional()
          .describe(
            "Public direct video URLs (http/https) in merge order — the first clip starts the final video."
          ),
        task_ids: z
          .array(z.string())
          .min(2)
          .max(10)
          .optional()
          .describe(
            "Alternative to urls: task_ids of COMPLETED video generation tasks — their result URLs are merged in this order."
          ),
        wait_seconds: z.number().int().min(0).max(240).default(60),
      },
    },
    async (args) => {
      // حل task_ids أولًا ثم urls المباشرة بنفس الترتيب.
      const inputs: { kind: "url"; url: string }[] = [];
      if (args.task_ids && args.task_ids.length >= 2) {
        const { inputs: resolved, failedIds } = await resolveMergeInputs(args.task_ids);
        for (const r of resolved) if (r.url) inputs.push({ kind: "url", url: r.url });
        if (failedIds.length > 0) {
          return {
            content: [
              {
                type: "text",
                text: `❌ تعذّر حل بعض task_ids (ليست مهام فيديو مكتملة): ${failedIds.join(", ")}`,
              },
            ],
            isError: true,
          };
        }
      } else if (args.urls && args.urls.length >= 2) {
        for (const u of args.urls) {
          if (!/^https?:\/\//i.test(u)) {
            return {
              content: [{ type: "text", text: `❌ رابط غير مباشر/غير صالح: ${u}` }],
              isError: true,
            };
          }
          inputs.push({ kind: "url", url: u });
        }
      } else {
        return {
          content: [
            {
              type: "text",
              text: "❌ الدمج يحتاج مقطعَين على الأقل. مرّر urls (روابط مباشرة) أو task_ids لمهام مكتملة.",
            },
          ],
          isError: true,
        };
      }
      const r = await runMerge({ inputs, waitSeconds: args.wait_seconds });
      return { content: [{ type: "text", text: r.arabicMessage }], isError: r.isError };
    }
  );

  // 4) get_task
  server.registerTool(
    "get_task",
    {
      description:
        "Track any task by its id — image/video generation AND merging (reads the Turso database and refreshes from the provider/service if still running). Poll every ~10 seconds; on completed you will find the result URLs — show them to the user and stop polling.",
      inputSchema: {
        task_id: z.string(),
      },
    },
    async (args) => {
      const r = await refreshTask(args.task_id);
      return { content: [{ type: "text", text: r.arabicMessage }], isError: r.isError };
    }
  );

  // 5) list_media
  server.registerTool(
    "list_media",
    {
      description:
        "Recent images/videos/merges stored with their URLs from the database (no regeneration) — to recall previous results.",
      inputSchema: {
        type: z.enum(["image","video","merge"]).optional(),
        status: z.enum(["completed","failed","processing"]).optional(),
        limit: z.number().int().min(1).max(50).default(10),
      },
    },
    async (args) => {
      const rows = await listMedia({
        type: args.type,
        status: args.status,
        limit: args.limit,
      });
      if (rows.length === 0) {
        return { content: [{ type: "text", text: "لا توجد وسائط مخزنة بعد." }] };
      }
      const lines = rows.map((t) => {
        const urls = t.result_urls_json ? JSON.parse(t.result_urls_json) as string[] : [];
        const u = urls[0] || "—";
        return `- [${t.type}] ${t.status} | ${t.model} | ${t.id} | رابط: ${u}`;
      });
      return {
        content: [
          { type: "text", text: `أحدث الوسائط المخزنة (${rows.length}):\n\n${lines.join("\n")}` },
        ],
      };
    }
  );

  return server;
}
