// ATRI 桌宠的主进程。它只是个外壳：把 ATRI 服务器（默认 DEFAULT_SERVER）上的桌宠页（/atri/pet）放进一个透明、没边框、总在最前的小窗口，
// 再管点透、拖动、托盘菜单、开机启动和自动更新。聊天、记忆、形象模型都在服务器上，这里不存任何密钥。
// “让她看屏幕”默认关着，只有用户在托盘或右键菜单里打开才截图（每次启动都是关的）；她只能看，没有操作键盘鼠标的能力。
const { app, BrowserWindow, Menu, Tray, desktopCapturer, dialog, globalShortcut, ipcMain, nativeImage, net, powerMonitor, screen, shell } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { autoUpdater } = require("electron-updater");

const PARTITION = "persist:atri";  // 桌宠、聊天、登录窗口共用一份 cookie（登录一次就行）
const SIZES = { small: { label: "小", width: 280, height: 470 }, medium: { label: "中", width: 360, height: 600 }, large: { label: "大", width: 460, height: 770 } };
const SHORTCUT = "Control+Alt+A";  // 叫她出来说话
const ICON = path.join(__dirname, "assets", "icon.png");
const DEFAULT_SERVER = "https://atri.yuxianglin.xyz";  // 默认连这个；要连别的服务器在托盘菜单“服务器地址…”里改
const DEFAULTS = { server: DEFAULT_SERVER, size: "medium", position: null, alwaysOnTop: true, model: null, watchAgreed: false };
const SHOT_WIDTH = 1280;  // 截图缩到这么宽再给页面（够她看清，传得也快）

let settings = { ...DEFAULTS };
let pet = null, chat = null, login = null, setup = null, tray = null;
let models = [], updateReady = null, cursorTimer = null;
let watching = false, locked = false;  // 让她看屏幕（不存进设置，每次启动都是关的）；锁屏时不截

// ---- 设置：存在用户目录的 settings.json ----
const settingsFile = () => path.join(app.getPath("userData"), "settings.json");
function loadSettings() {
  try { settings = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(settingsFile(), "utf8")) }; } catch { settings = { ...DEFAULTS }; }
  if (!SIZES[settings.size]) settings.size = "medium";
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
  const size = SIZES[settings.size];
  const position = settings.position && onScreen(settings.position, size) ? settings.position : defaultPosition(size);
  pet = new BrowserWindow({
    width: size.width, height: size.height, x: position.x, y: position.y,
    transparent: true, frame: false, resizable: false, maximizable: false, fullscreenable: false, hasShadow: false,
    skipTaskbar: true, alwaysOnTop: settings.alwaysOnTop, show: false, backgroundColor: "#00000000", title: "ATRI", icon: ICON,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"), partition: PARTITION,
      contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false,
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
  pet.on("hide", () => { refreshTray(); if (watching) setWatching(false); });  // 藏起来就看不到“在看屏幕”的标记了：一起关掉
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
function resizePet(size) {
  settings.size = size;
  saveSettings();
  if (!pet) return;
  const box = pet.getBounds(), next = SIZES[size];
  // 脚底不动：往上长、往左右两边长
  pet.setBounds({ x: Math.round(box.x + (box.width - next.width) / 2), y: box.y + box.height - next.height, width: next.width, height: next.height });
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

// ---- 页面发来的请求：只认桌宠窗口里、服务器那个来源的页面 ----
const fromPet = (event) => pet && event.sender === pet.webContents && sameOrigin(event.senderFrame?.url || "");
ipcMain.on("atri:ignore", (event, ignore) => { if (fromPet(event)) pet.setIgnoreMouseEvents(Boolean(ignore), { forward: true }); });
ipcMain.on("atri:drag", (event, dx, dy) => {
  if (!fromPet(event)) return;
  const box = pet.getBounds();
  pet.setPosition(Math.round(box.x + (Number(dx) || 0)), Math.round(box.y + (Number(dy) || 0)));
});
ipcMain.on("atri:dragEnd", (event) => { if (fromPet(event)) rememberPosition(); });
ipcMain.on("atri:chat", (event) => { if (fromPet(event)) openChat(); });
ipcMain.on("atri:menu", (event) => { if (fromPet(event)) Menu.buildFromTemplate(menuItems()).popup({ window: pet }); });
ipcMain.on("atri:ready", (event, info) => {
  if (!fromPet(event)) return;
  models = Array.isArray(info?.models) ? info.models.filter((m) => m && typeof m.name === "string").slice(0, 20) : [];
  settings.model = typeof info?.model === "string" ? info.model : settings.model;
  refreshTray();
  if (updateReady) pet.webContents.send("atri:command", `say:新版本 ${updateReady} 已经下好了，退出时会自动装上。`);
  pet.webContents.send("atri:watching", watching);  // 页面重新加载过：告诉它现在看没看
});
ipcMain.handle("atri:capture", (event) => {
  if (!fromPet(event)) throw new Error("不认识的请求");
  return captureScreen();
});
ipcMain.on("atri:stopWatching", (event) => { if (fromPet(event)) setWatching(false); });  // 页面只能关，不能开
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

// ---- 托盘和右键菜单 ----
function menuItems() {
  const items = [
    { label: "和她说话", accelerator: SHORTCUT, click: talk },
    { label: "打开聊天窗口", click: openChat },
    { label: "让她看屏幕", type: "checkbox", checked: watching, click: (item) => setWatching(item.checked) },
    { type: "separator" },
    { label: "大小", submenu: Object.entries(SIZES).map(([key, size]) => ({ label: size.label, type: "radio", checked: settings.size === key, click: () => resizePet(key) })) },
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
    createTray();
    if (settings.server) createPet(); else openSetup();
    if (!globalShortcut.register(SHORTCUT, talk)) log("shortcut taken", SHORTCUT);
    setupUpdater();
    powerMonitor.on("lock-screen", () => { locked = true; });
    powerMonitor.on("unlock-screen", () => { locked = false; });
    if (process.env.ATRI_SMOKE) global.atriSmoke = { setWatching: (on) => setWatching(on, { asked: false }) };  // 冒烟测试用
    screen.on("display-removed", () => { if (pet && !onScreen(pet.getBounds(), SIZES[settings.size])) pet.setPosition(defaultPosition(SIZES[settings.size]).x, defaultPosition(SIZES[settings.size]).y); });
  });
  app.on("window-all-closed", () => {});  // 窗口都关了也留在托盘里
  app.on("will-quit", () => globalShortcut.unregisterAll());
}
