// “连接 ATRI 服务器”窗口（本地页面 setup.html）的预加载脚本：读、存服务器地址。
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("atriSetup", {
  current: () => ipcRenderer.invoke("atri:setup:current"),
  save: (url) => ipcRenderer.invoke("atri:setup:save", String(url)),
});
