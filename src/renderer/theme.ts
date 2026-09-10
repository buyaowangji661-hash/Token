/**
 * 皮肤清单（渲染层）。
 * 显示名一律中文；色卡用的四个色是给「皮肤小菜单」画预览用的，改皮肤时顺手同步。
 * 新增一套皮肤：往 shared/types.ts 的 THEME_IDS 加 id，往 theme.css 加 [data-theme] 块，
 * 往这里加一条 SKINS 记录，三处就齐了。
 */
import type { ThemeName } from "../shared/types";

export const THEME_STORAGE_KEY = "token-theme";

export type Skin = {
  id: ThemeName;
  /** 菜单里显示的名字 */
  name: string;
  /** 菜单色卡：面板底 / 强调色 / 卡片底 / 文字色 */
  swatch: [string, string, string, string];
};

export const SKINS: Skin[] = [
  {
    id: "light",
    name: "青蓝",
    swatch: ["#dceaf2", "#2d6cf6", "#ffffff", "#16364a"]
  },
  {
    id: "dark",
    name: "琥珀",
    swatch: ["#3d4c21", "#e0a838", "#2c2616", "#efe6d6"]
  },
  {
    id: "neon",
    name: "午夜",
    swatch: ["#0d111a", "#22d3ee", "#161e30", "#d6e8f6"]
  },
  {
    id: "paper",
    name: "素白",
    swatch: ["#fbfbf9", "#1b1b18", "#ffffff", "#22221e"]
  },
  {
    id: "cyber",
    name: "赛博紫",
    swatch: ["#1e0c34", "#e879f9", "#30164e", "#eee2ff"]
  }
];
