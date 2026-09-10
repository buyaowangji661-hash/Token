import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CLIENT_IDS,
  CLIENT_LABELS,
  EMPTY_BREAKDOWN,
  type ClientId,
  type ClientUsage,
  type ModelUsage,
  type Period,
  type TokenBreakdown,
  type UsageResult
} from "../shared/types";
import { readPricingFile } from "./config";
import { computeCost, getPrice, type CatalogPrice } from "./pricing";
import { runTokscale, runTokscaleJson } from "./tokscale";

type ReportRow = {
  client: string;
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  messageCount: number;
};

type Report = { entries?: ReportRow[] };

const PERIOD_FLAG: Record<Exclude<Period, "year">, string> = {
  today: "--today",
  yesterday: "--yesterday",
  week: "--week",
  month: "--month"
};

function periodArgs(period: Period): string[] {
  if (period === "year") return ["--year", String(new Date().getFullYear())];
  return [PERIOD_FLAG[period]];
}

function toBreakdown(row: {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  reasoning?: number;
}): TokenBreakdown {
  return {
    input: row.input ?? 0,
    output: row.output ?? 0,
    cacheRead: row.cacheRead ?? 0,
    cacheWrite: row.cacheWrite ?? 0,
    reasoning: row.reasoning ?? 0
  };
}

function total(b: TokenBreakdown): number {
  return b.input + b.output + b.cacheRead + b.cacheWrite + b.reasoning;
}

function periodStartMs(period: Period): number {
  const now = new Date();
  if (period === "today") return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (period === "yesterday") return new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1).getTime();
  if (period === "week") return now.getTime() - 7 * 24 * 60 * 60 * 1000;
  if (period === "month") return new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  return new Date(now.getFullYear(), 0, 1).getTime();
}

function normalizeModelKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Grok CLI 在 ~/.grok/sessions/ * /updates.jsonl 的每条推理里记了 costUsdTicks
 * （按 1e-9 美元换算），tokscale 不读这个字段。
 * 默认不启用（四家统一按定价目录折算）；仅在 pricing.json 里显式写
 * grokUseRecordedCost: true 时才会走这里。
 */
export function readGrokRecordedCost(sinceMs: number): Map<string, number> {
  const result = new Map<string, number>();
  const root = path.join(os.homedir(), ".grok", "sessions");
  const files: string[] = [];
  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === "updates.jsonl") files.push(full);
    }
  };
  walk(root);

  for (const file of files) {
    let content: string;
    try {
      content = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const line of content.split("\n")) {
      if (!line || line.indexOf("costUsdTicks") < 0) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      const record = parsed as {
        timestamp?: number;
        params?: {
          update?: {
            usage?: {
              costUsdTicks?: number;
              modelUsage?: Record<string, { costUsdTicks?: number }>;
            };
          };
        };
      };
      const tsMs = (record.timestamp ?? 0) * 1000;
      if (!tsMs || tsMs < sinceMs) continue;
      const usage = record.params?.update?.usage;
      if (!usage) continue;
      if (usage.modelUsage && typeof usage.modelUsage === "object") {
        for (const [model, value] of Object.entries(usage.modelUsage)) {
          const usd = (value?.costUsdTicks ?? 0) / 1e9;
          if (usd > 0) result.set(model, (result.get(model) ?? 0) + usd);
        }
      } else if (usage.costUsdTicks) {
        const usd = usage.costUsdTicks / 1e9;
        result.set("grok", (result.get("grok") ?? 0) + usd);
      }
    }
  }
  return result;
}

/** 把 Grok 日志里的模型名对到 tokscale 报告的模型 id 上。 */
function matchRecordedModel(reportModels: string[], recordedKey: string): string | null {
  const target = normalizeModelKey(recordedKey);
  for (const model of reportModels) {
    const candidate = normalizeModelKey(model);
    if (candidate === target) return model;
    if (target.startsWith(candidate) || candidate.startsWith(target)) return model;
  }
  return null;
}

export async function fetchUsage(period: Period, signal?: AbortSignal): Promise<UsageResult> {
  const startedAt = Date.now();
  const report = await runTokscaleJson<Report>(
    ["--json", "--client", CLIENT_IDS.join(","), "--group-by", "client,model", ...periodArgs(period), "--no-spinner"],
    { timeoutMs: 300_000, signal }
  );

  const rows = (report.entries ?? []).filter((row) => CLIENT_IDS.includes(row.client as ClientId));
  const byClient = new Map<ClientId, ReportRow[]>();
  for (const row of rows) {
    const id = row.client as ClientId;
    const list = byClient.get(id);
    if (list) list.push(row);
    else byClient.set(id, [row]);
  }

  const uniqueModels = [...new Set(rows.map((row) => row.model))];
  const prices = new Map<string, CatalogPrice | null>();
  // 串行预热：冷缓存时第一次询价要把上游目录拉下来（实测 ~50s），若让所有模型并行发起，
  // 会同时起十几个 tokscale 进程去拉同一份 2–5MB 目录。先串行跑一个「不吃本地覆盖」
  // 的模型，把目录缓存落到磁盘，其余再并行（那时都是缓存命中，0.1s 级）。
  const localOverrides = readPricingFile().models ?? {};
  const prewarm = uniqueModels.find((model) => !localOverrides[model]);
  if (prewarm !== undefined) prices.set(prewarm, await getPrice(prewarm));
  await Promise.all(
    uniqueModels
      .filter((model) => model !== prewarm)
      .map(async (model) => {
        prices.set(model, await getPrice(model));
      })
  );

  const pricingFile = readPricingFile();
  // Grok 缺省与另外三家同口径（定价目录）。只有 pricing.json 里显式写
  // grokUseRecordedCost: true，才改用 Grok CLI 自记的 costUsdTicks。
  const grokRecorded =
    pricingFile.grokUseRecordedCost === true ? readGrokRecordedCost(periodStartMs(period)) : null;

  const clients: ClientUsage[] = [];
  let hasUnpriced = false;

  for (const id of CLIENT_IDS) {
    const clientRows = byClient.get(id) ?? [];
    const models: ModelUsage[] = clientRows
      .map((row) => {
        const tokens = toBreakdown(row);
        const cost = computeCost(tokens, prices.get(row.model) ?? null);
        return {
          model: row.model,
          tokens,
          totalTokens: total(tokens),
          messages: row.messageCount ?? 0,
          cost
        } satisfies ModelUsage;
      })
      .filter((model) => model.totalTokens > 0)
      .sort((a, b) => b.totalTokens - a.totalTokens);

    // Grok：仅在 pricing.json 显式开启 grokUseRecordedCost 时改用 CLI 自带的 costUsdTicks
    if (id === "grok" && grokRecorded && models.length > 0) {
      const reportModels = models.map((model) => model.model);
      const assigned = new Map<string, number>();
      let unmatched = 0;
      for (const [recordedModel, usd] of grokRecorded) {
        const target = matchRecordedModel(reportModels, recordedModel);
        if (target) assigned.set(target, (assigned.get(target) ?? 0) + usd);
        else unmatched += usd;
      }
      const matchedTotal = [...assigned.values()].reduce((sum, value) => sum + value, 0);
      if (matchedTotal + unmatched > 0) {
        if (unmatched > 0) {
          const tokenTotal = models.reduce((sum, model) => sum + model.totalTokens, 0) || 1;
          for (const model of models) {
            assigned.set(
              model.model,
              (assigned.get(model.model) ?? 0) + (model.totalTokens / tokenTotal) * unmatched
            );
          }
        }
        for (const model of models) model.cost = assigned.get(model.model) ?? 0;
      }
    }

    for (const model of models) if (model.cost === null) hasUnpriced = true;

    const clientTokens = models.reduce<TokenBreakdown>(
      (acc, model) => ({
        input: acc.input + model.tokens.input,
        output: acc.output + model.tokens.output,
        cacheRead: acc.cacheRead + model.tokens.cacheRead,
        cacheWrite: acc.cacheWrite + model.tokens.cacheWrite,
        reasoning: acc.reasoning + model.tokens.reasoning
      }),
      { ...EMPTY_BREAKDOWN }
    );

    const costValues = models.map((model) => model.cost);
    const cost = costValues.every((value) => value === null)
      ? null
      : costValues.reduce<number>((sum, value) => sum + (value ?? 0), 0);

    clients.push({
      client: id,
      label: CLIENT_LABELS[id],
      tokens: clientTokens,
      totalTokens: total(clientTokens),
      messages: models.reduce((sum, model) => sum + model.messages, 0),
      cost,
      models
    });
  }

  const visible = clients.filter((client) => client.totalTokens > 0);

  return {
    period,
    clients: visible,
    totalTokens: visible.reduce((sum, client) => sum + client.totalTokens, 0),
    totalMessages: visible.reduce((sum, client) => sum + client.messages, 0),
    totalCost: visible.reduce((sum, client) => sum + (client.cost ?? 0), 0),
    hasUnpriced,
    generatedAt: new Date().toISOString(),
    scanMs: Date.now() - startedAt
  };
}
