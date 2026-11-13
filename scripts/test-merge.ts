// سكربت اختبار مباشر لمحرك الدمج: ينشئ مهمة ويشغّل processMergeJob مباشرة.
import { createMergeJob, processMergeJob, getMergeJob } from "../src/lib/merger";

async function main() {
  const inputs = [
    { kind: "url" as const, url: "https://www.w3schools.com/html/mov_bbb.mp4" },
    { kind: "url" as const, url: "https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/360/Big_Buck_Bunny_360_10s_1MB.mp4" },
  ];
  console.log("[test] creating job...");
  const job = await createMergeJob(inputs);
  console.log("[test] jobId:", job.jobId);
  console.log("[test] running processMergeJob (blocking)...");
  const t0 = Date.now();
  const r = await processMergeJob(job.jobId);
  console.log("[test] result:", JSON.stringify(r, null, 2));
  console.log("[test] elapsed:", ((Date.now() - t0) / 1000).toFixed(1), "s");
  const j = await getMergeJob(job.jobId);
  console.log("[test] final job:", JSON.stringify(j, null, 2));
}

main().catch((e) => {
  console.error("[test] ERROR:", e.message);
  console.error(e.stack);
  process.exit(1);
});
