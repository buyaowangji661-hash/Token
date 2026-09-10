import { app } from "electron";
import fs from "node:fs";
import path from "node:path";
import type { ThemeName } from "../shared/types";

export type StoredConfig = {
  refreshIntervalSeconds: number;
  autoRefreshEnabled: boolean;
  autostart: boolean;
  theme: ThemeName;
  /** 已完成「旧默认 5 分钟 → 1 分钟」一次性迁移的标记，避免反复覆盖用户后来的选择 */
  refreshMigrated?: boolean;
};

const DEFAULTS: StoredConfig = {
  // 60 秒：用户看的是「正在消耗的今日用量」，5 分钟太久会让人以为数字不动了
  refreshIntervalSeconds: 60,
  autoRefreshEnabled: true,
  autostart: false,
  // 默认浅色皮肤；用户点过皮肤开关后以 config.json 存的为准
  theme: "light"
};

/** 0.1.2 及更早的默认刷新间隔；只在一次性迁移里用来识别「没动过这个设置」的老配置 */
const LEGACY_REFRESH_SECONDS = 300;

export function userDataPath(): string {
  return app.getPath("userData");
}

export function configPath(): string {
  return path.join(userDataPath(), "config.json");
}

export function pricingPath(): string {
  return path.join(userDataPath(), "pricing.json");
}

export function readConfig(): StoredConfig {
  let parsed: Partial<StoredConfig>;
  try {
    parsed = JSON.parse(fs.readFileSync(configPath(), "utf8")) as Partial<StoredConfig>;
  } catch {
    return { ...DEFAULTS };
  }
  const next: StoredConfig = {
    refreshIntervalSeconds:
      typeof parsed.refreshIntervalSeconds === "number" && parsed.refreshIntervalSeconds >= 30
        ? Math.round(parsed.refreshIntervalSeconds)
        : DEFAULTS.refreshIntervalSeconds,
    autoRefreshEnabled:
      typeof parsed.autoRefreshEnabled === "boolean" ? parsed.autoRefreshEnabled : DEFAULTS.autoRefreshEnabled,
    autostart: typeof parsed.autostart === "boolean" ? parsed.autostart : DEFAULTS.autostart,
    // 缺失或非法时回落到默认的浅色
    theme: parsed.theme === "dark" ? "dark" : "light",
    refreshMigrated: parsed.refreshMigrated === true
  };

  // 一次性迁移：老版本默认 5 分钟，用户嫌「数字不动」；只迁移**恰好等于旧默认值**的配置，
  // 用户自己选过的间隔（15/30 分钟）不动。迁完立刻打标记，否则他之后在设置页选回 5 分钟
  // 会被每次读配置时又改回 1 分钟。
  if (!next.refreshMigrated) {
    if (parsed.refreshIntervalSeconds === LEGACY_REFRESH_SECONDS) {
      next.refreshIntervalSeconds = DEFAULTS.refreshIntervalSeconds;
    }
    next.refreshMigrated = true;
    // 直接落盘：这里不能走 writeConfig，它会回头再调 readConfig 形成递归
    persistConfig(next);
  }
  return next;
}

function persistConfig(next: StoredConfig): void {
  try {
    fs.mkdirSync(userDataPath(), { recursive: true });
    const tmp = `${configPath()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2), "utf8");
    fs.renameSync(tmp, configPath());
  } catch {
    /* 迁移失败不影响本次读取：内存里已是迁移后的值 */
  }
}

export function writeConfig(patch: Partial<StoredConfig>): StoredConfig {
  const next: StoredConfig = { ...readConfig(), ...patch, refreshMigrated: true };
  persistConfig(next);
  return next;
}

export type PricingOverride = {
  input_per_million?: number;
  output_per_million?: number;
  cache_read_per_million?: number;
  cache_write_per_million?: number;
};

export type PricingFile = {
  /** 模型 id -> 每百万 token 单价（美元） */
  models?: Record<string, PricingOverride>;
  /** 显式设为 true 时，Grok 用 CLI 自带的 costUsdTicks 折算，而不是定价目录（缺省 false） */
  grokUseRecordedCost?: boolean;
};

export function readPricingFile(): PricingFile {
  try {
    const raw = fs.readFileSync(pricingPath(), "utf8");
    const parsed = JSON.parse(raw) as PricingFile;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function pricingPathExists(): boolean {
  try {
    return fs.existsSync(pricingPath());
  } catch {
    return false;
  }
}
