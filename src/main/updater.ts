import { app } from "electron";
import { autoUpdater } from "electron-updater";
import type { UpdateStatus } from "../shared/types";

/** 启动后多久做第一次静默检查（ms） */
const FIRST_CHECK_DELAY = 15_000;
/** 后台自动检查间隔：6 小时 */
const CHECK_INTERVAL = 6 * 60 * 60 * 1000;

let emit: ((status: UpdateStatus) => void) | null = null;
let status: UpdateStatus = { state: "idle", currentVersion: app.getVersion() };

function set(patch: Partial<UpdateStatus>): void {
  status = { ...status, ...patch };
  emit?.(status);
}

function errText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function updateStatus(): UpdateStatus {
  return status;
}

/** 便携版（历史打包形态，现已不再发布）无法自动更新：它跑在临时解包目录里 */
function isPortable(): boolean {
  return Boolean(process.env.PORTABLE_EXECUTABLE_DIR);
}

const PORTABLE_HINT = "便携版无法自动更新，请到 GitHub Releases 下载 Token-Setup-*.exe 安装版";

export function setupUpdater(send: (status: UpdateStatus) => void): void {
  emit = send;
  if (!app.isPackaged) {
    set({ state: "dev", message: "开发模式下不检查更新" });
    return;
  }
  if (isPortable()) {
    set({ state: "portable", message: PORTABLE_HINT });
    return;
  }

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on("checking-for-update", () => set({ state: "checking", message: "正在检查更新…" }));
  autoUpdater.on("update-available", (info) =>
    set({ state: "available", latestVersion: info.version, message: `发现 v${info.version}，正在下载…` })
  );
  autoUpdater.on("update-not-available", (info) =>
    set({
      state: "none",
      latestVersion: info.version,
      message: "已是最新版本",
      checkedAt: new Date().toISOString()
    })
  );
  autoUpdater.on("download-progress", (progress) =>
    set({ state: "downloading", percent: Math.round(progress.percent) })
  );
  autoUpdater.on("update-downloaded", (info) =>
    set({
      state: "downloaded",
      latestVersion: info.version,
      percent: 100,
      message: `v${info.version} 已下载，重启后生效`
    })
  );
  autoUpdater.on("error", (error) => set({ state: "error", message: `更新失败：${errText(error)}` }));

  setTimeout(() => void checkForUpdates(), FIRST_CHECK_DELAY);
  setInterval(() => void checkForUpdates(), CHECK_INTERVAL);
}

export async function checkForUpdates(): Promise<UpdateStatus> {
  if (!app.isPackaged) {
    set({ state: "dev", message: "开发模式下不检查更新" });
    return status;
  }
  if (isPortable()) {
    set({ state: "portable", message: PORTABLE_HINT });
    return status;
  }
  try {
    await autoUpdater.checkForUpdates();
  } catch (error) {
    set({ state: "error", message: `更新失败：${errText(error)}` });
  }
  return status;
}

/** 静默安装已下载的更新并重启（quitAndInstall(isSilent=false, isForceRunAfter=true)） */
export function installUpdate(): void {
  if (!app.isPackaged || isPortable()) return;
  try {
    autoUpdater.quitAndInstall(false, true);
  } catch (error) {
    set({ state: "error", message: `安装失败：${errText(error)}` });
  }
}
