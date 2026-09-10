import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

type InvokeArgs = Record<string, unknown> | undefined;

const api = {
  invoke<T>(channel: string, args?: InvokeArgs): Promise<T> {
    return ipcRenderer.invoke(channel, args) as Promise<T>;
  },
  on<T>(event: string, callback: (payload: T) => void): () => void {
    const listener = (_event: IpcRendererEvent, payload: T) => callback(payload);
    ipcRenderer.on(event, listener);
    return () => {
      ipcRenderer.removeListener(event, listener);
    };
  }
};

contextBridge.exposeInMainWorld("api", api);

export type TokenApi = typeof api;
