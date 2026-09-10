import { app } from "electron";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { runTokscale } from "./tokscale";

/**
 * tokscale 定价目录缓存的维护。
 *
 * 背景（实测）：tokscale 只在缓存文件里的时间戳落在 [now-60min, now] 内才认为目录有效；
 * 一旦过期就联网重拉。三个上游里 `raw.githubusercontent.com`（litellm 源）与 `models.dev`
 * 在部分网络环境下不通，重拉要等满 30 秒超时，而失败后又不会刷新时间戳 ⇒ 那台机器
 * 每次切周期都要再等一遍（不是「只有第一次慢」）。
 *
 * 这里做两件事：
 *   1. `ensureCatalogFresh()` —— 把时间戳续到有效窗口内。纯本地改文件头，毫秒级，
 *      让「切档路径」永远不碰网络。
 *   2. `refreshCatalog()` —— 后台真联网刷新：先把时间戳改老逼 tokscale 重拉，拿到新目录
 *      就留着；连不上就靠 `ensureCatalogFresh()` 续期兜底。只有这条路会联网，且不在
 *      用户可见路径上。
 *
 * 缓存文件格式 = `{"timestamp":<秒>,"data":{...}}`，纯 JSON、可移植。
 */

const SOURCE_FILES = ["pricing-litellm.json", "pricing-models-dev.json", "pricing-openrouter.json"];
/** tokscale 的有效窗口是 1 小时；留 10 分钟余量，避免卡在边界上 */
const RENEW_MARGIN_MS = 10 * 60 * 1000;
/** 同进程内两次检查的最小间隔（切档 + 设置页取价会连续触发） */
const CHECK_THROTTLE_MS = 30_000;
/** 刷新探针模型：只用它触发「联网重拉」，它返回的价格不参与展示 */
const PROBE_MODEL = "glm-5.3";

let lastCheckAt = 0;
/** 快照播种失败过的源，避免每次调用都重复 gunzip（目录真缺失时又不能不管） */
const seedFailed = new Set<string>();

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** tokscale 的配置目录；用户若自己设了 TOKSCALE_CONFIG_DIR（我们的子进程会继承）就跟着走 */
export function tokscaleConfigDir(): string {
  const override = process.env.TOKSCALE_CONFIG_DIR?.trim();
  return override ? override : path.join(app.getPath("appData"), "tokscale");
}

export function catalogDir(): string {
  return path.join(tokscaleConfigDir(), "cache");
}

export function catalogFiles(): string[] {
  return SOURCE_FILES.map((name) => path.join(catalogDir(), name));
}

/** 随包分发的价格快照（打包后落在 resources/ 根，开发时在仓库 resources/） */
export function snapshotPath(): string {
  const packed = path.join(process.resourcesPath ?? "", "pricing-snapshot.json.gz");
  if (fs.existsSync(packed)) return packed;
  return path.join(__dirname, "..", "..", "resources", "pricing-snapshot.json.gz");
}

/**
 * 只读文件开头一小段取时间戳（整个文件有 2~5MB，不值得为了一个数字全读）。
 * tokscale 写出来的首字段就是 timestamp。
 */
function readTimestamp(file: string): number | null {
  try {
    const fd = fs.openSync(file, "r");
    try {
      const buf = Buffer.alloc(256);
      const read = fs.readSync(fd, buf, 0, 256, 0);
      const match = /^\{"timestamp":(\d+)/.exec(buf.subarray(0, read).toString("utf8"));
      return match ? Number(match[1]) : null;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

/** 就地改写文件头的时间戳（不动后面几 MB 数据） */
function writeTimestamp(file: string, seconds: number): boolean {
  try {
    const fd = fs.openSync(file, "r+");
    try {
      const buf = Buffer.alloc(256);
      const read = fs.readSync(fd, buf, 0, 256, 0);
      const head = buf.subarray(0, read).toString("utf8");
      const match = /^\{"timestamp":(\d+)/.exec(head);
      if (!match) return false;
      const next = Buffer.from(`{"timestamp":${seconds}`, "utf8");
      // 秒级时间戳是 10 位，长度不会变；万一变了就放弃（走整体重写没必要）
      if (next.length !== match[0].length) return false;
      fs.writeSync(fd, next, 0, next.length, 0);
      return true;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
}

/** 从内嵌快照补一个源文件（首次运行、或用户清过缓存） */
function seedFromSnapshot(name: string): boolean {
  const snapshot = snapshotPath();
  try {
    const raw = zlib.gunzipSync(fs.readFileSync(snapshot)).toString("utf8");
    const parsed = JSON.parse(raw) as Record<string, { data?: Record<string, unknown> }>;
    const key = name.replace(/^pricing-/, "").replace(/\.json$/, "");
    const entry = parsed[key];
    if (!entry?.data) return false;
    fs.mkdirSync(catalogDir(), { recursive: true });
    fs.writeFileSync(path.join(catalogDir(), name), JSON.stringify({ timestamp: nowSeconds(), data: entry.data }), "utf8");
    return true;
  } catch {
    return false;
  }
}

export type CatalogCheck = {
  seeded: string[];
  renewed: string[];
  dir: string;
  snapshot: string;
};

/**
 * 保证定价目录「看起来是新鲜的」：缺文件就用随包快照补，时间戳超出有效窗口就续到当前。
 * 纯本地操作，不联网。返回本次动了哪些文件（给日志/诊断用）。
 *
 * 节流只挡「时间戳续期」这种无谓的重复写；**文件缺失必须立刻补**，否则一旦缓存被清掉，
 * 新的模型询价就会拿空目录去联网、又等满 30s。
 */
export function ensureCatalogFresh(force = false): CatalogCheck {
  const now = Date.now();
  const missing = SOURCE_FILES.filter((name) => readTimestamp(path.join(catalogDir(), name)) === null);
  if (!force && missing.length === 0 && now - lastCheckAt < CHECK_THROTTLE_MS) {
    return { seeded: [], renewed: [], dir: catalogDir(), snapshot: snapshotPath() };
  }
  lastCheckAt = now;

  const nowSec = nowSeconds();
  const seeded: string[] = [];
  const renewed: string[] = [];

  for (const name of SOURCE_FILES) {
    const file = path.join(catalogDir(), name);
    const ts = readTimestamp(file);
    // ① 缺失 / 读不出时间戳 → 用内嵌快照播种（同一进程内失败过就不再重试）
    if (ts === null) {
      if (seedFailed.has(name)) continue;
      if (seedFromSnapshot(name)) {
        seedFailed.delete(name);
        seeded.push(name);
      } else {
        seedFailed.add(name);
      }
      continue;
    }
    // ② 落在 [now-50min, now] 之外就续期。注意「未来时间戳」同样无效（实测 +
    //    1h/+1d/+10 年照样联网重拉），所以也一并续到当前。
    const tooOld = nowSec - ts >= (60 * 60 * 1000 - RENEW_MARGIN_MS) / 1000;
    const inFuture = ts > nowSec;
    if (tooOld || inFuture) {
      if (writeTimestamp(file, nowSec)) renewed.push(name);
    }
  }

  return { seeded, renewed, dir: catalogDir(), snapshot: snapshotPath() };
}

export type CatalogStatusRow = {
  name: string;
  exists: boolean;
  ageMinutes: number | null;
  entries: number | null;
};

/** 诊断用：每个源文件的时间戳年龄与条数 */
export function catalogStatus(): CatalogStatusRow[] {
  return SOURCE_FILES.map((name) => {
    const file = path.join(catalogDir(), name);
    const ts = readTimestamp(file);
    let entries: number | null = null;
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { data?: Record<string, unknown> };
      entries = parsed.data ? Object.keys(parsed.data).length : null;
    } catch {
      entries = null;
    }
    return {
      name,
      exists: ts !== null,
      ageMinutes: ts === null ? null : Math.round(((nowSeconds() - ts) / 60) * 10) / 10,
      entries
    };
  });
}

export type CatalogRefresh = {
  /** 是否真的从上游拿到了新目录（以时间戳被 tokscale 重写为准，不是「命令没报错」） */
  refreshed: boolean;
  ms: number;
  detail: string;
};

let refreshRunning: Promise<CatalogRefresh> | null = null;

/**
 * 刷新用的镜像目录。**必须在隔离目录里刷新**：逼 tokscale 重拉的做法是「把时间戳改老」，
 * 而在线上目录里改老，就等于把用户路径上要读的目录弄陈旧 —— 后台刷新一飞，前台询价立刻
 * 看到陈旧目录 → 联网 → 卡满超时（实测残留 20s 就是这么来的）。镜像里怎么折腾都不影响线上。
 */
function refreshMirrorDir(): string {
  return path.join(app.getPath("userData"), "catalog-refresh");
}

/**
 * 后台联网刷新定价目录。
 * 做法：把线上目录复制到镜像 → 在镜像里把时间戳改老 → 跑一次 tokscale（它对过期缓存会
 * 重拉并写回）→ 只把**确实被上游刷新过**的文件原子搬回线上。线上目录自始至终保持新鲜，
 * 因此这个函数可以在任何时刻安全地在后台跑。
 */
export function refreshCatalog(signal?: AbortSignal): Promise<CatalogRefresh> {
  if (refreshRunning) return refreshRunning;
  refreshRunning = (async (): Promise<CatalogRefresh> => {
    const started = Date.now();
    // 线上目录先补到新鲜（既保证询价不等，也作为镜像的复制源）
    ensureCatalogFresh(true);
    const live = catalogFiles().filter((file) => readTimestamp(file) !== null);
    if (live.length === 0) {
      return { refreshed: false, ms: 0, detail: "无本地目录，已尝试用内嵌快照播种" };
    }

    const mirror = refreshMirrorDir();
    const mirrorCache = path.join(mirror, "cache");
    try {
      fs.rmSync(mirror, { recursive: true, force: true });
      fs.mkdirSync(mirrorCache, { recursive: true });
      const stale = nowSeconds() - 2 * 60 * 60;
      for (const file of live) {
        const dst = path.join(mirrorCache, path.basename(file));
        fs.copyFileSync(file, dst);
        writeTimestamp(dst, stale);
      }

      let detail = "";
      try {
        await runTokscale(["pricing", PROBE_MODEL, "--json", "--no-spinner"], {
          // 源不通时每路都要等满超时，这里放宽；反正是后台，不占用户路径
          timeoutMs: 120_000,
          signal,
          extraEnv: { TOKSCALE_CONFIG_DIR: mirror }
        });
        detail = "命令成功返回";
      } catch (error) {
        detail = error instanceof Error ? error.message : String(error);
      }

      // 只搬回「上游真的重写过」的文件（时间戳变新）；上游失败的那几路保持线上旧数据不动
      const nowSec = nowSeconds();
      const taken: string[] = [];
      for (const file of live) {
        const src = path.join(mirrorCache, path.basename(file));
        const ts = readTimestamp(src);
        if (ts === null || nowSec - ts > 300) continue;
        const tmp = `${file}.tmp`;
        try {
          fs.copyFileSync(src, tmp);
          fs.renameSync(tmp, file);
          taken.push(path.basename(file));
        } catch {
          try {
            fs.rmSync(tmp, { force: true });
          } catch {
            /* ignore */
          }
        }
      }
      ensureCatalogFresh(true);
      return {
        refreshed: taken.length > 0,
        ms: Date.now() - started,
        detail: `${taken.length}/${live.length} 个源已更新（${detail}）`
      };
    } catch (error) {
      ensureCatalogFresh(true);
      return {
        refreshed: false,
        ms: Date.now() - started,
        detail: error instanceof Error ? error.message : String(error)
      };
    } finally {
      try {
        fs.rmSync(mirror, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  })();
  void refreshRunning.finally(() => {
    refreshRunning = null;
  });
  return refreshRunning;
}
