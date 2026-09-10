import { app, BrowserWindow, ipcMain, Menu, nativeImage, screen, shell, Tray } from "electron";
import fs from "node:fs";
import path from "node:path";
import type { AppConfig, Period, ThemeName, UsageResult } from "../shared/types";
import { syncAntigravity } from "./antigravity";
import { configPath, pricingPath, pricingPathExists, readConfig, readPricingFile, writeConfig } from "./config";
import { catalogStatus, ensureCatalogFresh, refreshCatalog } from "./priceCatalog";
import { clearPriceCache, getPrice } from "./pricing";
import { tokscaleVersion } from "./tokscale";
import { checkForUpdates, installUpdate, setupUpdater, updateStatus } from "./updater";
import { fetchUsage } from "./usage";

const DEV_URL = process.env.TOKEN_DEV_URL;
const WINDOW_WIDTH = 380;
const WINDOW_HEIGHT = 680;
/** 显示面板时，数据超过这个岁数就先静默重扫（避免频繁开合面板时反复扫描） */
const SHOW_REFRESH_STALE_MS = 15_000;

let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let refreshTimer: NodeJS.Timeout | null = null;
/** 后台维护定时器：Antigravity 抓取与定价目录刷新 */
let antigravityTimer: NodeJS.Timeout | null = null;
let catalogTimer: NodeJS.Timeout | null = null;
let tokscaleVersionText = "未知";
let scanAbort: AbortController | null = null;
/** 渲染层最近一次请求的周期；后台定时刷新沿用该周期，避免把「本月」数据推到「今日/近 7 天」视图 */
let lastPeriod: Period = "week";
/** 最近一次扫描完成时刻：用于「显示面板时若数据已陈旧就先刷一次」的判定 */
let lastScanAt = 0;

function assetPath(file: string): string {
  return path.join(__dirname, "..", "..", "assets", file);
}

function currentConfig(): AppConfig {
  const stored = readConfig();
  return {
    refreshIntervalSeconds: stored.refreshIntervalSeconds,
    autoRefreshEnabled: stored.autoRefreshEnabled,
    autostart: stored.autostart,
    theme: stored.theme,
    configPath: configPath(),
    pricingPath: pricingPath(),
    pricingPathExists: pricingPathExists(),
    appVersion: app.getVersion(),
    tokscaleVersion: tokscaleVersionText,
    portable: Boolean(process.env.PORTABLE_EXECUTABLE_DIR)
  };
}

function positionWindow(): void {
  if (!win) return;
  const { workArea } = screen.getPrimaryDisplay();
  const [width, height] = win.getSize();
  const x = Math.round(workArea.x + workArea.width - width - 12);
  const y = Math.round(workArea.y + workArea.height - height - 12);
  win.setPosition(x, y, false);
}

function showWindow(): void {
  if (!win) return;
  positionWindow();
  win.show();
  win.focus();
  win.webContents.send("navigate", "dashboard");
}

function toggleWindow(): void {
  if (!win) return;
  if (win.isVisible()) win.hide();
  else showWindow();
}

function createWindow(): void {
  win = new BrowserWindow({
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
    resizable: false,
    fullscreenable: false,
    frame: false,
    transparent: true,
    hasShadow: false,
    skipTaskbar: false,
    alwaysOnTop: true,
    show: false,
    icon: assetPath("icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "..", "preload", "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false
    }
  });

  win.on("close", (event) => {
    if (!(app as unknown as { isQuitting?: boolean }).isQuitting) {
      event.preventDefault();
      win?.hide();
    }
  });

  // 面板重新显示时刷新一次，让用户每次打开看到的都是刚扫的数据，
  // 而不是从托盘弹出几分钟前的旧结果（看着像「数字不动」）。
  // 用 runScan(notify=true) 而不是让渲染层重发 fetch_usage：后者会把界面切回 loading 闪一下。
  // 不看刷新间隔做陈旧判定：后台定时器本身就在按该间隔扫描，数据几乎永远不会「比间隔还旧」，
  // 那样写等于这次刷新基本不会触发。改用固定 15 秒下限，只在开合很频繁时省掉重复扫描。
  // 启动首发不在此列（lastScanAt 还是 0），首屏由渲染层自己的 fetch_usage 负责，避免重复扫两遍。
  win.on("show", () => {
    if (lastScanAt === 0) return;
    if (!readConfig().autoRefreshEnabled) return;
    const ageMs = Date.now() - lastScanAt;
    if (process.env.TOKEN_DEBUG_DUMP) {
      console.log(`[show] age=${Math.round(ageMs / 1000)}s -> ${ageMs < SHOW_REFRESH_STALE_MS ? "跳过" : "重扫"}`);
    }
    if (ageMs < SHOW_REFRESH_STALE_MS) return;
    void runScan(lastPeriod, true);
  });

  if (DEV_URL) {
    void win.loadURL(DEV_URL);
  } else {
    void win.loadFile(path.join(__dirname, "..", "renderer", "index.html"));
  }

  if (process.env.TOKEN_DEBUG_DUMP) {
    win.webContents.once("did-finish-load", () => {
      const waitMs = Number(process.env.TOKEN_DEBUG_WAIT ?? 20000);
      const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
      setTimeout(async () => {
        try {
          const dump = async (label: string) => {
            const testid = await run(`document.querySelector('[data-testid]')?.getAttribute('data-testid') || 'none'`);
            const text = (await win?.webContents.executeJavaScript("document.body.innerText")) as string;
            console.log(`=== ${label} (panel=${testid}) ===`);
            console.log(text);
            console.log("");
          };
          const run = (script: string) => win?.webContents.executeJavaScript(script);

          await sleep(3000);
          await dump("initial@3s");
          await sleep(Math.max(0, waitMs - 3000));
          await dump("initial@final");

          const ensureDashboard = async () => {
            if (await run(`!!document.querySelector('[aria-label="返回"]')`)) {
              await run(`document.querySelector('[aria-label="返回"]').click()`);
              await sleep(500);
            }
            if (await run(`!!document.querySelector('.settings-close')`)) {
              await run(`document.querySelector('.settings-close').click()`);
              await sleep(500);
            }
          };

          await ensureDashboard();
          await run(`document.querySelector('.client-tab.hermes')?.click()`);
          await sleep(600);
          await dump("tab-hermes");
          await run(`document.querySelector('[data-testid="models-trigger"]')?.click()`);
          await sleep(500);
          await dump("accordion-hermes");
          const layout = await run(
            `(() => { const h = document.querySelector('.panel-header'); const p = document.querySelector('.global-overview-pill'); const a = document.querySelector('.header-actions'); const r = (el) => el ? el.getBoundingClientRect() : null; return JSON.stringify({ headerScroll: h ? h.scrollWidth : null, headerClient: h ? h.clientWidth : null, pillW: p ? Math.round(r(p).width) : null, actionsRight: a ? Math.round(r(a).right) : null, winW: window.innerWidth, subtitle: !!document.querySelector('.subtitle'), trendSection: !!document.querySelector('.trend-section'), theme: document.documentElement.getAttribute('data-theme'), actionButtons: document.querySelectorAll('.header-actions button').length, pillText: p ? p.innerText.replace(/\\s+/g, ' ') : null }); })()`
          );
          console.log("=== LAYOUT ===", layout);
          console.log("");
          await run(`document.querySelector('[aria-label="设置"]').click()`);
          await sleep(700);
          await dump("settings");
          await run(`document.querySelector('[data-testid="price-trigger"]')?.click()`);
          await sleep(1200);
          await dump("settings-prices");
          await run(`document.querySelector('.floating-close')?.click()`);
          await sleep(500);
          const image = await win?.webContents.capturePage();
          if (image) {
            const out = path.join(require("node:os").tmpdir(), "token-ui.png");
            require("node:fs").writeFileSync(out, image.toPNG());
            console.log("=== SCREENSHOT ===", out);
          }
        } catch (error) {
          console.error("调试导出失败", error);
        } finally {
          (app as unknown as { isQuitting?: boolean }).isQuitting = true;
          app.quit();
        }
      }, waitMs);
    });
  }
}

function createTray(): void {
  const icon = nativeImage.createFromPath(assetPath("icon.png"));
  tray = new Tray(icon.resize({ width: 16, height: 16 }));
  tray.setToolTip("Token 用量监控");
  tray.on("click", () => toggleWindow());
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "显示面板", click: () => showWindow() },
      {
        label: "立即刷新",
        click: () => {
          showWindow();
          win?.webContents.send("navigate", "dashboard");
          win?.webContents.send("refresh-requested");
        }
      },
      { type: "separator" },
      {
        label: "设置",
        click: () => {
          showWindow();
          win?.webContents.send("navigate", "settings");
        }
      },
      {
        label: "检查更新",
        click: () => {
          void checkForUpdates();
        }
      },
      { type: "separator" },
      {
        label: "退出",
        click: () => {
          (app as unknown as { isQuitting?: boolean }).isQuitting = true;
          app.quit();
        }
      }
    ])
  );
}

function applyAutostart(enabled: boolean): void {
  try {
    app.setLoginItemSettings({ openAtLogin: enabled, path: process.execPath });
  } catch {
    /* 忽略 */
  }
}

async function runScan(period: Period, notify: boolean): Promise<UsageResult | null> {
  if (process.env.TOKEN_DEBUG_DUMP) {
    console.log(`[scan] period=${period} notify=${notify} at ${new Date().toLocaleTimeString("zh-CN")}`);
  }
  scanAbort?.abort();
  const controller = new AbortController();
  scanAbort = controller;
  try {
    // 扫描前先把定价目录续到有效窗口（本地操作，毫秒级）。这样后面逐模型询价都是纯本地命中，
    // 不会因为目录过期而联网等 30s —— 换台机器「切周期要转很久」就是这么消掉的。
    ensureCatalogFresh();
    const result = await fetchUsage(period, controller.signal);
    if (controller.signal.aborted) return null;
    lastScanAt = Date.now();
    if (notify) win?.webContents.send("usage-updated", result);
    return result;
  } catch (error) {
    if (controller.signal.aborted) return null;
    const message = error instanceof Error ? error.message : String(error);
    if (message === "已取消") return null;
    if (notify) {
      win?.webContents.send("usage-error", message);
      return null;
    }
    // 渲染层主动请求：向上抛，让 invoke 走 reject，界面进入错误态而不是一直转圈
    throw error;
  }
}

function scheduleRefresh(): void {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = null;
  const config = readConfig();
  if (!config.autoRefreshEnabled) return;
  const intervalMs = Math.max(30, config.refreshIntervalSeconds) * 1000;
  refreshTimer = setInterval(() => {
    void runScan(lastPeriod, true);
  }, intervalMs);
}

const SIX_HOURS_MS = 6 * 60 * 60 * 1000;

/**
 * 启动后稍等一会儿再干活：首屏要先把用量扫出来，别让后台任务抢 I/O。
 * 每个任务都是「先做一次、之后定时」。
 */
function scheduleMaintenance(): void {
  const kickoff = (fn: () => void, delayMs: number) => setTimeout(fn, delayMs);

  // Antigravity：只存在于运行中的语言服务器里，必须主动 sync 才有数据
  kickoff(() => {
    void syncAntigravity().then((result) => {
      if (process.env.TOKEN_DEBUG_DUMP) {
        console.log(
          `[antigravity] sync ok=${result.ok} sessions=${result.cachedSessions} ${result.ms}ms ${result.detail}`
        );
      }
      // 抓到新数据就顺手重扫一次，界面不用等下一次定时刷新
      if (result.ok) void runScan(lastPeriod, true);
    });
    if (antigravityTimer) clearInterval(antigravityTimer);
    antigravityTimer = setInterval(() => {
      void syncAntigravity().then((result) => {
        if (result.ok) void runScan(lastPeriod, true);
      });
    }, SIX_HOURS_MS);
  }, 8_000);

  // 定价目录：后台真联网刷新，失败就把时间戳续上（切档路径永远不碰网络）
  kickoff(() => {
    void refreshCatalog().then((result) => {
      if (process.env.TOKEN_DEBUG_DUMP) {
        console.log(`[catalog] refreshed=${result.refreshed} ${result.ms}ms ${result.detail}`);
      }
    });
    if (catalogTimer) clearInterval(catalogTimer);
    catalogTimer = setInterval(() => {
      void refreshCatalog();
    }, SIX_HOURS_MS);
  }, 20_000);
}

function registerIpc(): void {
  ipcMain.handle("get_app_config", () => ({ ...currentConfig(), update: updateStatus() }));

  ipcMain.handle("fetch_usage", async (_event, args: { period?: Period } | undefined) => {
    const period: Period = args?.period ?? "month";
    lastPeriod = period;
    return runScan(period, false);
  });

  ipcMain.handle("save_refresh_interval", (_event, args: { refreshIntervalSeconds: number }) => {
    writeConfig({ refreshIntervalSeconds: Math.max(30, Math.round(args.refreshIntervalSeconds)) });
    scheduleRefresh();
    return currentConfig();
  });

  ipcMain.handle("save_auto_refresh_enabled", (_event, args: { autoRefreshEnabled: boolean }) => {
    writeConfig({ autoRefreshEnabled: Boolean(args.autoRefreshEnabled) });
    scheduleRefresh();
    return currentConfig();
  });

  ipcMain.handle("save_autostart", (_event, args: { autostart: boolean }) => {
    writeConfig({ autostart: Boolean(args.autostart) });
    applyAutostart(Boolean(args.autostart));
    return currentConfig();
  });

  ipcMain.handle("save_theme", (_event, args: { theme: ThemeName }) => {
    writeConfig({ theme: args.theme === "light" ? "light" : "dark" });
    return currentConfig();
  });

  ipcMain.handle("open_pricing_file", async () => {
    const file = pricingPath();
    if (!fs.existsSync(file)) {
      const template = {
        models: {
          "gemini-default": {
            input_per_million: 1.5,
            output_per_million: 9,
            cache_read_per_million: 0.15
          }
        },
        grokUseRecordedCost: false
      };
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(template, null, 2), "utf8");
      clearPriceCache();
    }
    return shell.openPath(file);
  });

  ipcMain.handle("open_pricing_folder", () => {
    shell.showItemInFolder(pricingPath());
  });

  /** 设置页「折算价格」：按模型取单价（每百万 token 美元），走扫描时已建好的价格缓存 */
  ipcMain.handle("get_model_prices", async (_event, args: { models?: string[] } | undefined) => {
    const ids = Array.isArray(args?.models) ? args.models.filter((id) => typeof id === "string") : [];
    const localIds = new Set(Object.keys(readPricingFile().models ?? {}));
    const toPerMillion = (perToken: number) => Math.round(perToken * 1e12) / 1e6;
    const out: Record<
      string,
      { input: number | null; output: number | null; cacheRead: number | null; cacheWrite: number | null; local: boolean }
    > = {};
    for (const id of ids) {
      const price = await getPrice(id);
      out[id] = {
        input: price ? toPerMillion(price.input) : null,
        output: price ? toPerMillion(price.output) : null,
        cacheRead: price ? toPerMillion(price.cacheRead) : null,
        cacheWrite: price ? toPerMillion(price.cacheWrite) : null,
        local: localIds.has(id)
      };
    }
    return out;
  });

  ipcMain.handle("hide_main_window", () => {
    win?.hide();
  });

  ipcMain.handle("check_update", () => checkForUpdates());

  ipcMain.handle("install_update", () => {
    installUpdate();
  });
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => showWindow());

  app.whenReady().then(async () => {
    tokscaleVersionText = await tokscaleVersion();
    applyAutostart(readConfig().autostart);
    // 定价目录必须在任何扫描之前就位：缺文件时用随包快照播种、时间戳续到有效窗口
    const catalog = ensureCatalogFresh(true);
    if (process.env.TOKEN_DEBUG_DUMP) {
      console.log(`[catalog] 启动检查 dir=${catalog.dir} seeded=[${catalog.seeded}] renewed=[${catalog.renewed}]`);
      for (const row of catalogStatus()) {
        console.log(`[catalog]   ${row.name} age=${row.ageMinutes}min entries=${row.entries}`);
      }
    }
    registerIpc();
    createWindow();
    createTray();
    scheduleRefresh();
    scheduleMaintenance();
    setupUpdater((status) => win?.webContents.send("update-status", status));
    showWindow();
  });

  app.on("window-all-closed", () => {
    /* 托盘常驻，不退出 */
  });
}
