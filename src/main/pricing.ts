import type { TokenBreakdown } from "../shared/types";
import { readPricingFile } from "./config";
import { runTokscaleJson } from "./tokscale";

export type CatalogPrice = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
};

type TokscalePricingResponse = {
  pricing?: {
    inputCostPerToken?: number;
    outputCostPerToken?: number;
    cacheReadInputTokenCost?: number;
    cacheCreationInputTokenCost?: number;
  } | null;
};

const memoryCache = new Map<string, CatalogPrice | null>();
const inflight = new Map<string, Promise<CatalogPrice | null>>();

/**
 * 价格来源顺序：
 *   1. %APPDATA%\Token\pricing.json 的本地覆盖（每百万 token 单价）
 *   2. tokscale 内置定价目录（LiteLLM / OpenRouter / Models.dev）
 * 返回 null 表示未定价。
 */
export async function getPrice(model: string): Promise<CatalogPrice | null> {
  const override = readPricingFile().models?.[model];
  if (override) {
    const price: CatalogPrice = {
      input: (override.input_per_million ?? 0) / 1_000_000,
      output: (override.output_per_million ?? 0) / 1_000_000,
      cacheRead: (override.cache_read_per_million ?? 0) / 1_000_000,
      cacheWrite: (override.cache_write_per_million ?? 0) / 1_000_000
    };
    return price;
  }
  if (memoryCache.has(model)) return memoryCache.get(model) ?? null;
  const running = inflight.get(model);
  if (running) return running;

  const task = (async (): Promise<CatalogPrice | null> => {
    try {
      // 超时必须容得下「冷缓存时把上游目录拉下来」：清空 %APPDATA%\tokscale\cache 后
      // 实测首次询价 9~51s（随网络波动），给 30s 会被误判成「未定价」。
      const data = await runTokscaleJson<TokscalePricingResponse>(
        ["pricing", model, "--json", "--no-spinner"],
        { timeoutMs: 90_000 }
      );
      const p = data.pricing;
      if (!p) return null;
      const price: CatalogPrice = {
        input: p.inputCostPerToken ?? 0,
        output: p.outputCostPerToken ?? 0,
        cacheRead: p.cacheReadInputTokenCost ?? 0,
        cacheWrite: p.cacheCreationInputTokenCost ?? 0
      };
      if (price.input === 0 && price.output === 0) return null;
      return price;
    } catch {
      return null;
    }
  })();

  inflight.set(model, task);
  try {
    const result = await task;
    memoryCache.set(model, result);
    return result;
  } finally {
    inflight.delete(model);
  }
}

/** 按定价目录折算成本；未定价返回 null。reasoning 与 output 同价。 */
export function computeCost(tokens: TokenBreakdown, price: CatalogPrice | null): number | null {
  if (!price) return null;
  return (
    tokens.input * price.input +
    (tokens.output + tokens.reasoning) * price.output +
    tokens.cacheRead * price.cacheRead +
    tokens.cacheWrite * price.cacheWrite
  );
}

export function clearPriceCache(): void {
  memoryCache.clear();
}
