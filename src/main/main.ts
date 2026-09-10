import { app, BrowserWindow, ipcMain, Menu, nativeImage, screen, shell, Tray } from "electron";
import fs from "node:fs";
import path from "node:path";
import type { AppConfig, Period, ThemeName, UsageResult } from "../shared/types";
import { configPath, pricingPath, pricingPathExists, readConfig, readPricingFile, writeConfig } from "./config";
import { clearPriceCache, getPrice } from "./pricing";
import { tokscaleVersion } from "./tokscale";
import { checkForUpdates, installUpdate, setupUpdater, updateStatus } from "./updater";
import { fetchUsage } from "./usage";

const DEV_URL = process.env.TOKEN_DEV_URL;
const WINDOW_WIDTH = 380;
const WINDOW_HEIGHT = 680;

let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let refreshTimer: NodeJS.Timeout | null = null;
let tokscaleVersionText = "未知";
let scanAbort: AbortController | null = null;
/** 渲染层最近一次请求的周期；后台定时刷新沿用该周期，避免把「本月」数据推到「今日/近 7 天」视图 */
let lastPeriod: Period = "week";

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
    const result = await fetchUsage(period, controller.signal);
    if (controller.signal.aborted) return null;
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
    registerIpc();
    createWindow();
    createTray();
    scheduleRefresh();
    setupUpdater((status) => win?.webContents.send("update-status", status));
    showWindow();
  });

  app.on("window-all-closed", () => {
    /* 托盘常驻，不退出 */
  });
}
