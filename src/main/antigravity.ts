import { runTokscale } from "./tokscale";

/**
 * Antigravity 的用量拿不到「文件解析」这条路 —— 它只存在于运行中的语言服务器里，
 * 必须先由 `tokscale antigravity sync` 抓进本地缓存（%APPDATA%\tokscale\antigravity-cache），
 * 之后的报表才读得到。app 过去从不调它，所以缓存一直停在很久以前的日期
 * （实测那台机器 last synced 停在十几天前）。
 *
 * 实测：语言服务器没开时这个命令也会正常返回（~0.4s，抓到 0 条），不会挂起；
 * 所以「启动时跑一次 + 每 6 小时跑一次」是安全的。
 */
const SYNC_TIMEOUT_MS = 15_000;
const MIN_INTERVAL_MS = 30_000;

export type AntigravitySyncResult = {
  ok: boolean;
  ms: number;
  /** 命令输出里的 cached sessions；抓不到就是 null */
  cachedSessions: number | null;
  detail: string;
};

let running: Promise<AntigravitySyncResult> | null = null;
let lastSyncAt = 0;
let lastSuccessAt = 0;
let lastCachedSessions: number | null = null;

export function getLastAntigravitySyncAt(): number {
  return lastSuccessAt;
}

export function syncAntigravity(force = false): Promise<AntigravitySyncResult> {
  const now = Date.now();
  if (!force && now - lastSyncAt < MIN_INTERVAL_MS) {
    return Promise.resolve({
      ok: true,
      ms: 0,
      cachedSessions: lastCachedSessions,
      detail: "跳过（30 秒冷却内）"
    });
  }

  if (running) return running;
  lastSyncAt = now;

  running = (async (): Promise<AntigravitySyncResult> => {
    const started = Date.now();
    try {
      const out = await runTokscale(["antigravity", "sync"], { timeoutMs: SYNC_TIMEOUT_MS });
      const match =
        /cached sessions after sync:\s*(\d+)/i.exec(out) ?? /cached sessions:\s*(\d+)/i.exec(out);
      const count = match ? Number(match[1]) : null;
      const tail = out.trim().split("\n").filter(Boolean).slice(-1)[0] ?? "";
      lastSuccessAt = Date.now();
      if (count !== null) lastCachedSessions = count;
      return {
        ok: true,
        ms: Date.now() - started,
        cachedSessions: count,
        detail: tail.trim()
      };
    } catch (error) {
      return {
        ok: false,
        ms: Date.now() - started,
        cachedSessions: lastCachedSessions,
        detail: error instanceof Error ? error.message : String(error)
      };
    }
  })();
  void running.finally(() => {
    running = null;
  });
  return running;
}
