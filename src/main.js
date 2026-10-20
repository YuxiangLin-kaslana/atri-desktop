// ATRI 桌宠的主进程。它只是个外壳：把 ATRI 服务器（默认 DEFAULT_SERVER）上的桌宠页（/atri/pet）放进一个透明、没边框、总在最前的小窗口，
// 再管点透、拖动、托盘菜单、开机启动和自动更新。聊天、记忆、形象模型都在服务器上，这里不存任何密钥。
// “让她看屏幕”默认关着，只有用户在托盘或右键菜单里打开才截图（每次启动都是关的）；她只能看，没有操作键盘鼠标的能力。
// “语音对话”也是用户在菜单里开才占用麦克风（页面头顶挂着“在听”）；页面能要的权限只有麦克风，摄像头等一律不给。
// “允许她用电脑”（手 B）也是用户在菜单里开：开着时服务器派来的事，桌宠一步步让这里动鼠标键盘（hands.ps1）；
// 用户一碰鼠标键盘她马上停，屏幕顶上一直挂着“ATRI 正在用电脑”；付钱、发消息、删东西这类由服务器先问用户。
const { app, BrowserWindow, Menu, Notification, Tray, desktopCapturer, dialog, globalShortcut, ipcMain, nativeImage, net, powerMonitor, screen, session, shell } = require("electron");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { autoUpdater } = require("electron-updater");

const PARTITION = "persist:atri";  // 桌宠、聊天、登录窗口共用一份 cookie（登录一次就行）
// 大小：360×600 乘一个比例；在她身上滚滚轮随意调（0.4～2.5 倍），菜单里有几档常用的。默认 0.7（原来的 1 太大了）
const BASE = { width: 360, height: 600 };
const SCALES = { small: { label: "小", scale: 0.55 }, medium: { label: "中", scale: 0.7 }, large: { label: "大", scale: 0.9 }, huge: { label: "特大", scale: 1.2 } };
const MIN_SCALE = 0.4, MAX_SCALE = 2.5, ZOOM_STEP = 1.08;
const SIZE_LAYOUT = 2;  // 设置里的大小是第几版：1（0.1.5）的比例整体缩到 0.7
const clampScale = (scale) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, Number(scale) || 1));
const sizeOf = (scale) => ({ width: Math.round(BASE.width * scale), height: Math.round(BASE.height * scale) });
const DEFAULT_SHORTCUT = "Control+Alt+A";  // 叫她出来说话；托盘菜单“快捷键…”里能换（和 QQ 截图撞了之类），空字符串是不用
const ICON = path.join(__dirname, "assets", "icon.png");
const DEFAULT_SERVER = "https://atri.yuxianglin.xyz";  // 默认连这个；要连别的服务器在托盘菜单“服务器地址…”里改
const DEFAULTS = { server: DEFAULT_SERVER, scale: 0.7, sizeLayout: SIZE_LAYOUT, computer: false, computerAgreed: false, position: null, alwaysOnTop: true, model: null, watchAgreed: false, speak: true, shortcut: DEFAULT_SHORTCUT };
const SHOT_WIDTH = 1280;  // 截图缩到这么宽再给页面（够她看清，传得也快）

let settings = { ...DEFAULTS };
let pet = null, chat = null, login = null, setup = null, keysWindow = null, tray = null;
let shortcutOn = "";  // 现在注册着的快捷键
let models = [], updateReady = null, cursorTimer = null, dragTimer = null;
let watching = false, locked = false;  // 让她看屏幕（不存进设置，每次启动都是关的）；锁屏时不截
let voiceOn = false;  // 语音对话（麦克风一直听；每次启动都是关的）
let hands = null, handsReady = null, handsSeq = 0;
const handsWaiting = new Map();
let control = null;  // 正在用电脑：{ startedAt, display, shot: {width, height}, interrupted, timer }
let overlay = null;

// ---- 设置：存在用户目录的 settings.json ----
const settingsFile = () => path.join(app.getPath("userData"), "settings.json");
function loadSettings() {
  try { settings = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(settingsFile(), "utf8")) }; } catch { settings = { ...DEFAULTS }; }
  if (typeof settings.scale !== "number") settings.scale = { small: 0.78, medium: 1, large: 1.28 }[settings.size] || 1;  // 0.1.4 以前存的是 small / medium / large
  delete settings.size;
  if (settings.sizeLayout !== SIZE_LAYOUT) {  // 0.1.5 的大小整体偏大：缩到 0.7 倍，只缩这一次（脚底留在原地）
    const before = sizeOf(clampScale(settings.scale)), after = sizeOf(clampScale(settings.scale * 0.7));
    if (settings.position) {
      settings.position = {
        x: Math.round(settings.position.x + (before.width - after.width) / 2),
        y: settings.position.y + before.height - after.height,
      };
    }
    settings.scale *= 0.7;
    settings.sizeLayout = SIZE_LAYOUT;
    saveSettings();
  }
  settings.scale = clampScale(settings.scale);
  if (!settings.server) settings.server = DEFAULT_SERVER;
}
function saveSettings() {
  try { fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2)); } catch (error) { log("settings", error); }
}
function log(...parts) {
  try { fs.appendFileSync(path.join(app.getPath("userData"), "atri.log"), `${new Date().toISOString()} ${parts.map(String).join(" ")}\n`); } catch {}
}

// ---- 服务器地址：只认这一个来源的页面，别的网址一律交给系统浏览器 ----
const origin = () => new URL(settings.server).origin;
function sameOrigin(url) {
  try { return new URL(url).origin === origin(); } catch { return false; }
}
function external(url) {
  if (/^https?:\/\//i.test(url)) shell.openExternal(url);
}
function guard(win) {
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (sameOrigin(url) && new URL(url).pathname.startsWith("/atri/chat")) openChat();
    else external(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    if (!sameOrigin(url)) { event.preventDefault(); external(url); }
  });
}
const isLogin = (url) => sameOrigin(url) && new URL(url).pathname.startsWith("/atri/login");

// ---- 桌宠窗口 ----
function defaultPosition({ width, height }) {
  const area = screen.getPrimaryDisplay().workArea;
  return { x: area.x + area.width - width - 24, y: area.y + area.height - height };
}
function onScreen(position, size) {
  return screen.getAllDisplays().some(({ workArea: a }) =>
    position.x + size.width / 2 >= a.x && position.x + size.width / 2 <= a.x + a.width && position.y + 40 >= a.y && position.y + 40 <= a.y + a.height);
}
function createPet() {
  const size = sizeOf(settings.scale);
  const position = settings.position && onScreen(settings.position, size) ? settings.position : defaultPosition(size);
  pet = new BrowserWindow({
    width: size.width, height: size.height, x: position.x, y: position.y,
    transparent: true, frame: false, resizable: false, maximizable: false, fullscreenable: false, hasShadow: false,
    skipTaskbar: true, alwaysOnTop: settings.alwaysOnTop, show: false, backgroundColor: "#00000000", title: "ATRI", icon: ICON,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"), partition: PARTITION,
      contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false,
      autoplayPolicy: "no-user-gesture-required",  // 她主动说话、提醒时不用先点一下才出声
    },
  });
  if (settings.alwaysOnTop) pet.setAlwaysOnTop(true, "floating");
  guard(pet);
  pet.webContents.on("did-navigate", (_event, url) => { if (isLogin(url)) { pet.hide(); openLogin(url); } });
  pet.webContents.on("did-fail-load", (_event, code, reason, url, isMainFrame) => {
    if (code === -3 || !isMainFrame) return;  // -3：被新的导航打断
    log("pet load failed", code, reason, url);
    dialog.showMessageBox({ type: "warning", title: "ATRI", message: `连不上 ATRI 服务器（${reason}）`, detail: `地址：${settings.server}\n可以在托盘菜单里改服务器地址，或者稍后点“重新连接”。` });
  });
  pet.once("ready-to-show", () => { if (!isLogin(pet.webContents.getURL())) pet.showInactive(); });  // 被转到登录页时不显示
  pet.on("show", refreshTray);
  pet.on("hide", () => {  // 藏起来就看不到“在看屏幕”“在听”的标记了：一起关掉
    refreshTray();
    if (watching) setWatching(false);
    if (voiceOn) setVoice(false);
  });
  pet.on("closed", () => { pet = null; });
  pet.loadURL(`${origin()}/atri/pet`);
  // 视线：每隔一会儿把鼠标在屏幕上的位置（相对窗口）告诉页面，窗口外也跟着看
  clearInterval(cursorTimer);
  cursorTimer = setInterval(() => {
    if (!pet || pet.isDestroyed() || !pet.isVisible()) return;
    const point = screen.getCursorScreenPoint(), box = pet.getBounds();
    pet.webContents.send("atri:cursor", { x: point.x - box.x, y: point.y - box.y });
  }, 60);
}
function resizePet(scale) {
  settings.scale = clampScale(scale);
  saveSettings();
  if (!pet) return;
  const box = pet.getBounds(), next = sizeOf(settings.scale);
  // 脚底不动：往上长、往左右两边长
  pet.setBounds({ x: Math.round(box.x + (box.width - next.width) / 2), y: box.y + box.height - next.height, width: next.width, height: next.height });
  rememberPosition();
  refreshTray();
}
// 拖她：按住拖动时由这里跟着屏幕上的鼠标挪窗口（比页面一步步传位移稳，高 DPI 下也不会越拖越大）；松手或两分钟后停
function startDrag() {
  const start = screen.getCursorScreenPoint(), box = pet.getBounds(), began = Date.now();
  const offset = { x: start.x - box.x, y: start.y - box.y }, size = { width: box.width, height: box.height };
  clearInterval(dragTimer);
  dragTimer = setInterval(() => {
    if (!pet || pet.isDestroyed() || Date.now() - began > 120000) return stopDrag();
    const point = screen.getCursorScreenPoint();
    pet.setBounds({ x: point.x - offset.x, y: point.y - offset.y, ...size });
  }, 16);
}
function stopDrag() {
  clearInterval(dragTimer);
  dragTimer = null;
  rememberPosition();
}
function rememberPosition() {
  if (!pet) return;
  const { x, y } = pet.getBounds();
  settings.position = { x, y };
  saveSettings();
}
function showPet() {
  if (!settings.server) return openSetup();
  if (!pet) return createPet();
  if (isLogin(pet.webContents.getURL())) return openLogin(pet.webContents.getURL());  // 还没登录
  pet.showInactive();
}
function talk() {
  showPet();
  if (pet) { pet.focus(); pet.webContents.send("atri:command", "talk"); }
}

// ---- 登录、聊天、服务器地址窗口 ----
function openLogin(url) {
  if (login) return login.focus();
  login = new BrowserWindow({
    width: 460, height: 680, title: "登录 ATRI", icon: ICON, autoHideMenuBar: true,
    webPreferences: { partition: PARTITION, contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  guard(login);
  login.webContents.on("did-navigate", (_event, next) => {
    if (sameOrigin(next) && !isLogin(next)) {  // 登录好了，跳回别的页
      login.close();
      if (!pet) return createPet();
      pet.webContents.once("did-finish-load", () => pet?.showInactive());
      pet.loadURL(`${origin()}/atri/pet`);
    }
  });
  login.on("closed", () => { login = null; });
  login.loadURL(url);
}
function openChat() {
  if (!settings.server) return openSetup();
  if (chat) { chat.show(); return chat.focus(); }
  chat = new BrowserWindow({
    width: 1100, height: 760, title: "ATRI", icon: ICON, autoHideMenuBar: true,
    webPreferences: { partition: PARTITION, contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  guard(chat);
  chat.on("closed", () => { chat = null; });
  chat.loadURL(`${origin()}/atri/chat`);
}
function openSetup() {
  if (setup) return setup.focus();
  setup = new BrowserWindow({
    width: 460, height: 340, title: "连接 ATRI 服务器", icon: ICON, autoHideMenuBar: true, resizable: false,
    webPreferences: { preload: path.join(__dirname, "setup-preload.js"), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  setup.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  setup.webContents.on("will-navigate", (event) => event.preventDefault());
  setup.on("closed", () => { setup = null; if (!settings.server) app.quit(); });
  setup.loadFile(path.join(__dirname, "setup.html"));
}

// ---- 和她说话的快捷键：能换、能不用；被别的软件占了就提醒去换 ----
const showKeys = (accelerator) => (accelerator ? accelerator.replace(/Control/g, "Ctrl").replace(/Super/g, "Win") : "不用");
function useShortcut(accelerator) {
  if (shortcutOn) globalShortcut.unregister(shortcutOn);
  shortcutOn = "";
  if (!accelerator) return true;
  let ok = false;
  try { ok = globalShortcut.register(accelerator, talk); } catch { ok = false; }  // 写法不对会抛错
  if (ok) shortcutOn = accelerator;
  return ok;
}
function saveShortcut(raw) {
  const accelerator = String(raw || "").trim();
  if (accelerator && !/^((Control|Alt|Shift|Super)\+)*([A-Z0-9]|F([1-9]|1[0-9]|2[0-4])|num[0-9]|Space|Enter|Tab|Backspace|Delete|Insert|Home|End|PageUp|PageDown|Up|Down|Left|Right|Escape|[`\-=\[\]\\;',./])$/.test(accelerator)) {
    return { ok: false, message: "这个组合认不出来，换一个试试" };
  }
  if (!useShortcut(accelerator)) {
    useShortcut(keysWindow ? "" : settings.shortcut);  // 窗口开着时先不注册旧的，免得在窗口里按到它
    return { ok: false, message: `${showKeys(accelerator)} 被别的软件占了，换一个吧` };
  }
  settings.shortcut = accelerator;
  saveSettings();
  refreshTray();
  return { ok: true, current: accelerator };
}
function openShortcut() {
  if (keysWindow) return keysWindow.focus();
  useShortcut("");  // 设的时候先放开，按到旧的组合不会叫她出来
  keysWindow = new BrowserWindow({
    width: 460, height: 360, title: "和她说话的快捷键", icon: ICON, autoHideMenuBar: true, resizable: false,
    webPreferences: { preload: path.join(__dirname, "shortcut-preload.js"), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  keysWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  keysWindow.webContents.on("will-navigate", (event) => event.preventDefault());
  keysWindow.on("closed", () => { keysWindow = null; if (shortcutOn !== settings.shortcut) useShortcut(settings.shortcut); });
  keysWindow.loadFile(path.join(__dirname, "shortcut.html"));
}
const fromKeys = (event) => keysWindow && event.sender === keysWindow.webContents;
ipcMain.handle("atri:shortcut:current", (event) => (fromKeys(event) ? { current: settings.shortcut, default: DEFAULT_SHORTCUT } : null));
ipcMain.handle("atri:shortcut:save", (event, accelerator) => (fromKeys(event) ? saveShortcut(accelerator) : { ok: false, message: "不认识的请求" }));

// ---- 页面发来的请求：只认桌宠窗口里、服务器那个来源的页面 ----
const fromPet = (event) => pet && event.sender === pet.webContents && sameOrigin(event.senderFrame?.url || "");
ipcMain.on("atri:ignore", (event, ignore) => { if (fromPet(event)) pet.setIgnoreMouseEvents(Boolean(ignore), { forward: true }); });
ipcMain.on("atri:drag", (event, dx, dy) => {  // 旧的桌宠页一步步传位移
  if (!fromPet(event)) return;
  const box = pet.getBounds();
  pet.setBounds({ x: Math.round(box.x + (Number(dx) || 0)), y: Math.round(box.y + (Number(dy) || 0)), width: box.width, height: box.height });
});
ipcMain.on("atri:dragStart", (event) => { if (fromPet(event)) startDrag(); });
ipcMain.on("atri:dragEnd", (event) => { if (fromPet(event)) stopDrag(); });
ipcMain.on("atri:zoom", (event, direction) => {  // 在她身上滚滚轮：放大缩小
  if (fromPet(event)) resizePet(settings.scale * (Number(direction) > 0 ? ZOOM_STEP : 1 / ZOOM_STEP));
});
ipcMain.on("atri:chat", (event) => { if (fromPet(event)) openChat(); });
ipcMain.on("atri:menu", (event) => { if (fromPet(event)) Menu.buildFromTemplate(menuItems()).popup({ window: pet }); });
ipcMain.on("atri:ready", (event, info) => {
  if (!fromPet(event)) return;
  models = Array.isArray(info?.models) ? info.models.filter((m) => m && typeof m.name === "string").slice(0, 20) : [];
  settings.model = typeof info?.model === "string" ? info.model : settings.model;
  refreshTray();
  if (updateReady) pet.webContents.send("atri:command", `say:新版本 ${updateReady} 已经下好了，退出时会自动装上。`);
  pet.webContents.send("atri:watching", watching);  // 页面重新加载过：告诉它现在看没看、念不念、听不听
  pet.webContents.send("atri:command", settings.speak ? "speak:on" : "speak:off");
  pet.webContents.send("atri:computer", { allowed: settings.computer });
  if (voiceOn) pet.webContents.send("atri:command", "voice:on");
});
ipcMain.handle("atri:capture", (event) => {
  if (!fromPet(event)) throw new Error("不认识的请求");
  return captureScreen();
});
ipcMain.on("atri:stopWatching", (event) => { if (fromPet(event)) setWatching(false); });  // 页面只能关，不能开
// 用电脑：页面问能不能用、开始和结束一件事、看屏幕、做一步。允许与否只能在菜单里改（页面只能停）
ipcMain.handle("atri:computer:state", (event) => (fromPet(event) ? { allowed: settings.computer, platform: process.platform } : null));
ipcMain.handle("atri:computer:away", async (event) => {
  if (!fromPet(event) || locked) return false;
  return powerMonitor.getSystemIdleTime() >= 300;  // 五分钟没动键盘鼠标：用户不在电脑前
});
ipcMain.handle("atri:computer:begin", async (event) => {
  if (!fromPet(event)) throw new Error("不认识的请求");
  await beginControl();
  return true;
});
ipcMain.on("atri:computer:end", (event) => { if (fromPet(event)) endControl(); });
ipcMain.handle("atri:computer:observe", (event) => {
  if (!fromPet(event)) throw new Error("不认识的请求");
  return observe();
});
ipcMain.handle("atri:computer:act", (event, action) => {
  if (!fromPet(event)) return { ok: false, error: "不认识的请求" };
  return act(action && typeof action === "object" ? action : {});
});
ipcMain.on("atri:voiceOff", (event) => { if (fromPet(event)) { voiceOn = false; refreshTray(); } });  // 页面上点了“在听”关掉
// 提醒、她主动说的话：她站在桌面上时气泡就够了；被藏起来时弹 Windows 通知，点一下叫她出来
let shownNotes = 0;
ipcMain.on("atri:notify", (event, title, body) => {
  if (!fromPet(event) || pet.isVisible() || !Notification.isSupported()) return;
  shownNotes += 1;
  const note = new Notification({ title: String(title || "ATRI").slice(0, 100), body: String(body || "").slice(0, 300), icon: ICON });
  note.on("click", () => { showPet(); });
  note.show();
});
ipcMain.handle("atri:idle", (event) => (fromPet(event) ? powerMonitor.getSystemIdleTime() : null));
ipcMain.handle("atri:setup:current", (event) => (setup && event.sender === setup.webContents ? settings.server : ""));
ipcMain.handle("atri:setup:save", async (event, raw) => {
  if (!setup || event.sender !== setup.webContents) return { ok: false, message: "不认识的请求" };
  let url;
  try { url = new URL(String(raw).trim().replace(/\/+$/, "")); } catch { return { ok: false, message: "不是一个网址" }; }
  if (!/^https?:$/.test(url.protocol)) return { ok: false, message: "要以 https:// 开头" };
  try {
    const response = await net.fetch(`${url.origin}/atri/login`, { method: "HEAD" });
    if (!response.ok && response.status !== 405) return { ok: false, message: `这个地址不像 ATRI 服务器（${response.status}）` };
  } catch (error) {
    return { ok: false, message: `连不上：${error.message}` };
  }
  const changed = settings.server !== url.origin;
  settings.server = url.origin;
  saveSettings();
  setup.close();
  if (changed && pet) { pet.destroy(); pet = null; }
  showPet();
  return { ok: true };
});

// ---- 让她看屏幕：用户打开才截图，桌宠页上一直挂着“在看屏幕”的标记，点它或在菜单里就能关 ----
async function setWatching(on, { asked = true } = {}) {
  if (on && asked && !settings.watchAgreed) {
    const { response } = await dialog.showMessageBox({
      type: "question", title: "让 ATRI 看屏幕", buttons: ["打开", "取消"], defaultId: 0, cancelId: 1,
      message: "打开后，ATRI 每隔半分钟看一眼你的屏幕",
      detail: "屏幕变了才把截图发到你的 ATRI 服务器给她看（服务器不保存截图）；你在桌宠里和她说话时，会附上当时的截图。\n"
        + "她旁边会一直显示“在看屏幕”，点它或在菜单里取消勾选就关掉。锁屏时不看。\n她只能看，不能操作你的键盘和鼠标。",
    });
    if (response !== 0) return refreshTray();
    settings.watchAgreed = true;
    saveSettings();
  }
  watching = Boolean(on);
  log("watching", watching);
  refreshTray();
  if (tray) tray.setToolTip(watching ? "ATRI（在看屏幕）" : "ATRI");
  pet?.webContents.send("atri:watching", watching);
}
async function captureScreen() {
  if (!watching || locked || !pet?.isVisible()) throw new Error("没在看屏幕");
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());  // 鼠标在哪块屏幕就看哪块
  const { width, height } = display.size;
  const size = { width: SHOT_WIDTH, height: Math.round(SHOT_WIDTH * height / width) };
  const sources = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: size });
  const source = sources.find((each) => each.display_id === String(display.id)) || sources[0];
  if (!source || source.thumbnail.isEmpty()) throw new Error("截不到屏幕");
  return new Uint8Array(source.thumbnail.toJPEG(70));
}

// ---- 语音：语音对话（一直听）和念出她的话，都在菜单里开关 ----
function setVoice(on) {
  voiceOn = Boolean(on);
  refreshTray();
  pet?.webContents.send("atri:command", voiceOn ? "voice:on" : "voice:off");
}
function setSpeak(on) {
  settings.speak = Boolean(on);
  saveSettings();
  refreshTray();
  pet?.webContents.send("atri:command", settings.speak ? "speak:on" : "speak:off");
}
// 页面能要的权限：只有服务器那个来源的页面要麦克风（不要摄像头）、往剪贴板写字
function guardPermissions() {
  const allowed = (permission, url, details = {}) => {
    if (!sameOrigin(url || "")) return false;
    if (permission === "media") return (details.mediaTypes || ["audio"]).every((type) => type === "audio") && details.mediaType !== "video";
    return permission === "clipboard-sanitized-write";
  };
  const partition = session.fromPartition(PARTITION);
  partition.setPermissionRequestHandler((_contents, permission, callback, details) => callback(allowed(permission, details.requestingUrl, details)));
  partition.setPermissionCheckHandler((_contents, permission, origin, details) => allowed(permission, origin, details));
}

// ---- 允许她用电脑（手 B） ----
function handsScript() {
  return path.join(__dirname, "hands.ps1").replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);  // 打包后在 asar 外面
}
function startHands() {
  if (hands || process.platform !== "win32") return handsReady;
  hands = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", handsScript()], { windowsHide: true });
  let buffer = "";
  handsReady = new Promise((resolve, reject) => {
    const failed = (error) => { log("hands failed", error); reject(error); };
    hands.once("error", failed);
    hands.stdout.setEncoding("utf8");
    hands.stdout.on("data", (chunk) => {
      buffer += chunk;
      let cut;
      while ((cut = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, cut).trim();
        buffer = buffer.slice(cut + 1);
        if (!line) continue;
        let reply;
        try { reply = JSON.parse(line); } catch { continue; }
        if (reply.ready) { resolve(); continue; }
        const waiter = handsWaiting.get(reply.id);
        if (waiter) { handsWaiting.delete(reply.id); waiter(reply); }
      }
    });
  });
  hands.stderr.on("data", (chunk) => log("hands", String(chunk).slice(0, 500)));
  hands.on("exit", (code) => {
    log("hands exited", code);
    hands = null;
    handsReady = null;
    for (const waiter of handsWaiting.values()) waiter({ ok: false, error: "手没了" });
    handsWaiting.clear();
  });
  return handsReady;
}
function stopHands() {
  if (hands) { hands.stdin.end(); hands.kill(); }
  hands = null;
  handsReady = null;
}
async function handsCall(command, timeoutMs = 15000) {
  await startHands();
  if (!hands) throw new Error("这台电脑上用不了");
  const id = ++handsSeq;
  return new Promise((resolve) => {
    const timer = setTimeout(() => { handsWaiting.delete(id); resolve({ ok: false, error: "手没反应" }); }, timeoutMs);
    handsWaiting.set(id, (reply) => { clearTimeout(timer); resolve(reply); });
    hands.stdin.write(`${JSON.stringify({ ...command, id })}\n`);
  });
}
async function setComputer(on, { asked = true } = {}) {
  if (on && asked && !settings.computerAgreed) {
    const { response } = await dialog.showMessageBox({
      type: "question", title: "让 ATRI 用你的电脑", buttons: ["允许", "取消"], defaultId: 0, cancelId: 1,
      message: "允许以后，她可以动你的鼠标和键盘",
      detail: "只做你在聊天里让她做的事：她会一步步看屏幕、点鼠标、打字。她自己想做的事用她自己的电脑，不碰你的电脑和账号。\n"
        + "她在用的时候屏幕顶上一直有“ATRI 正在用电脑”；你一碰鼠标或键盘她马上停。锁屏时不动。\n"
        + "付钱、发消息、删东西、输密码、装软件这类，她会先问你。随时可以在这个菜单里关掉。",
    });
    if (response !== 0) return refreshTray();
    settings.computerAgreed = true;
  }
  settings.computer = Boolean(on);
  saveSettings();
  if (!settings.computer) { endControl("你关掉了“允许她用电脑”"); stopHands(); }
  refreshTray();
  pet?.webContents.send("atri:computer", { allowed: settings.computer });
}
function showOverlay(display) {
  if (overlay) return;
  const width = 420, height = 34, area = display.workArea;
  overlay = new BrowserWindow({
    width, height, x: Math.round(area.x + (area.width - width) / 2), y: area.y + 6, frame: false, transparent: true, resizable: false,
    focusable: false, skipTaskbar: true, alwaysOnTop: true, hasShadow: false, show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  overlay.setAlwaysOnTop(true, "screen-saver");
  overlay.setIgnoreMouseEvents(true);
  overlay.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`<body style="margin:0;background:transparent;font:13px/34px system-ui,'Microsoft YaHei',sans-serif">
    <div style="margin:0 auto;width:fit-content;padding:0 14px;border-radius:17px;background:rgba(200,75,75,.92);color:#fff">ATRI 正在用电脑 · 动一下鼠标或按任意键就停</div></body>`)}`);
  overlay.once("ready-to-show", () => overlay?.showInactive());
  overlay.on("closed", () => { overlay = null; });
}
function endControl(reason) {
  if (!control) return;
  clearInterval(control.timer);
  const wasInterrupted = control.interrupted;
  control = null;
  overlay?.close();
  overlay = null;
  if (reason || wasInterrupted) pet?.webContents.send("atri:computer:stopped", reason || "你动了鼠标或键盘");
}
async function beginControl() {
  if (!settings.computer) throw new Error("没有允许她用电脑");
  if (locked) throw new Error("锁屏了");
  await startHands();
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  control = { startedAt: Date.now(), display, shot: null, interrupted: false, timer: null };
  showOverlay(display);
  // 你一碰鼠标键盘就停：每 0.3 秒问一次“真人”多久没动了
  control.timer = setInterval(async () => {
    if (!control) return;
    const reply = await handsCall({ cmd: "idle" }, 3000);
    if (control && reply.ok && reply.physical_ms < Date.now() - control.startedAt - 300) {
      control.interrupted = true;
      endControl("你动了鼠标或键盘，她先停下了");
    }
  }, 300);
}
function toShot(point) {  // 屏幕物理像素 → 截图上的像素
  const { display, shot } = control;
  const dip = process.platform === "win32" ? screen.screenToDipPoint(point) : point;
  return { x: Math.round((dip.x - display.bounds.x) * shot.width / display.bounds.width), y: Math.round((dip.y - display.bounds.y) * shot.height / display.bounds.height) };
}
function toScreen(x, y) {  // 截图上的像素 → 屏幕物理像素
  const { display, shot } = control;
  const dip = { x: display.bounds.x + x * display.bounds.width / shot.width, y: display.bounds.y + y * display.bounds.height / shot.height };
  const point = process.platform === "win32" ? screen.dipToScreenPoint(dip) : dip;
  return { x: Math.round(point.x), y: Math.round(point.y) };
}
async function observe() {
  if (!control || control.interrupted) throw new Error("没在用电脑");
  const { display } = control;
  const size = { width: SHOT_WIDTH, height: Math.round(SHOT_WIDTH * display.size.height / display.size.width) };
  const sources = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: size });
  const source = sources.find((each) => each.display_id === String(display.id)) || sources[0];
  if (!source || source.thumbnail.isEmpty()) throw new Error("截不到屏幕");
  control.shot = source.thumbnail.getSize();
  const found = await handsCall({ cmd: "elements", max: 80 }, 20000);
  const elements = [];
  for (const item of (found.ok ? found.elements || [] : [])) {
    const topLeft = toShot({ x: item.x, y: item.y }), bottomRight = toShot({ x: item.x + item.w, y: item.y + item.h });
    if (bottomRight.x <= 0 || bottomRight.y <= 0 || topLeft.x >= control.shot.width || topLeft.y >= control.shot.height) continue;
    elements.push({ id: elements.length + 1, role: item.role, name: item.name, x: topLeft.x, y: topLeft.y,
      w: bottomRight.x - topLeft.x, h: bottomRight.y - topLeft.y, focused: item.focused, password: item.password });
  }
  control.elements = elements;
  return { image: new Uint8Array(source.thumbnail.toJPEG(70)), screen: control.shot, window: found.window || "", elements,
    display: { x: display.bounds.x, y: display.bounds.y, width: display.bounds.width, height: display.bounds.height } };
}
async function act(action) {
  if (!control || control.interrupted) return { ok: false, interrupted: Boolean(control?.interrupted), error: "没在用电脑" };
  if (!control.shot) return { ok: false, error: "还没看过屏幕" };
  const at = (x, y) => toScreen(Number(x) || 0, Number(y) || 0);
  let target = null;
  if (action.element != null) {
    const element = (control.elements || []).find((each) => String(each.id) === String(action.element));
    if (!element) return { ok: false, error: `没有编号 ${action.element} 的控件` };
    target = at(element.x + element.w / 2, element.y + element.h / 2);
  } else if (action.x != null) {
    target = at(action.x, action.y);
  }
  let reply;
  switch (action.type) {
    case "click": reply = target ? await handsCall({ cmd: "click", ...target, button: action.button === "right" ? "right" : "left", count: action.count === 2 ? 2 : 1 }) : { ok: false, error: "点哪里？" }; break;
    case "type": reply = await handsCall({ cmd: "type", text: String(action.text || "").slice(0, 2000) }); break;
    case "key": reply = await handsCall({ cmd: "keys", keys: String(action.keys || "") }); break;
    case "scroll": reply = await handsCall({ cmd: "scroll", ...(target || at(control.shot.width / 2, control.shot.height / 2)), amount: Math.max(-30, Math.min(30, Number(action.amount) || -5)) }); break;
    case "open":
      if (!/^https?:\/\//i.test(String(action.url || ""))) return { ok: false, error: "只能打开网页" };
      await shell.openExternal(String(action.url));
      reply = { ok: true };
      break;
    default: return { ok: false, error: `不认识的动作：${action.type}` };
  }
  if (control?.interrupted) return { ok: false, interrupted: true, error: "你动了鼠标或键盘" };
  return reply.ok ? { ok: true } : { ok: false, error: reply.error || "没做成" };
}

// ---- 托盘和右键菜单 ----
function menuItems() {
  const items = [
    { label: "和她说话", ...(settings.shortcut ? { accelerator: settings.shortcut } : {}), click: talk },
    { label: "打开聊天窗口", click: openChat },
    { label: "语音对话", type: "checkbox", checked: voiceOn, click: (item) => setVoice(item.checked) },
    { label: "念出她的话", type: "checkbox", checked: settings.speak, click: (item) => setSpeak(item.checked) },
    { label: "让她看屏幕", type: "checkbox", checked: watching, click: (item) => setWatching(item.checked) },
    { label: "允许她用电脑", type: "checkbox", checked: settings.computer, visible: process.platform === "win32" || Boolean(process.env.ATRI_SMOKE),
      click: (item) => setComputer(item.checked) },
    { type: "separator" },
    { label: "大小", submenu: [
      ...Object.values(SCALES).map((size) => ({ label: size.label, type: "radio", checked: Math.abs(settings.scale - size.scale) < 0.01, click: () => resizePet(size.scale) })),
      { type: "separator" },
      { label: `现在 ${Math.round(settings.scale * 100)}%（在她身上滚动滚轮随意调）`, enabled: false },
    ] },
  ];
  if (models.length) {
    items.push({ label: "换形象", submenu: models.map((model) => ({
      label: model.title || model.name, type: "radio", checked: settings.model === model.name,
      click: () => { settings.model = model.name; saveSettings(); pet?.webContents.send("atri:command", `model:${model.name}`); refreshTray(); },
    })) });
  }
  items.push(
    { label: "总在最前", type: "checkbox", checked: settings.alwaysOnTop, click: (item) => {
      settings.alwaysOnTop = item.checked;
      saveSettings();
      pet?.setAlwaysOnTop(item.checked, "floating");
    } },
    { label: "开机启动", type: "checkbox", checked: app.getLoginItemSettings().openAtLogin, click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked }) },
    { type: "separator" },
    { label: pet?.isVisible() ? "藏起来" : "叫她出来", click: () => { if (pet?.isVisible()) pet.hide(); else showPet(); refreshTray(); } },
    { label: "重新连接", click: () => { if (pet) pet.loadURL(`${origin()}/atri/pet`); else showPet(); } },
    { label: `快捷键（现在：${showKeys(settings.shortcut)}）…`, click: openShortcut },
    { label: "服务器地址…", click: openSetup },
    updateReady
      ? { label: `重启并更新到 ${updateReady}`, click: () => autoUpdater.quitAndInstall() }
      : { label: "检查更新", click: () => checkForUpdates(true) },
    { label: `版本 ${app.getVersion()}`, enabled: false },
    { type: "separator" },
    { label: "退出", click: () => app.quit() },
  );
  return items;
}
function refreshTray() {
  if (tray) tray.setContextMenu(Menu.buildFromTemplate(menuItems()));
}
function createTray() {
  tray = new Tray(nativeImage.createFromPath(ICON).resize({ width: 16, height: 16 }));
  tray.setToolTip("ATRI");
  tray.on("click", () => { if (pet?.isVisible()) talk(); else showPet(); });
  refreshTray();
}

// ---- 自动更新：从 GitHub Release 下载新版，退出时装上 ----
let manualCheck = false;
function checkForUpdates(manual) {
  if (!app.isPackaged) {
    if (manual) dialog.showMessageBox({ title: "ATRI", message: "开发版不检查更新。" });
    return;
  }
  manualCheck = Boolean(manual);
  autoUpdater.checkForUpdates().catch((error) => log("update check failed", error));
}
function setupUpdater() {
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = { info: (m) => log("updater", m), warn: (m) => log("updater warn", m), error: (m) => log("updater error", m), debug: () => {} };
  autoUpdater.on("update-not-available", () => {
    if (manualCheck) dialog.showMessageBox({ title: "ATRI", message: `已经是最新版（${app.getVersion()}）。` });
    manualCheck = false;
  });
  autoUpdater.on("update-available", (info) => {
    if (manualCheck) dialog.showMessageBox({ title: "ATRI", message: `有新版本 ${info.version}，正在后台下载，下好了会告诉你。` });
    manualCheck = false;
  });
  autoUpdater.on("update-downloaded", (info) => {
    updateReady = info.version;
    refreshTray();
    pet?.webContents.send("atri:command", `say:新版本 ${info.version} 已经下好了，退出时会自动装上；托盘菜单里也可以马上重启更新。`);
  });
  autoUpdater.on("error", (error) => {
    log("updater error", error);
    if (manualCheck) dialog.showMessageBox({ type: "warning", title: "ATRI", message: "检查更新失败", detail: String(error?.message || error) });
    manualCheck = false;
  });
  checkForUpdates(false);
  setInterval(() => checkForUpdates(false), 4 * 60 * 60 * 1000);
}

// ---- 启动 ----
// 用户目录（设置、日志、cookie）可以用环境变量 ATRI_USER_DATA 换地方：冒烟测试用，也能做成便携版
if (process.env.ATRI_USER_DATA) app.setPath("userData", process.env.ATRI_USER_DATA);
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => talk());
  app.whenReady().then(() => {
    app.setAppUserModelId("io.github.yuxianglin-kaslana.atri-desktop");
    loadSettings();
    guardPermissions();
    createTray();
    if (settings.server) createPet(); else openSetup();
    if (!useShortcut(settings.shortcut)) {  // 被别的软件占了（比如 QQ 截图也是 Ctrl+Alt+A）：告诉用户去换
      log("shortcut taken", settings.shortcut);
      if (Notification.isSupported()) {
        const note = new Notification({ title: `快捷键 ${showKeys(settings.shortcut)} 被别的软件占了`, body: "点这里换一个（托盘菜单里的“快捷键…”）", icon: ICON });
        note.on("click", openShortcut);
        note.show();
      }
    }
    setupUpdater();
    powerMonitor.on("lock-screen", () => { locked = true; endControl("锁屏了，她先停下了"); });
    powerMonitor.on("unlock-screen", () => { locked = false; });
    if (process.env.ATRI_SMOKE) {  // 冒烟测试用
      global.atriSmoke = {
        setWatching: (on) => setWatching(on, { asked: false }), setVoice, setSpeak, setComputer: (on) => setComputer(on, { asked: false }),
        setShortcut: saveShortcut, openShortcut,
        state: () => ({ watching, voiceOn, speak: settings.speak, shownNotes, computer: settings.computer, controlling: Boolean(control), overlay: Boolean(overlay),
          shortcut: settings.shortcut, shortcutOn, shortcutRegistered: shortcutOn ? globalShortcut.isRegistered(shortcutOn) : false }),
      };
    }
    screen.on("display-removed", () => {
      const size = sizeOf(settings.scale);
      if (pet && !onScreen(pet.getBounds(), size)) pet.setBounds({ ...defaultPosition(size), ...size });
    });
  });
  app.on("window-all-closed", () => {});  // 窗口都关了也留在托盘里
  app.on("will-quit", () => { globalShortcut.unregisterAll(); stopHands(); });
}
