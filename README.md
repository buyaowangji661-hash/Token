# Token

Windows 托盘版 token 用量监控：Codex / Hermes / Antigravity / Grok 四家本地数据汇总。

## 数据来源（全部本地，无需 API Key）

| 工具 | 数据位置 | 实测规模 |
|---|---|---|
| Codex | `~\.codex\sessions` | 31.3K 条 |
| Hermes | `%LOCALAPPDATA%\hermes\state.db`（表 `session_model_usage`） | 4.2K 条 |
| Antigravity | `%APPDATA%\tokscale\antigravity-cache` ← `~\.gemini\antigravity` | 1.2K 条 |
| Grok | `~\.grok\sessions` + `logs\unified.jsonl` | 56 条 |

一条命令取数：

```
tokscale --json --client codex,hermes,antigravity,grok --group-by client,model \
  --today | --yesterday | --week | --month | --year <YYYY>
tokscale pricing <model> --json       # 单模型单价
```

界面周期共 5 档：今日 / 昨日 / 近 7 天 / 本月 / 本年。`--week` 在 tokscale 里是**滚动最近 7 天**，所以文案不叫「本周」。

首次扫描约 12s（Codex 会话 1.3GB），命中 tokscale 缓存后约 0.7s。

## 金额口径

- **不用 tokscale 的 `cost` 字段**。它对 Hermes 是直接搬 state.db 里放大约 1e6 的估算值，对 Antigravity/Grok 又和目录价对不上（详见下表）。
- 金额一律用 **tokens × 定价目录单价**自己重算：目录来自 LiteLLM / OpenRouter / Models.dev，`reasoning` 按 output 计价。
- **四家同口径**：金额一律 = tokens × 定价目录单价，`reasoning` 按 output 计价，Grok 也不例外。
- 想改回 Grok CLI 自记的开销（`~\.grok\sessions\**\updates.jsonl` 里每条推理自带 `costUsdTicks`，按 1e-9 美元换算）：在 `pricing.json` 里显式写 `grokUseRecordedCost: true`，缺省是关的。
- 未匹配到价格的模型显示「未定价」，不按 $0 计。


### 价格覆盖表

`%APPDATA%\Token\pricing.json`：

```json
{
  "models": {
    "gemini-default": {
      "input_per_million": 1.5,
      "output_per_million": 9,
      "cache_read_per_million": 0.15
    }
  },
  "grokUseRecordedCost": true
}
```

`gemini-default` 是 Antigravity 自己吐出的占位模型 id，tokscale 别名表里没有。实测证据：2026-07-15 的同一场会话里 `gemini-default`(23 次) 与 `gemini-3-flash-a`(21 次) 交替出现，而 `gemini-3-flash-a` 已被 tokscale 映射为 `gemini-3.5-flash-high`，故按该模型定价。

## 开发

```bash
npm install
npm run build          # 主进程 tsc + 渲染层 vite
npm start              # 启动（托盘常驻）
npm run dist           # 打包 nsis 安装版到 release/（先刷新价格快照）
```

自检脚本（不启动 Electron）：

```bash
node scripts/check-pipeline.js month   # 打印本月四家用量、金额、7 天趋势
node scripts/check-grok-cost.js        # 校验 Grok costUsdTicks 读取
TOKEN_DEBUG_DUMP=1 npm start           # 自动走一遍三个视图并导出 DOM 文本 + 截图
```

## 结构

```
src/main/      Electron 主进程：tokscale 调用、定价折算、托盘、窗口、IPC
src/preload/   contextBridge（invoke / on）
src/renderer/  React 界面：styles.css 直接复用 DSM 新版样式，extra.css 追加客户端配色与切换器
src/shared/    主进程与渲染层共用的类型
```

## 更新与发版

仓库：<https://github.com/buyaowangji661-hash/Token>（公开）。自动更新走 **GitHub Releases + electron-updater**。

- **安装版**（`Token-Setup-x.y.z.exe`）：启动 15 秒后静默检查一次，之后每 6 小时一次；发现新版自动下载，
  设置页「关于」出现「重启并安装 vX.Y.Z」。也可在设置页点「检查更新」、托盘右键「检查更新」手动触发。
  已下载的更新在退出应用时也会自动装上（`autoInstallOnAppQuit`）。
- **只发安装版**：`build.win.target` 只有 `nsis`,产物 `Token-Setup-x.y.z.exe`(约 108MB)。
  便携版已按用户要求删除(既不能自动更新,又让每次上传多 108MB)。
- **换机/首次使用**：新机器**手动装一次** `Token-Setup-x.y.z.exe`,之后才会自动更新。
- `appId`（`com.aluzzz.token`）不可更换 —— 换了之后 electron-updater 认不出已装的版本。

发版（在 `D:\Token`）：

```bash
npm run release              # 升 patch（0.1.1 → 0.1.2）→ 构建 → 上传 Release
npm run release -- --minor   # 升 minor
npm run release -- --major   # 升 major
npm run release -- --no-bump # 版本已手改好，只构建 + 上传
npm run release -- --skip-build
```


## 定价目录与「换台电脑切周期就很慢」

tokscale 的定价目录靠联网拉三个上游（LiteLLM / OpenRouter / Models.dev），缓存只认 **1 小时**。
在 `raw.githubusercontent.com` 或 `models.dev` 不通的网络里，重拉要等满 **30 秒**超时，而且失败后
**不刷新时间戳** ⇒ 每次切周期都再等一遍（不是"只有第一次慢"）。实测那台机器：切一次档
**196.4s**（主扫描 77.1s + 逐模型询价 119.3s）。

三个措施让切档路径彻底不碰网络（实测冷机 + 三源全黑洞：**718ms**，用户路径联网 **0 次**）：

1. **扫描注入 `TOKSCALE_PRICING_CACHE_ONLY=1`** —— app 只取 token 数、金额自己算，所以主扫描
   不需要定价目录（77s → 0.2s）。
2. **`priceCatalog.ts` 维持目录新鲜** —— 时间戳超出 `[now-50min, now]` 就本地续期（未来时间戳
   同样无效，也一并续）；缺文件用随包快照 `resources/pricing-snapshot.json.gz` 播种。**关键：
   任何一路目录文件缺失或陈旧，都会让 tokscale 为「连目录里都没有的模型」也去联网等满超时。**
3. **联网刷新挪到后台 + 隔离镜像目录** —— `refreshCatalog()` 在 `userData/catalog-refresh` 里把
   时间戳改老来逼 tokscale 重拉，只把上游确实重写过的文件原子搬回线上。线上目录自始至终新鲜，
   所以后台刷新随时可跑、不影响前台（早期版本直接改线上文件，导致前台询价撞上陈旧目录又卡 20s）。

另外 **`antigravity sync`**：Antigravity 用量只存在于运行中的语言服务器里，必须先 sync 才有数据。
app 过去从不调它，缓存停在很久以前（实测那台机器 `last synced` 停在十几天前）。现在启动后 8 秒
跑一次、之后每 6 小时一次。

注意两个反直觉点（都实测过）：`TOKSCALE_PRICING_CACHE_ONLY` **对 `pricing` 子命令无效**
（只对主扫描有效）；`antigravity-cache` 里的 `sync.lock` 残留**无害**，带锁 sync 照样成功。

