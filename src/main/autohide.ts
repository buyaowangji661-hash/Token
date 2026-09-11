/**
 * 「鼠标离开面板就收起」的判定状态机。
 *
 * 抽成纯函数是为了能直接对编译产物 `dist/main/autohide.js` 做断言测试
 * （不用起 GUI、不抢单实例锁）。三条已确认的口径：
 *
 * - **边界 = 可见面板 rect**，不是窗口 rect：`extra.css` 里 `.panel / .settings-panel` 是
 *   100%×100%，当前两者恰好重合（380×680）；仍按渲染层上报的面板算，是为了让边界跟着
 *   「用户看得见的那块」走 —— 若哪天面板改回内缩尺寸（styles.css 里的 356×600 写法），
 *   判定会自动跟着缩，不必再改这里。
 * - **武装（arm）**：鼠标得先进入过面板，否则一直显示。唤起时鼠标通常停在别处，
 *   若直接按「不在面板内就收起」，面板会刚出现就消失。
 * - **延迟固定 600ms**：手一抖划过面板边缘不至于立刻收起。
 *
 * 状态全部是「本次显示」内的：窗口隐藏时复位，下次显示重新武装。
 */

export type PanelRect = { x: number; y: number; width: number; height: number };
export type Point = { x: number; y: number };

export const AUTO_HIDE_DELAY_MS = 600;

export type AutoHideState = {
  /** 鼠标自本次显示以来是否进入过面板 */
  armed: boolean;
  /** 鼠标首次被判为「已离开」的时刻；null = 在面板内、尚未武装、或处于暂停 */
  outsideSince: number | null;
};

export const INITIAL_AUTO_HIDE_STATE: AutoHideState = { armed: false, outsideSince: null };

/** 左闭右开，与 getBoundingClientRect 的语义一致（贴右边框算在外面） */
export function pointInRect(point: Point, rect: PanelRect | null): boolean {
  if (!rect) return false;
  return (
    point.x >= rect.x && point.x < rect.x + rect.width && point.y >= rect.y && point.y < rect.y + rect.height
  );
}

export type AutoHideInput = {
  now: number;
  cursor: Point;
  /** 面板在屏幕坐标下的矩形（主进程把窗口位置加上渲染层上报的窗口内 rect）；null = 还没上报 */
  rect: PanelRect | null;
  /** 窗口是否可见：不可见时状态复位 */
  visible: boolean;
  /** 拖动窗口等场景下暂停判定：不计离，但保留已武装状态 */
  suspended: boolean;
};

export type AutoHideResult = { state: AutoHideState; hide: boolean };

export function stepAutoHide(state: AutoHideState, input: AutoHideInput): AutoHideResult {
  if (!input.visible) return { state: INITIAL_AUTO_HIDE_STATE, hide: false };

  // 矩形没上报（渲染层还没挂上 / 上报值非法）时一律不判离：宁可留着也不能凭一个缺失的
  // 边界把面板收掉 —— 那会表现为「面板刚出来就消失」。
  if (!input.rect) return { state, hide: false };

  if (pointInRect(input.cursor, input.rect)) {
    return { state: { armed: true, outsideSince: null }, hide: false };
  }

  // 鼠标从未进入过本次显示的面板：保持显示（否则唤起瞬间就被收起）
  if (!state.armed) return { state, hide: false };

  // 暂停期间（拖动窗口 / 松手后的缓冲）先从零计时，避免拖动中途把窗口收掉
  if (input.suspended) return { state: { armed: true, outsideSince: null }, hide: false };

  const outsideSince = state.outsideSince ?? input.now;
  if (input.now - outsideSince < AUTO_HIDE_DELAY_MS) {
    return { state: { armed: true, outsideSince }, hide: false };
  }

  // 收起后复位：下次显示必须重新「进入过面板」才允许自动隐藏
  return { state: INITIAL_AUTO_HIDE_STATE, hide: true };
}
