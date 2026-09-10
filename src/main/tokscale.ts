import { spawn } from "node:child_process";
import path from "node:path";

let cachedBinary: string | null = null;

function platformPackage(): string | null {
  if (process.platform === "win32") {
    if (process.arch === "x64") return "@tokscale/cli-win32-x64-msvc";
    if (process.arch === "arm64") return "@tokscale/cli-win32-arm64-msvc";
  }
  if (process.platform === "darwin") {
    if (process.arch === "arm64") return "@tokscale/cli-darwin-arm64";
    if (process.arch === "x64") return "@tokscale/cli-darwin-x64";
  }
  if (process.platform === "linux") {
    if (process.arch === "x64") return "@tokscale/cli-linux-x64-gnu";
    if (process.arch === "arm64") return "@tokscale/cli-linux-arm64-gnu";
  }
  return null;
}

/**
 * 定位随包分发的 tokscale 二进制。
 * 打包后二进制被 asarUnpack 到 app.asar.unpacked，require.resolve 返回的
 * app.asar 路径 spawn 读不到，必须做替换。
 */
export function resolveTokscaleBinary(): string {
  if (cachedBinary) return cachedBinary;
  const pkg = platformPackage();
  if (!pkg) throw new Error(`不支持的平台：${process.platform}-${process.arch}`);
  const pkgJson = require.resolve(`${pkg}/package.json`);
  const dir = path
    .dirname(pkgJson)
    .replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`)
    .replace("app.asar/", "app.asar.unpacked/");
  const binary = process.platform === "win32" ? "tokscale.exe" : "tokscale";
  cachedBinary = path.join(dir, "bin", binary);
  return cachedBinary;
}

export type RunOptions = {
  timeoutMs?: number;
  signal?: AbortSignal;
};

export function runTokscale(args: string[], options: RunOptions = {}): Promise<string> {
  const binary = resolveTokscaleBinary();
  const timeoutMs = options.timeoutMs ?? 120_000;
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      windowsHide: true,
      env: { ...process.env, NO_COLOR: "1" }
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      fn();
    };
    const onAbort = () => {
      child.kill();
      finish(() => reject(new Error("已取消")));
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(() => reject(new Error(`tokscale 执行超时（${Math.round(timeoutMs / 1000)}s）`)));
    }, timeoutMs);
    options.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => finish(() => reject(error)));
    child.on("close", (code) => {
      finish(() => {
        if (code === 0) resolve(stdout);
        else reject(new Error(stderr.trim() || `tokscale 退出码 ${code}`));
      });
    });
  });
}

export async function runTokscaleJson<T>(args: string[], options: RunOptions = {}): Promise<T> {
  const stdout = await runTokscale(args, options);
  const start = stdout.indexOf("{");
  const end = stdout.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("tokscale 没有返回 JSON");
  return JSON.parse(stdout.slice(start, end + 1)) as T;
}

export async function tokscaleVersion(): Promise<string> {
  try {
    const out = await runTokscale(["--version"], { timeoutMs: 20_000 });
    const match = out.match(/(\d+\.\d+\.\d+)/);
    return match ? match[1] : out.trim();
  } catch {
    return "未知";
  }
}
