/**
 * 把 DSM 原本的 Tauri 调用面替换成 Electron 的 preload 桥。
 * 保留同名的 invoke / listen，页面组件几乎不用改。
 */
type InvokeArgs = Record<string, unknown> | undefined;

type BridgeApi = {
  invoke: <T>(channel: string, args?: InvokeArgs) => Promise<T>;
  on: <T>(event: string, callback: (payload: T) => void) => () => void;
};

declare global {
  interface Window {
    api?: BridgeApi;
  }
}

export function invoke<T>(channel: string, args?: InvokeArgs): Promise<T> {
  if (!window.api) return Promise.reject(new Error("未连接本地进程（浏览器预览模式）"));
  return window.api.invoke<T>(channel, args);
}

export function listen<T>(event: string, callback: (event: { payload: T }) => void): Promise<() => void> {
  if (!window.api) return Promise.resolve(() => undefined);
  const off = window.api.on<T>(event, (payload) => callback({ payload }));
  return Promise.resolve(off);
}
