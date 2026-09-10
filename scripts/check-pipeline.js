/**
 * 不启动 Electron 的管线自检：直接跑 dist/main/usage.js，
 * 把 electron 模块替换成只提供 app.getPath 的桩。
 * 用法：node scripts/check-pipeline.js [today|week|month]
 */
const path = require("node:path");

const electronEntry = require.resolve("electron");
require.cache[electronEntry] = {
  id: electronEntry,
  filename: electronEntry,
  loaded: true,
  exports: {
    app: {
      getPath(name) {
        if (name === "userData") return path.join(process.env.APPDATA, "Token");
        return process.env.APPDATA;
      },
      getVersion: () => "0.1.0"
    }
  }
};

const { fetchUsage } = require(path.join(__dirname, "..", "dist", "main", "usage.js"));

const period = process.argv[2] || "month";
const fmt = (n) => Math.round(n).toLocaleString("en-US");
const money = (n) => (n === null ? "未定价" : `$${n.toFixed(2)}`);

fetchUsage(period)
  .then((result) => {
    console.log(`周期=${result.period}  扫描耗时=${result.scanMs}ms  未定价模型=${result.hasUnpriced}`);
    console.log(`合计：${fmt(result.totalTokens)} tokens / ${fmt(result.totalMessages)} 请求 / ${money(result.totalCost)}`);
    console.log("");
    for (const client of result.clients) {
      const cached = client.tokens.cacheRead;
      const uncached = client.tokens.input;
      const rate = cached + uncached > 0 ? Math.round((cached / (cached + uncached)) * 100) : 0;
      console.log(
        `${client.label.padEnd(12)} ${fmt(client.totalTokens).padStart(14)} tokens  ` +
          `${String(client.messages).padStart(6)} 请求  命中${String(rate).padStart(3)}%  ${money(client.cost)}`
      );
      for (const model of client.models) {
        console.log(
          `    ${model.model.padEnd(38)} ${fmt(model.totalTokens).padStart(13)}  ${money(model.cost)}`
        );
      }
    }
    console.log("");
    console.log("最近 7 天：");
    for (const point of result.trend) {
      console.log(
        `  ${point.date}  合计 ${fmt(point.total).padStart(13)}  ` +
          Object.entries(point.byClient)
            .filter(([, v]) => v > 0)
            .map(([k, v]) => `${k}=${fmt(v)}`)
            .join("  ")
      );
    }
  })
  .catch((error) => {
    console.error("管线失败：", error);
    process.exitCode = 1;
  });
