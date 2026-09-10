/** 验证 Grok 自带 costUsdTicks 的读取与换算。用法：node scripts/check-grok-cost.js */
const path = require("node:path");
const electronEntry = require.resolve("electron");
require.cache[electronEntry] = {
  id: electronEntry,
  filename: electronEntry,
  loaded: true,
  exports: {
    app: {
      getPath: (name) => (name === "userData" ? path.join(process.env.APPDATA, "Token") : process.env.APPDATA)
    }
  }
};

const { readGrokRecordedCost } = require(path.join(__dirname, "..", "dist", "main", "usage.js"));
const all = readGrokRecordedCost(0);
let sum = 0;
for (const [model, usd] of all) {
  sum += usd;
  console.log(`  ${model.padEnd(24)} $${usd.toFixed(4)}`);
}
console.log(`全时段合计：$${sum.toFixed(2)}`);
