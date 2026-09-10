#!/usr/bin/env node
/**
 * 生成随包分发的定价目录快照 resources/pricing-snapshot.json.gz。
 *
 * 为什么需要它：tokscale 的定价目录靠联网拉（LiteLLM / OpenRouter / models.dev），
 * 缓存只认 1 小时。在 raw.githubusercontent.com 或 models.dev 不通的机器上，
 * 首装时目录是空的 → 每次询价都要等满 30s 超时。带上这份快照，首装即可离线出价，
 * app 再在后台慢慢刷新。
 *
 * 用法（在仓库根目录）：
 *   npm run snapshot            从本机 %APPDATA%\tokscale\cache 抓取（需先跑过一次 tokscale）
 *   npm run snapshot -- --out=x 输出到自定义路径
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

const root = path.resolve(import.meta.dirname, "..");
const argv = process.argv.slice(2);
const outArg = argv.find((a) => a.startsWith("--out="));
const outFile = outArg
  ? path.resolve(outArg.slice("--out=".length))
  : path.join(root, "resources", "pricing-snapshot.json.gz");

/** 快照里的键名 ↔ tokscale 的缓存文件名 */
const SOURCES = [
  { key: "litellm", file: "pricing-litellm.json" },
  { key: "openrouter", file: "pricing-openrouter.json" },
  { key: "models-dev", file: "pricing-models-dev.json" }
];

const cacheDir = process.env.TOKSCALE_CONFIG_DIR
  ? path.join(process.env.TOKSCALE_CONFIG_DIR, "cache")
  : path.join(process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"), "tokscale", "cache");

const snapshot = {};
let total = 0;
for (const { key, file } of SOURCES) {
  const full = path.join(cacheDir, file);
  if (!fs.existsSync(full)) {
    console.warn(`跳过（不存在）：${full}`);
    continue;
  }
  const parsed = JSON.parse(fs.readFileSync(full, "utf8"));
  const data = parsed.data;
  if (!data || typeof data !== "object") {
    console.warn(`跳过（没有 data 字段）：${file}`);
    continue;
  }
  snapshot[key] = { data };
  const count = Object.keys(data).length;
  total += count;
  console.log(`${file.padEnd(26)} ${count} 条`);
}

if (total === 0) {
  console.error("一个源都没读到，先跑一次 tokscale（例如 `tokscale pricing glm-5.3 --json`）再试。");
  process.exit(1);
}

const raw = Buffer.from(JSON.stringify(snapshot), "utf8");
const gz = zlib.gzipSync(raw, { level: 9 });
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, gz);

// 回读校验：能解压、够条数、样本价格存在
const back = JSON.parse(zlib.gunzipSync(fs.readFileSync(outFile)).toString("utf8"));
const sample = back.openrouter?.data?.["z-ai/glm-5.3"];
console.log(
  `\n写入 ${outFile}\n  ${total} 条  ${(raw.length / 1048576).toFixed(2)}MB → ${(gz.length / 1024).toFixed(0)}KB  源=[${Object.keys(back)}]`
);
console.log(
  `  校验 glm-5.3 = ${sample ? `${sample.input_cost_per_token}/${sample.output_cost_per_token}` : "缺失！"}`
);
