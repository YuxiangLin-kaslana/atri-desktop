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
  idleSeconds: () => ipcRenderer.invoke("atri:idle"),  // 多久没动键盘鼠标了（判断人在不在电脑前）
  // 看屏幕：只有用户在菜单里打开了才截得到；页面只能把它关掉，开不了
  captureScreen: () => ipcRenderer.invoke("atri:capture"),  // JPEG（Uint8Array）
  stopWatching: () => ipcRenderer.send("atri:stopWatching"),
  onWatching: (handler) => ipcRenderer.on("atri:watching", (_event, on) => handler(Boolean(on))),
  voiceOff: () => ipcRenderer.send("atri:voiceOff"),
  notify: (title, body) => ipcRenderer.send("atri:notify", String(title ?? ""), String(body ?? "")),  // 她被藏起来时弹系统通知  // 页面上点“在听”关掉语音对话，菜单跟着取消勾选
});
