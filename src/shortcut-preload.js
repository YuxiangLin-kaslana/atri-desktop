// “快捷键”窗口（本地页面 shortcut.html）的预加载脚本：读现在的快捷键、换一个。
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("atriShortcut", {
  current: () => ipcRenderer.invoke("atri:shortcut:current"),
  save: (accelerator) => ipcRenderer.invoke("atri:shortcut:save", String(accelerator)),
});
