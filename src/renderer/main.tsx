import React from "react";
import ReactDOM from "react-dom/client";
import {
  Activity,
  ArrowDown,
  ArrowUp,
  Brain,
  CalendarDays,
  Check,
  ChevronDown,
  ChevronRight,
  Coins,
  Copy,
  FolderOpen,
  Info,
  Layers,
  Power,
  RefreshCw,
  Settings as SettingsIcon,
  Shirt,
  Sparkles,
  X,
  Zap
} from "lucide-react";
import {
  CLIENT_IDS,
  CLIENT_LABELS,
  PERIODS,
  PERIOD_LABELS,
  type AppConfig,
  type ClientId,
  type ClientUsage,
  type Period,
  type ThemeName,
  type UpdateStatus,
  type UsageResult
} from "../shared/types";
import { invoke, listen } from "./tauri-shim";
import { SKINS, THEME_STORAGE_KEY } from "./theme";
import type { Skin } from "./theme";
import "./styles.css";
import "./extra.css";
import "./theme.css";

type ViewName = "dashboard" | "settings";
type LoadState = "loading" | "ok" | "error";

const CLIENT_THEMES: Record<ClientId, { label: string; dotClass: string }> = {
  codex: { label: "Codex", dotClass: "dot-codex" },
  hermes: { label: "Hermes", dotClass: "dot-hermes" },
  antigravity: { label: "Antigravity", dotClass: "dot-antigravity" },
  grok: { label: "Grok", dotClass: "dot-grok" }
};

const fmtInt = (n: number) => Math.round(n).toLocaleString("en-US");

/** 中文数量级：1 万以下原样（带千分位），1 万~1 亿用「万」，1 亿以上用「亿」 */
const fmtUnits = (n: number): { num: string; unit: string } => {
  const abs = Math.abs(n);
  if (abs >= 1e8) {
    return { num: (n / 1e8).toLocaleString("en-US", { maximumFractionDigits: 2 }), unit: "亿" };
  }
  if (abs >= 1e4) {
    return { num: (n / 1e4).toLocaleString("en-US", { maximumFractionDigits: 1 }), unit: "万" };
  }
  return { num: fmtInt(n), unit: "" };
};

const fmtTokensFancy = fmtUnits;

const fmtTokensMetric = (n: number): string => {
  const { num, unit } = fmtUnits(n);
  return `${num}${unit}`;
};

/** 单价（每百万 token）→ $1.4 / $0.15 / — */
const fmtPrice = (n: number | null) =>
  n === null ? "—" : `$${n.toLocaleString("en-US", { maximumFractionDigits: 4 })}`;

const fmtMoney = (n: number | null) => {
  if (n === null) return "未定价";
  if (n >= 1000) return `$${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
  if (n >= 1) return `$${n.toFixed(2)}`;
  if (n > 0) return `$${n.toFixed(4)}`;
  return "$0.00";
};

const hitRateOf = (tokens: { cacheRead: number; input: number }) => {
  const cached = tokens.cacheRead;
  const uncached = tokens.input;
  if (cached + uncached <= 0) return null;
  return Math.round((cached / (cached + uncached)) * 100);
};

// 皮肤菜单里的一枚色卡：用面板底/强调色/卡片底/文字色拼一个小预览
function SkinSwatch({ skin }: { skin: Skin }) {
  const [panel, accent, card, text] = skin.swatch;
  return (
    <span className="skin-swatch" aria-hidden="true" style={{ background: panel }}>
      <span className="skin-swatch-card" style={{ background: card, borderColor: text }} />
      <span className="skin-swatch-accent" style={{ background: accent }} />
    </span>
  );
}

// 与 index.html 内联脚本保持同一读法：只认白名单里的 id，其余一律回落默认
function readStoredTheme(): ThemeName {
  let saved: string | null = null;
  try {
    saved = localStorage.getItem(THEME_STORAGE_KEY);
  } catch {
    saved = null;
  }
  return SKINS.some((skin) => skin.id === saved) ? (saved as ThemeName) : "light";
}

function CircularProgress({
  percent,
  color = "var(--brand)"
}: {
  percent: number | null;
  color?: string;
}) {
  const size = 32;
  const strokeWidth = 3.5;
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const validPercent = percent === null ? 0 : Math.min(100, Math.max(0, percent));
  const strokeDashoffset = circumference - (validPercent / 100) * circumference;

  return (
    <div className="circular-gauge" title={percent !== null ? `缓存命中率 ${percent}%` : "无缓存记录"}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="var(--gauge-track)"
          strokeWidth={strokeWidth}
        />
        {percent !== null && (
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            stroke={color}
            strokeWidth={strokeWidth}
            strokeDasharray={circumference}
            strokeDashoffset={strokeDashoffset}
            strokeLinecap="round"
            transform={`rotate(-90 ${size / 2} ${size / 2})`}
            style={{ transition: "stroke-dashoffset 0.6s cubic-bezier(0.4, 0, 0.2, 1)" }}
          />
        )}
      </svg>
    </div>
  );
}

function App() {
  const [view, setView] = React.useState<ViewName>("dashboard");
  const [period, setPeriod] = React.useState<Period>("week");
  const [activeClient, setActiveClient] = React.useState<ClientId>("codex");
  const [usage, setUsage] = React.useState<UsageResult | null>(null);
  const [loadState, setLoadState] = React.useState<LoadState>("loading");
  const [loadError, setLoadError] = React.useState("");
  const [config, setConfig] = React.useState<AppConfig | null>(null);
  const [update, setUpdate] = React.useState<UpdateStatus | null>(null);
  // 初值只作兜底：index.html 的内联脚本已经读同一份 localStorage 把 data-theme 设好了，
  // 下面这个读法必须与它一致，否则首帧之后再被 setTheme 改成另一套 = 闪一下。
  const [theme, setTheme] = React.useState<ThemeName>(() => readStoredTheme());
  const periodRef = React.useRef(period);
  periodRef.current = period;

  React.useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);

  const loadUsage = React.useCallback((next: Period) => {
    setLoadState("loading");
    invoke<UsageResult | null>("fetch_usage", { period: next })
      .then((result) => {
        if (!result) return;
        setUsage(result);
        setLoadState("ok");
        setLoadError("");
      })
      .catch((error: unknown) => {
        const msg = error instanceof Error ? error.message : String(error);
        if (msg.includes("已取消")) return;
        setLoadState("error");
        setLoadError(msg);
      });
  }, []);

  React.useEffect(() => {
    invoke<AppConfig>("get_app_config")
      .then((next) => {
        setConfig(next);
        setUpdate(next.update ?? null);
        setTheme(next.theme);
        localStorage.setItem(THEME_STORAGE_KEY, next.theme);
      })
      .catch(() => undefined);
  }, []);

  React.useEffect(() => {
    loadUsage(period);
  }, [period, loadUsage]);

  React.useEffect(() => {
    const offs: Array<() => void> = [];
    void listen<UsageResult>("usage-updated", (event) => {
      // 后台刷新推来的周期可能与当前视图不一致（例如用户刚切到「今日」），丢弃避免标签与数字错配
      if (event.payload.period !== periodRef.current) return;
      setUsage(event.payload);
      setLoadState("ok");
    }).then((off) => offs.push(off));
    void listen<string>("usage-error", (event) => {
      setLoadState("error");
      setLoadError(String(event.payload));
    }).then((off) => offs.push(off));
    void listen<ViewName>("navigate", (event) => setView(event.payload)).then((off) => offs.push(off));
    void listen<null>("refresh-requested", () => loadUsage(periodRef.current)).then((off) => offs.push(off));
    void listen<UpdateStatus>("update-status", (event) => setUpdate(event.payload)).then((off) => offs.push(off));
    return () => offs.forEach((off) => off());
  }, [loadUsage]);

  const pickTheme = React.useCallback((next: ThemeName) => {
    setTheme(next);
    localStorage.setItem(THEME_STORAGE_KEY, next);
    void invoke<AppConfig>("save_theme", { theme: next }).catch(() => undefined);
  }, []);

  // 设置页「折算价格」用：当前周期出现过的模型，按 token 降序
  const modelList = React.useMemo(() => {
    const map = new Map<string, number>();
    for (const client of usage?.clients ?? []) {
      for (const model of client.models) {
        map.set(model.model, (map.get(model.model) ?? 0) + model.totalTokens);
      }
    }
    return [...map.entries()]
      .map(([id, tokens]) => ({ id, tokens }))
      .sort((a, b) => b.tokens - a.tokens);
  }, [usage]);

  return (
    <>
      {view === "dashboard" && (
        <DashboardPanel
          usage={usage}
          loadState={loadState}
          loadError={loadError}
          period={period}
          activeClient={activeClient}
          theme={theme}
          onPeriod={setPeriod}
          onSelectClient={setActiveClient}
          onRefresh={() => loadUsage(period)}
          onPickTheme={pickTheme}
          onSettings={() => setView("settings")}
          onClose={() => void invoke("hide_main_window").catch(() => undefined)}
        />
      )}
      {view === "settings" && (
        <SettingsPanel
          config={config}
          models={modelList}
          update={update}
          onConfig={setConfig}
          onBack={() => setView("dashboard")}
          onClose={() => void invoke("hide_main_window").catch(() => undefined)}
        />
      )}
    </>
  );
}

function DashboardPanel({
  usage,
  loadState,
  loadError,
  period,
  activeClient,
  theme,
  onPeriod,
  onSelectClient,
  onRefresh,
  onPickTheme,
  onSettings,
  onClose
}: {
  usage: UsageResult | null;
  loadState: LoadState;
  loadError: string;
  period: Period;
  activeClient: ClientId;
  theme: ThemeName;
  onPeriod: (period: Period) => void;
  onSelectClient: (client: ClientId) => void;
  onRefresh: () => void;
  onPickTheme: (theme: ThemeName) => void;
  onSettings: () => void;
  onClose: () => void;
}) {
  const loading = loadState === "loading";
  const clients = usage?.clients ?? [];
  const activeUsage = clients.find((c) => c.client === activeClient) ?? null;
  const [skinMenuOpen, setSkinMenuOpen] = React.useState(false);

  // 点面板别处 / 按 Esc 收起皮肤菜单；只监听点击，不吞掉事件，避免影响拖拽与其它按钮
  React.useEffect(() => {
    if (!skinMenuOpen) return;
    const onDocClick = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest(".skin-menu-wrap")) return;
      setSkinMenuOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSkinMenuOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [skinMenuOpen]);

  return (
    <section className="panel dashboard-panel" data-testid="dashboard-panel">
      {/* 顶部标题与全局状态栏 */}
      <header className="panel-header">
        <div className="title-lockup">
          <BrandIcon size={32} />
          <div className="title-text-group">
            <h1>Token</h1>
          </div>
        </div>

        {/* 全平台总计胶囊 */}
        {usage && loadState === "ok" && (
          <div className="global-overview-pill" title="全平台汇总">
            <span className="overview-item">
              <strong className="overview-num">{fmtTokensFancy(usage.totalTokens).num}</strong>
              <small>{fmtTokensFancy(usage.totalTokens).unit || "Tokens"}</small>
            </span>
            <span className="overview-sep">·</span>
            <span className="overview-item font-money">{fmtMoney(usage.totalCost)}</span>
          </div>
        )}

        <div className="header-actions">
          <button aria-label="刷新" onClick={onRefresh} title="重新扫描">
            <RefreshCw size={18} className={loading ? "spin" : ""} />
          </button>
          <div className="skin-menu-wrap">
            <button
              aria-label="切换皮肤"
              aria-haspopup="menu"
              aria-expanded={skinMenuOpen}
              className="skin-toggle"
              title="切换皮肤"
              onClick={() => setSkinMenuOpen((open) => !open)}
            >
              <Shirt size={18} />
            </button>
            {skinMenuOpen && (
              <div className="skin-menu" role="menu" data-testid="skin-menu">
                {SKINS.map((skin) => (
                  <button
                    key={skin.id}
                    role="menuitemradio"
                    aria-checked={skin.id === theme}
                    className={`skin-item ${skin.id === theme ? "selected" : ""}`}
                    onClick={() => {
                      setSkinMenuOpen(false);
                      onPickTheme(skin.id);
                    }}
                  >
                    <SkinSwatch skin={skin} />
                    <span className="skin-item-name">{skin.name}</span>
                    {skin.id === theme && <Check size={13} className="skin-item-check" />}
                  </button>
                ))}
              </div>
            )}
          </div>
          <button aria-label="设置" onClick={onSettings} title="设置">
            <SettingsIcon size={18} />
          </button>
          <button aria-label="关闭" onClick={onClose} title="隐藏窗口">
            <X size={20} />
          </button>
        </div>
      </header>

      {/* 周期切换栏 (5 个周期) */}
      <div className="period-row">
        {PERIODS.map((item) => (
          <button
            key={item}
            className={`period-btn ${period === item ? "selected" : ""}`}
            onClick={() => onPeriod(item)}
          >
            {PERIOD_LABELS[item]}
          </button>
        ))}
      </div>

      {/* 顶部 4 客户端切换 Tab */}
      <div className="client-tabs">
        {CLIENT_IDS.map((id) => {
          const clientData = clients.find((c) => c.client === id);
          const hasTokens = (clientData?.totalTokens ?? 0) > 0;
          const isSelected = activeClient === id;
          return (
            <button
              key={id}
              className={`client-tab ${id} ${isSelected ? "selected " + id : ""} ${!hasTokens ? "dim" : ""}`}
              onClick={() => onSelectClient(id)}
              title={`${CLIENT_LABELS[id]} 用量`}
            >
              <span className="client-tab-name">{CLIENT_LABELS[id]}</span>
              <span className="client-tab-val">
                {hasTokens ? fmtTokensMetric(clientData!.totalTokens) : "0"}
              </span>
            </button>
          );
        })}
      </div>

      {/* 错误提示 */}
      {loadState === "error" && (
        <div className="card client-empty error-card">{loadError || "读取本地数据失败"}</div>
      )}

      {/* 选中的客户端卡片式展示 (参考图片布局) */}
      <ClientCardDetail
        clientId={activeClient}
        usage={activeUsage}
        period={period}
        loading={loading}
      />

      {/* 底部扫描注脚 */}
      {usage && (
        <div className="scan-note">
          扫描 {usage.scanMs} ms · 更新于 {new Date(usage.generatedAt).toLocaleTimeString("zh-CN")}
          {usage.hasUnpriced ? " · 含未定价模型" : ""}
        </div>
      )}
    </section>
  );
}

function ClientCardDetail({
  clientId,
  usage,
  period,
  loading
}: {
  clientId: ClientId;
  usage: ClientUsage | null;
  period: Period;
  loading: boolean;
}) {
  const [expanded, setExpanded] = React.useState(true);
  const [copied, setCopied] = React.useState(false);

  const theme = CLIENT_THEMES[clientId];
  const hasData = (usage?.totalTokens ?? 0) > 0;
  const fancyTotal = fmtTokensFancy(usage?.totalTokens ?? 0);
  const hitRate = usage ? hitRateOf(usage.tokens) : null;
  const models = usage?.models ?? [];
  const maxModelTokens = Math.max(...models.map((m) => m.totalTokens), 1);

  const copySummary = () => {
    if (!usage) return;
    const text = `${theme.label} (${PERIOD_LABELS[period]}): ${fmtTokensMetric(usage.totalTokens)} Tokens, 成本 ${fmtMoney(
      usage.cost
    )}, 请求数 ${usage.messages}`;
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <article className="card client-card-main">
      {/* 头部：彩色光点 + 名称 + 计数徽标 + 复制按钮 */}
      <div className="client-box-header">
        <div className="client-header-title">
          <span className={`client-status-dot ${theme.dotClass}`} />
          <h2 className="client-name">{theme.label}</h2>
          <span className="client-count-pill" title="请求/消息数">
            {usage?.messages ?? 0}
          </span>
        </div>
        <div className="client-header-actions">
          <button
            className="card-mini-btn"
            onClick={copySummary}
            title={copied ? "已复制概要" : "复制当前统计概要"}
            disabled={!hasData}
          >
            {copied ? <Check size={13} className="text-success" /> : <Copy size={13} />}
          </button>
        </div>
      </div>

      {/* 大字总量 */}
      <div className="client-hero-stat">
        <div className="hero-number-wrap">
          <span className="hero-number">{hasData ? fancyTotal.num : "0"}</span>
          {fancyTotal.unit && <span className="hero-unit">{fancyTotal.unit}</span>}
        </div>
        <span className="hero-label">{PERIOD_LABELS[period]} 总量</span>
      </div>

      {/* 核心指标 2 列网格 (Card-Style Metrics Grid) */}
      <div className="card-metrics-grid">
        {/* Row 1: 成本 & Cache Hit */}
        <div className="card-metric-cell">
          <div className="cell-label">
            <Coins size={13} className="cell-icon text-gold" />
            <span>≈成本</span>
          </div>
          <div className="cell-value font-money">
            {usage ? fmtMoney(usage.cost) : "$0.00"}
          </div>
        </div>

        <div className="card-metric-cell">
          <div className="cell-label">
            <span>Cache Hit</span>
          </div>
          <div className="cell-value hit-group">
            <CircularProgress percent={hitRate} color={`var(--${clientId})`} />
            <span className="hit-text">{hitRate !== null ? `${hitRate}%` : "—"}</span>
          </div>
        </div>

        {/* Row 2: 输入 & 缓存读 */}
        <div className="card-metric-cell">
          <div className="cell-label">
            <ArrowDown size={13} className="cell-icon text-down" />
            <span>输入</span>
          </div>
          <div className="cell-value">{usage ? fmtTokensMetric(usage.tokens.input) : "0"}</div>
        </div>

        <div className="card-metric-cell">
          <div className="cell-label">
            <Zap size={13} className="cell-icon text-zap" />
            <span>缓存读</span>
          </div>
          <div className="cell-value">{usage ? fmtTokensMetric(usage.tokens.cacheRead) : "0"}</div>
        </div>

        {/* Row 3: 输出 & (推理 或 缓存写 或 请求) */}
        <div className="card-metric-cell">
          <div className="cell-label">
            <ArrowUp size={13} className="cell-icon text-up" />
            <span>输出</span>
          </div>
          <div className="cell-value">{usage ? fmtTokensMetric(usage.tokens.output) : "0"}</div>
        </div>

        {(usage?.tokens.reasoning ?? 0) > 0 ? (
          <div className="card-metric-cell">
            <div className="cell-label">
              <Brain size={13} className="cell-icon text-brain" />
              <span>推理</span>
            </div>
            <div className="cell-value">{fmtTokensMetric(usage!.tokens.reasoning)}</div>
          </div>
        ) : (usage?.tokens.cacheWrite ?? 0) > 0 ? (
          <div className="card-metric-cell">
            <div className="cell-label">
              <Layers size={13} className="cell-icon text-layers" />
              <span>缓存写</span>
            </div>
            <div className="cell-value">{fmtTokensMetric(usage!.tokens.cacheWrite)}</div>
          </div>
        ) : (
          <div className="card-metric-cell">
            <div className="cell-label">
              <RefreshCw size={13} className="cell-icon text-muted" />
              <span>请求</span>
            </div>
            <div className="cell-value">{usage ? fmtInt(usage.messages) : "0"}</div>
          </div>
        )}

        {/* Row 4 (若同时存在推理和缓存写，补充展示) */}
        {(usage?.tokens.reasoning ?? 0) > 0 && (usage?.tokens.cacheWrite ?? 0) > 0 && (
          <>
            <div className="card-metric-cell">
              <div className="cell-label">
                <Layers size={13} className="cell-icon text-layers" />
                <span>缓存写</span>
              </div>
              <div className="cell-value">{fmtTokensMetric(usage!.tokens.cacheWrite)}</div>
            </div>
            <div className="card-metric-cell">
              <div className="cell-label">
                <RefreshCw size={13} className="cell-icon text-muted" />
                <span>请求</span>
              </div>
              <div className="cell-value">{usage ? fmtInt(usage.messages) : "0"}</div>
            </div>
          </>
        )}
      </div>

      {/* 折叠明细：按模型 (N) */}
      <div className="client-models-accordion">
        <button
          className={`accordion-trigger ${expanded ? "expanded" : ""}`}
          onClick={() => setExpanded(!expanded)}
          disabled={models.length === 0}
          data-testid="models-trigger"
        >
          <span className="trigger-left">
            <span className={`trigger-dot ${theme.dotClass}`} />
            <span>按模型 ({models.length})</span>
          </span>
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </button>

        {expanded && models.length > 0 && (
          <div className="models-dropdown-list">
            <div className="dropdown-list-header">按模型 · {PERIOD_LABELS[period]}</div>
            {models.map((item) => {
              const modelHit = hitRateOf(item.tokens);
              return (
                <div key={item.model} className="model-compact-row">
                  <div className="model-name-line">
                    <ChevronRight size={11} className="row-arrow" />
                    <span className="model-name-text" title={item.model}>
                      {item.model}
                    </span>
                    <span className="model-tokens-badge">{fmtTokensMetric(item.totalTokens)}</span>
                    {modelHit !== null && (
                      <span className="model-hit-tag">{modelHit}%</span>
                    )}
                    <span className="model-cost-tag">{fmtMoney(item.cost)}</span>
                  </div>
                  <div className="model-progress-bar">
                    <div
                      className={`bar-fill ${clientId}`}
                      style={{ width: `${Math.max(3, (item.totalTokens / maxModelTokens) * 100)}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {!hasData && !loading && (
          <div className="client-empty">本地暂无该客户端用量记录</div>
        )}
      </div>
    </article>
  );
}

const REFRESH_OPTIONS = [
  { value: 60, label: "1 分钟" },
  { value: 300, label: "5 分钟" },
  { value: 900, label: "15 分钟" },
  { value: 1800, label: "30 分钟" }
];

/** 关于 → 更新状态文案 */
function updateLabel(update: UpdateStatus | null, config: AppConfig | null): string {
  if (!update) return config?.portable ? "便携版不支持自动更新" : "待检查";
  switch (update.state) {
    case "dev":
      return "开发模式，不检查更新";
    case "portable":
      return "便携版不支持自动更新";
    case "checking":
      return "检查中…";
    case "available":
      return `发现 v${update.latestVersion ?? ""}，下载中…`;
    case "downloading":
      return `下载中 ${update.percent ?? 0}%`;
    case "downloaded":
      return `v${update.latestVersion ?? ""} 已就绪`;
    case "none":
      return "已是最新版本";
    case "error":
      return update.message ?? "更新失败";
    default:
      return "待检查";
  }
}

function updateClass(update: UpdateStatus | null): string {
  if (!update) return "";
  if (update.state === "error") return "text-error";
  if (update.state === "downloaded" || update.state === "none") return "text-success";
  return "";
}

type ModelPriceRow = {
  input: number | null;
  output: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
  /** true = 来自本地 pricing.json 覆盖表 */
  local: boolean;
};

function SettingsPanel({
  config,
  models,
  update,
  onConfig,
  onBack,
  onClose
}: {
  config: AppConfig | null;
  /** 当前周期出现过的模型及其 token 数（按 token 降序） */
  models: Array<{ id: string; tokens: number }>;
  update: UpdateStatus | null;
  onConfig: (config: AppConfig) => void;
  onBack: () => void;
  onClose: () => void;
}) {
  const [status, setStatus] = React.useState("");
  const [note, setCheckedNote] = React.useState("");
  const [priceOpen, setPriceOpen] = React.useState(false);
  const [priceMap, setPriceMap] = React.useState<Record<string, ModelPriceRow> | null>(null);

  // 默认折叠：首次展开才去主进程取单价（走扫描时已建好的价格缓存，不额外扫描）
  React.useEffect(() => {
    if (!priceOpen || priceMap !== null || models.length === 0) return;
    let alive = true;
    void invoke<Record<string, ModelPriceRow>>("get_model_prices", { models: models.map((item) => item.id) })
      .then((result) => {
        if (alive) setPriceMap(result);
      })
      .catch(() => {
        if (alive) setPriceMap({});
      });
    return () => {
      alive = false;
    };
  }, [priceOpen, priceMap, models]);
  const refresh = config?.refreshIntervalSeconds ?? 300;
  const autoRefresh = config?.autoRefreshEnabled ?? true;
  const autostart = config?.autostart ?? false;

  const save = React.useCallback(
    (channel: string, args: Record<string, unknown>) => {
      void invoke<AppConfig>(channel, args)
        .then((next) => onConfig(next))
        .catch((error: unknown) => setStatus(error instanceof Error ? error.message : String(error)));
    },
    [onConfig]
  );

  return (
    <section className="settings-panel" data-testid="settings-panel">
      <button className="floating-close settings-close" onClick={onBack} aria-label="返回主面板">
        <X size={20} />
      </button>
      <div className="settings-inner">
        <header className="settings-header">
          <BrandIcon size={42} />
          <div>
            <h1>Token</h1>
            <p>设置</p>
          </div>
        </header>

        <SettingsSection icon={<Activity size={15} />} title="数据源">
          <div className="version-row">
            <span>tokscale 版本</span>
            <strong>{config?.tokscaleVersion ?? "—"}</strong>
          </div>
          <div className="version-row">
            <span>本地配置</span>
            <strong>{config?.configPath ?? "—"}</strong>
          </div>
        </SettingsSection>

        <SettingsSection icon={<Coins size={15} />} title="折算价格">
          <button
            className={`accordion-trigger price-trigger ${priceOpen ? "expanded" : ""}`}
            onClick={() => setPriceOpen(!priceOpen)}
            aria-expanded={priceOpen}
            data-testid="price-trigger"
          >
            <span className="trigger-left">
              <Coins size={14} className="brand-blue" />
              <span>模型单价（{models.length} 个）</span>
            </span>
            {priceOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </button>

          {priceOpen && (
            <div className="price-list" data-testid="price-list">
              <p className="muted">单位：美元 / 百万 tokens</p>
              {priceMap === null && <p className="muted">读取中…</p>}
              {priceMap !== null && models.length === 0 && <p className="muted">当前周期暂无模型用量</p>}
              {priceMap !== null &&
                models.map((item) => {
                  const price = priceMap[item.id];
                  return (
                    <div className="price-row" key={item.id}>
                      <div className="price-head">
                        <span className="price-name">{item.id}</span>
                        {price?.local && <span className="price-badge">本地</span>}
                        <span className="price-tokens">{fmtTokensMetric(item.tokens)}</span>
                      </div>
                      {price && price.input !== null ? (
                        <div className="price-cells">
                          <span>输入 {fmtPrice(price.input)}</span>
                          <span>输出 {fmtPrice(price.output)}</span>
                          <span>缓存读 {fmtPrice(price.cacheRead)}</span>
                          <span>缓存写 {fmtPrice(price.cacheWrite)}</span>
                        </div>
                      ) : (
                        <div className="price-cells muted">未定价</div>
                      )}
                    </div>
                  );
                })}
            </div>
          )}

          <div className="path-row">
            <code>{config?.pricingPath ?? "—"}</code>
            <button onClick={() => void invoke("open_pricing_file").catch(() => undefined)}>
              <FolderOpen size={12} /> 打开
            </button>
          </div>
        </SettingsSection>

        <SettingsSection icon={<RefreshCw size={15} />} title="自动刷新">
          <p>开启后按设定周期在后台重新扫描本地数据。</p>
          <Toggle
            label="启用自动刷新"
            checked={autoRefresh}
            onChange={(value) => save("save_auto_refresh_enabled", { autoRefreshEnabled: value })}
          />
          {autoRefresh && (
            <div className="segmented">
              {REFRESH_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  className={refresh === option.value ? "selected" : ""}
                  onClick={() => save("save_refresh_interval", { refreshIntervalSeconds: option.value })}
                >
                  {option.label}
                </button>
              ))}
            </div>
          )}
        </SettingsSection>

        <SettingsSection icon={<Power size={15} />} title="开机自启">
          <p>开启后，每次登录 Windows 时自动启动 Token 并常驻托盘。</p>
          <Toggle
            label="登录时自动启动"
            checked={autostart}
            onChange={(value) => save("save_autostart", { autostart: value })}
          />
        </SettingsSection>

        <SettingsSection
          icon={<Info size={15} />}
          title="关于"
          action={
            <button
              className="section-action"
              onClick={() => {
                setStatus("正在检查更新…");
                void invoke<UpdateStatus>("check_update")
                  .then((next) => {
                    setStatus("");
                    setCheckedNote(next.message ?? "");
                  })
                  .catch((error: unknown) => {
                    setStatus(error instanceof Error ? error.message : String(error));
                  });
              }}
            >
              <RefreshCw size={11} className={update?.state === "checking" ? "spin" : ""} /> 检查更新
            </button>
          }
        >
          <div className="version-row">
            <span>当前版本</span>
            <strong>v{config?.appVersion ?? "0.1.0"}</strong>
          </div>
          <div className="version-row">
            <span>更新状态</span>
            <strong className={updateClass(update)}>{updateLabel(update, config)}</strong>
          </div>
          {update?.state === "downloading" && (
            <div className="update-progress">
              <div className="update-bar" style={{ width: `${update.percent ?? 0}%` }} />
            </div>
          )}
          {update?.state === "downloaded" && (
            <button
              className="primary update-install"
              onClick={() => void invoke("install_update").catch(() => undefined)}
            >
              重启并安装 v{update.latestVersion}
            </button>
          )}
          {config?.portable && (
            <p className="muted">便携版不支持自动更新，请从 GitHub Releases 下载新版本。</p>
          )}
          {note && <p className="muted">{note}</p>}
          <div className="version-row">
            <span>界面</span>
            <strong>DeepSeek Monitor Windows 新版</strong>
          </div>
        </SettingsSection>

        {status && <p className="muted">{status}</p>}

        <button className="primary settings-done" onClick={onClose}>
          收起面板
        </button>
      </div>
    </section>
  );
}

function SettingsSection({
  icon,
  title,
  action,
  children
}: {
  icon: React.ReactNode;
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="settings-section">
      <h2>
        {icon}
        {title}
        {action}
      </h2>
      {children}
    </section>
  );
}

function Toggle({
  label,
  checked,
  onChange
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="toggle-row">
      <span>{label}</span>
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <i />
    </label>
  );
}

function BrandIcon({ size = 36 }: { size?: number }) {
  return (
    <span className="brand-icon" style={{ width: size, height: size }}>
      <svg viewBox="0 0 24 24" width={size * 0.58} height={size * 0.58} aria-hidden>
        <path d="M4 5.5h16M12 5.5V19" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" fill="none" />
        <circle cx="12" cy="19" r="2.1" fill="currentColor" />
      </svg>
    </span>
  );
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
