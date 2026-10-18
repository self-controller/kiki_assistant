import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import type { KikiBridge, PopupEvent } from "../shared-types.ts";

const bridge: KikiBridge = {
  popup: {
    init: () => ipcRenderer.invoke("popup:init"),
    ask: (options) => ipcRenderer.invoke("popup:ask", options),
    cancel: () => ipcRenderer.send("popup:cancel"),
    onEvent: (listener) => {
      const handler = (_event: IpcRendererEvent, payload: PopupEvent) => listener(payload);
      ipcRenderer.on("popup:event", handler);
      return () => ipcRenderer.removeListener("popup:event", handler);
    },
    close: () => ipcRenderer.send("popup:close"),
    move: () => ipcRenderer.send("popup:move"),
    hitRect: (rect) => ipcRenderer.send("popup:hitRect", rect),
    pointerOver: (inside) => ipcRenderer.send("popup:pointerOver", inside),
    openLink: (url) => ipcRenderer.send("popup:openLink", url),
    openSettings: () => ipcRenderer.send("popup:openSettings"),
    screenshot: () => ipcRenderer.invoke("popup:screenshot"),
    show: (cardHeight) => ipcRenderer.invoke("popup:show", cardHeight),
    history: () => ipcRenderer.invoke("popup:history"),
    openSession: (id) => ipcRenderer.invoke("popup:openSession", id),
    clearHistory: () => ipcRenderer.invoke("popup:clearHistory"),
    runAction: (id, edited, mode) => ipcRenderer.invoke("popup:runAction", id, edited, mode),
  },
  settings: {
    get: () => ipcRenderer.invoke("settings:get"),
    save: (update) => ipcRenderer.invoke("settings:save", update),
    test: () => ipcRenderer.invoke("settings:test"),
    installShortcut: () => ipcRenderer.invoke("settings:installShortcut"),
    installExtension: () => ipcRenderer.invoke("settings:installExtension"),
    enableAccessibility: () => ipcRenderer.invoke("settings:enableAccessibility"),
    requestMacPermissions: () => ipcRenderer.invoke("settings:requestMacPermissions"),
    connectGoogle: () => ipcRenderer.invoke("settings:connectGoogle"),
    disconnectGoogle: () => ipcRenderer.invoke("settings:disconnectGoogle"),
    quit: () => ipcRenderer.send("settings:quit"),
  },
};

contextBridge.exposeInMainWorld("kiki", bridge);
