import { app } from "electron";
import fs from "node:fs";
import path from "node:path";
import type { ThemeName } from "../shared/types";

export type StoredConfig = {
  refreshIntervalSeconds: number;
  autoRefreshEnabled: boolean;
  autostart: boolean;
  theme: ThemeName;
};

const DEFAULTS: StoredConfig = {
  refreshIntervalSeconds: 300,
  autoRefreshEnabled: true,
  autostart: false,
  // 默认浅色皮肤；用户点过皮肤开关后以 config.json 存的为准
  theme: "light"
};

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
  try {
    const raw = fs.readFileSync(configPath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<StoredConfig>;
    return {
      refreshIntervalSeconds:
        typeof parsed.refreshIntervalSeconds === "number" && parsed.refreshIntervalSeconds >= 30
          ? Math.round(parsed.refreshIntervalSeconds)
          : DEFAULTS.refreshIntervalSeconds,
      autoRefreshEnabled:
        typeof parsed.autoRefreshEnabled === "boolean" ? parsed.autoRefreshEnabled : DEFAULTS.autoRefreshEnabled,
      autostart: typeof parsed.autostart === "boolean" ? parsed.autostart : DEFAULTS.autostart,
      // 缺失或非法时回落到默认的浅色
      theme: parsed.theme === "dark" ? "dark" : "light"
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export function writeConfig(patch: Partial<StoredConfig>): StoredConfig {
  const next: StoredConfig = { ...readConfig(), ...patch };
  fs.mkdirSync(userDataPath(), { recursive: true });
  const tmp = `${configPath()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), "utf8");
  fs.renameSync(tmp, configPath());
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
