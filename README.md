# Token

Windows 托盘版 token 用量监控：Codex / Hermes / Antigravity / Grok 四家本地数据汇总。

界面照搬 [DeepSeekMonitorWindows](https://github.com/Joyi-code/DeepSeekMonitorWindows) 的**新版本 UI**（v1.1.0，含皮肤切换、缓存命中明细、堆叠柱状图）；采集方式参考 [Javis603/token-monitor](https://github.com/Javis603/token-monitor)，即直接调用 tokscale CLI，不自己解析各家会话文件。

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

实测差异（全时段）：

| 客户端 | tokscale 的 cost | 自算 |
|---|---|---|
| Codex | $2,923 | $2,923.99（一致） |
| Antigravity | $24.85 | $48.34（目录里 Google 官方价 vs OpenRouter 转售价正好差 2 倍） |
| Grok | $197.30 | 目录 $111.68 / Grok 自带 $102.20 |
| Hermes | $1.19 亿 | $17.46 |

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
npm run dist           # 打包 nsis + 便携 exe 到 release/
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

## v1 不做

订阅额度 / OAuth 探测、多设备同步、WSL 内数据、多账号与 Hermes 多 profile、tokscale 支持的其他 30+ 工具、i18n。
