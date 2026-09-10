import type { TokenBreakdown } from "../shared/types";
import { readPricingFile } from "./config";
import { ensureCatalogFresh, refreshCatalog } from "./priceCatalog";
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
 * 单次询价超时。定价目录由 `priceCatalog` 维持「新鲜」，正常路径上 tokscale 是纯本地
 * 读文件（实测 104ms），20s 只是防呆；目录真缺失时宁可快速失败、由后台刷新兜底，
 * 也不要让界面等满 90s（那是切周期卡顿的放大器）。
 */
const QUERY_TIMEOUT_MS = 20_000;

function parsePrice(data: TokscalePricingResponse): CatalogPrice | null {
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
}

type QueryOutcome =
  | { kind: "price"; price: CatalogPrice }
  | { kind: "unpriced" }
  | { kind: "error"; error: unknown };

/**
 * 询价。要区分「命令跑成功但这模型没有定价」和「命令本身失败」：
 *   - 前者是正常结果（Antigravity 的 `gemini-default` 这类占位 id、上游确实没有的新模型名），
 *     必须直接记成未定价 —— 曾把两者混为一谈，结果每遇到一个未定价模型就去触发一次联网刷新，
 *     在源被封的机器上每个模型白等 30s。
 *   - 后者才值得让后台刷一遍目录再补试。
 */
async function queryPrice(model: string): Promise<QueryOutcome> {
  try {
    const data = await runTokscaleJson<TokscalePricingResponse>(["pricing", model, "--json", "--no-spinner"], {
      timeoutMs: QUERY_TIMEOUT_MS
    });
    const price = parsePrice(data);
    return price ? { kind: "price", price } : { kind: "unpriced" };
  } catch (error) {
    return { kind: "error", error };
  }
}

/**
 * 价格来源顺序：
 *   1. %APPDATA%\Token\pricing.json 的本地覆盖（每百万 token 单价）
 *   2. tokscale 内置定价目录（LiteLLM / OpenRouter / Models.dev）
 * 返回 null 表示未定价。
 *
 * 注意：这里刻意不做「自己读目录文件算价」——实测 tokscale 的源优先级与键归一化规则比
 * 看上去复杂（贪心直读在 gpt-5.5 / gemini 系列上会给出 2 倍偏差），唯一正确的价格来源
 * 仍是 `tokscale pricing`。要做到不卡，靠的是让它的目录缓存始终处于有效窗口内。
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

  const task = (async (): Promise<{ value: CatalogPrice | null; cacheable: boolean }> => {
    // 询价前把目录时间戳续到有效窗口内。tokscale 只在时间戳落于 [now-60min, now] 时
    // 才认缓存；过期就会联网重拉，任一上游不通时每次都要等满 30s（且失败不刷新时间戳，
    // 于是「每次切周期都慢」）。续期是本地改文件头，毫秒级。
    const check = ensureCatalogFresh();
    // 刚从快照播种过 ⇒ 可能落后于上游，顺手让后台真刷一遍（不占用户路径）
    if (check.seeded.length > 0) void refreshCatalog();

    const outcome = await queryPrice(model);
    if (outcome.kind === "price") return { value: outcome.price, cacheable: true };
    // 上游确实没有这个模型（占位 id 等）—— 正常结果，直接记未定价，绝不触发联网
    if (outcome.kind === "unpriced") return { value: null, cacheable: true };

    // 命令本身失败（目录损坏/被杀/超时）：让后台刷一遍，但仍不等它 —— 用户路径必须立刻返回
    void refreshCatalog();
    return { value: null, cacheable: false };
  })();

  inflight.set(model, task.then((r) => r.value));
  try {
    const result = await task;
    // 只有确定的结论才进缓存；「本次失败」不缓存，下次扫描才有机会纠正
    if (result.cacheable) memoryCache.set(model, result.value);
    return result.value;
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
