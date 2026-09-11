export type ClientId = "codex" | "hermes" | "antigravity" | "grok";

export const CLIENT_IDS: ClientId[] = ["codex", "hermes", "antigravity", "grok"];

export const CLIENT_LABELS: Record<ClientId, string> = {
  codex: "Codex",
  hermes: "Hermes",
  antigravity: "Antigravity",
  grok: "Grok"
};

export const CLIENT_CLIENTS_CSV = CLIENT_IDS.join(",");

export type Period = "today" | "yesterday" | "week" | "month" | "year";

export const PERIODS: Period[] = ["today", "yesterday", "week", "month", "year"];

export const PERIOD_LABELS: Record<Period, string> = {
  today: "今日",
  yesterday: "昨日",
  week: "近 7 天",
  month: "本月",
  year: "本年"
};

export type TokenBreakdown = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
};

export type ModelUsage = {
  model: string;
  tokens: TokenBreakdown;
  totalTokens: number;
  messages: number;
  /** null = 未定价 */
  cost: number | null;
};

export type ClientUsage = {
  client: ClientId;
  label: string;
  tokens: TokenBreakdown;
  totalTokens: number;
  messages: number;
  cost: number | null;
  models: ModelUsage[];
};

export type UsageResult = {
  period: Period;
  clients: ClientUsage[];
  totalTokens: number;
  totalMessages: number;
  totalCost: number;
  /** 有模型没有价格时为 true，界面显示「未定价」提示 */
  hasUnpriced: boolean;
  generatedAt: string;
  scanMs: number;
};

/**
 * 皮肤 id。
 * light / dark 是 0.1.3 及更早在 config.json 与 localStorage 里用过的历史 id，
 * **不可改名**（改名要写配置迁移）；菜单里显示的中文名见 renderer/theme.ts 的 SKINS。
 * 顺序即菜单顺序。
 */
export const THEME_IDS = ["light", "dark", "neon", "paper", "cyber"] as const;
export type ThemeName = (typeof THEME_IDS)[number];

/** 新装默认皮肤（与 0.1.3 的默认一致，改这个只影响全新机器） */
export const DEFAULT_THEME: ThemeName = "light";

/** 读回来的值可能是旧版本写的、手改的、或别的类型，一律收敛到这个判断 */
export function isThemeName(value: unknown): value is ThemeName {
  return typeof value === "string" && (THEME_IDS as readonly string[]).includes(value);
}

/**
 * 自动更新状态机（主进程 → 渲染层推送）。
 * dev / portable 是「不参与更新」的两种形态，其余为 electron-updater 事件。
 */
export type UpdateState =
  | "idle"
  | "dev"
  | "portable"
  | "checking"
  | "available"
  | "downloading"
  | "downloaded"
  | "none"
  | "error";

export type UpdateStatus = {
  state: UpdateState;
  currentVersion: string;
  latestVersion?: string;
  percent?: number;
  message?: string;
  checkedAt?: string;
};

export type AppConfig = {
  refreshIntervalSeconds: number;
  autoRefreshEnabled: boolean;
  autostart: boolean;
  /** 鼠标离开可见面板约 0.6 秒后自动收起面板（默认开） */
  autoHideOnMouseLeave: boolean;
  theme: ThemeName;
  configPath: string;
  pricingPath: string;
  pricingPathExists: boolean;
  appVersion: string;
  tokscaleVersion: string;
  portable: boolean;
  /** 主进程推送的自动更新状态（get_app_config 时附带） */
  update?: UpdateStatus;
};

export const EMPTY_BREAKDOWN: TokenBreakdown = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  reasoning: 0
};

export function sumBreakdown(t: TokenBreakdown): number {
  return t.input + t.output + t.cacheRead + t.cacheWrite + t.reasoning;
}
