// 桌宠窗口的预加载脚本：只给服务器上的桌宠页（/atri/pet）一小组能力，页面拿不到 Node 和别的系统接口。
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("atriDesktop", {
  setIgnoreMouse: (ignore) => ipcRenderer.send("atri:ignore", Boolean(ignore)),  // 鼠标点透到桌面
  dragBy: (dx, dy) => ipcRenderer.send("atri:drag", Number(dx) || 0, Number(dy) || 0),  // 拖她挪窗口
  dragEnd: () => ipcRenderer.send("atri:dragEnd"),
  openChat: () => ipcRenderer.send("atri:chat"),
  menu: () => ipcRenderer.send("atri:menu"),  // 右键菜单
  ready: (info) => ipcRenderer.send("atri:ready", JSON.parse(JSON.stringify(info ?? {}))),  // 能换的形象
  onCursor: (handler) => ipcRenderer.on("atri:cursor", (_event, point) => handler(point)),  // 屏幕上的鼠标（相对窗口）
  onCommand: (handler) => ipcRenderer.on("atri:command", (_event, command) => handler(String(command))),  // 托盘、快捷键
});
