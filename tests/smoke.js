// 冒烟测试：起一个假的 ATRI 服务器，用 Playwright 启动这个应用，确认外壳的几件事都对：
// 读设置、没登录先弹登录窗口、登录后打开透明桌宠窗口、页面拿得到 atriDesktop 拿不到 Node、
// 鼠标位置传得进去、拖动能挪窗口、滚轮能放大缩小、点透开关不报错、去别的网站会被拦下、“看屏幕”默认关着且页面开不了、语音开关、摄像头不给。
// 用法：npm test（要能开窗口：Windows、macOS，或者 Linux 上有 X）
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { _electron: electron } = require("playwright-core");

const PET = `<!doctype html><meta charset="utf-8"><title>桌宠</title>
<body style="background:transparent">
<script>
  window.cursorCount = 0; window.commands = []; window.watching = null;
  window.atriDesktop.onWatching((on) => { window.watching = on; });
  window.atriDesktop.onCursor(() => { window.cursorCount++; });
  window.atriDesktop.onCommand((command) => window.commands.push(command));
  window.atriDesktop.ready({ models: [{ name: "Test", title: "测试形象" }], model: "Test" });
  window.atriDesktop.setIgnoreMouse(true);
  window.atriDesktop.setIgnoreMouse(false);
</script></body>`;
const LOGIN = `<!doctype html><meta charset="utf-8"><title>登录</title>
<button id="login" onclick="document.cookie='ok=1; path=/'; location.href='/atri/pet'">登录</button>`;

function startServer() {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, "http://localhost");
    if (url.pathname === "/atri/login") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return response.end(request.method === "HEAD" ? undefined : LOGIN);
    }
    if (url.pathname === "/atri/pet") {
      if (!/(^|;\s*)ok=1/.test(request.headers.cookie || "")) {
        response.writeHead(302, { Location: "/atri/login?next=/atri/pet" });
        return response.end();
      }
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return response.end(PET);
    }
    response.writeHead(404);
    response.end();
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

async function waitFor(check, what, timeout = 20000) {
  const start = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - start > timeout) throw new Error(`等不到：${what}`);
    await new Promise((done) => setTimeout(done, 200));
  }
}

(async () => {
  const server = await startServer();
  const address = `http://127.0.0.1:${server.address().port}`;
  // 用户目录放到临时目录（ATRI_USER_DATA），里面先写好服务器地址
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "atri-smoke-"));
  fs.writeFileSync(path.join(home, "settings.json"), JSON.stringify({ server: address, size: "medium" }));  // 旧版本存的 size 也认
  const app = await electron.launch({ args: [path.join(__dirname, "..")], env: { ...process.env, ATRI_USER_DATA: home, ATRI_SMOKE: "1" } });
  const windows = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((win) => ({
    id: win.id, url: win.webContents.getURL(), visible: win.isVisible(), bounds: win.getBounds(), onTop: win.isAlwaysOnTop(),
  })));
  try {
    // 1. 没登录：桌宠页被转到登录页，弹出登录窗口
    const login = await waitFor(async () => (await windows()).find((win) => win.url.includes("/atri/login") && win.visible), "登录窗口");
    console.log("登录窗口：", login.url);
    // 没登录时隐藏的桌宠窗口里也停着登录页：找看得见的那个
    const loginPage = await waitFor(async () => {
      for (const page of app.windows()) {
        if (!page.isClosed() && page.url().includes("/atri/login") && await (await app.browserWindow(page)).evaluate((win) => win.isVisible())) return page;
      }
      return null;
    }, "登录页");
    await loginPage.click("#login");

    // 2. 登录后：登录窗口关掉，透明桌宠窗口重新打开桌宠页
    await waitFor(() => loginPage.isClosed(), "登录窗口关掉");
    const pet = await waitFor(() => app.windows().find((page) => !page.isClosed() && page.url().endsWith("/atri/pet")), "桌宠页");
    const petWindow = (await windows()).find((win) => win.url.endsWith("/atri/pet"));
    await waitFor(async () => (await windows()).find((win) => win.url.endsWith("/atri/pet"))?.visible, "桌宠窗口显示出来");
    assert.equal(petWindow.bounds.width, 252);  // 旧设置里的“中”（1 倍）缩到 0.7 倍
    assert.equal(petWindow.onTop, true);
    console.log("桌宠窗口：", JSON.stringify(petWindow.bounds));

    // 3. 页面只拿到 atriDesktop，没有 Node
    assert.deepEqual(await pet.evaluate(() => [typeof window.atriDesktop, typeof window.require, typeof window.process]), ["object", "undefined", "undefined"]);

    // 4. 鼠标位置一直在送进来
    await waitFor(() => pet.evaluate(() => window.cursorCount > 5), "鼠标位置");

    // 5. 拖她：窗口跟着挪
    await pet.evaluate(() => window.atriDesktop.dragBy(-40, -30));
    await pet.evaluate(() => window.atriDesktop.dragEnd());
    const moved = await waitFor(async () => {
      const now = (await windows()).find((win) => win.url.endsWith("/atri/pet"));
      return now.bounds.x === petWindow.bounds.x - 40 && now.bounds.y === petWindow.bounds.y - 30 && now;
    }, "窗口挪动");
    console.log("拖动后：", JSON.stringify(moved.bounds));
    const saved = JSON.parse(fs.readFileSync(path.join(home, "settings.json"), "utf8"));
    assert.deepEqual(saved.position, { x: moved.bounds.x, y: moved.bounds.y });

    // 5b. 滚轮放大：宽高按比例变大，脚底不动、左右居中；存进设置。按住拖（dragStart / dragEnd）不出错、窗口大小不变
    const before = (await windows()).find((win) => win.url.endsWith("/atri/pet")).bounds;
    await pet.evaluate(() => window.atriDesktop.zoom(1));
    const bigger = await waitFor(async () => {
      const now = (await windows()).find((win) => win.url.endsWith("/atri/pet")).bounds;
      return now.width > before.width && now;
    }, "放大");
    assert.equal(bigger.width, Math.round(360 * 0.7 * 1.08));
    assert.equal(bigger.y + bigger.height, before.y + before.height);
    assert.ok(Math.abs((bigger.x + bigger.width / 2) - (before.x + before.width / 2)) <= 1);
    assert.ok(Math.abs(JSON.parse(fs.readFileSync(path.join(home, "settings.json"), "utf8")).scale - 0.7 * 1.08) < 1e-9);
    await pet.evaluate(() => window.atriDesktop.zoom(-1));
    await waitFor(async () => (await windows()).find((win) => win.url.endsWith("/atri/pet")).bounds.width === 252, "缩回去");
    await pet.evaluate(() => window.atriDesktop.dragStart());
    await new Promise((done) => setTimeout(done, 200));
    await pet.evaluate(() => window.atriDesktop.dragEnd());
    const dragged = (await windows()).find((win) => win.url.endsWith("/atri/pet")).bounds;
    assert.equal(dragged.width, 252);
    assert.equal(dragged.height, 420);
    console.log("缩放、拖动：", JSON.stringify(bigger), JSON.stringify(dragged));

    // 6. 去别的网站：拦下，还在桌宠页
    await pet.evaluate(() => { location.href = "https://example.com/"; }).catch(() => {});
    await new Promise((done) => setTimeout(done, 1500));
    assert.ok(pet.url().endsWith("/atri/pet"), `不该离开桌宠页：${pet.url()}`);

    // 7. 托盘命令能送到页面（换形象）
    await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows().find((each) => each.webContents.getURL().endsWith("/atri/pet"));
      win.webContents.send("atri:command", "model:Test");
    });
    await waitFor(() => pet.evaluate(() => window.commands.includes("model:Test")), "托盘命令");

    // 8. 看屏幕：默认关着，页面截不到；用户在菜单里打开后截得到 JPEG，页面知道在看；页面能关、关了又截不到
    const tryShot = () => pet.evaluate(() => window.atriDesktop.captureScreen().then(
      (jpeg) => ({ size: jpeg.length, head: [jpeg[0], jpeg[1]] }), (error) => ({ error: String(error.message || error) })));
    assert.ok((await tryShot()).error, "没打开就不该截得到屏幕");
    assert.equal(await pet.evaluate(() => typeof window.atriDesktop.stopWatching), "function");
    assert.equal(await pet.evaluate(() => typeof window.atriDesktop.startWatching), "undefined");  // 页面开不了
    assert.equal(typeof await pet.evaluate(() => window.atriDesktop.idleSeconds()), "number");
    await app.evaluate(() => global.atriSmoke.setWatching(true));
    await waitFor(() => pet.evaluate(() => window.watching === true), "页面知道在看屏幕");
    const shot = await tryShot();
    console.log("截图：", JSON.stringify(shot));
    assert.ok(shot.size > 1000 && shot.head[0] === 0xff && shot.head[1] === 0xd8, `截图不对：${JSON.stringify(shot)}`);
    await pet.evaluate(() => window.atriDesktop.stopWatching());
    await waitFor(() => pet.evaluate(() => window.watching === false), "页面知道不看了");
    assert.ok((await tryShot()).error, "关了就不该截得到屏幕");

    // 9. 语音：菜单开“语音对话”页面收到 voice:on，页面点“在听”关掉后菜单跟着关；“念出她的话”默认开，关了存进设置
    await app.evaluate(() => global.atriSmoke.setVoice(true));
    await waitFor(() => pet.evaluate(() => window.commands.includes("voice:on")), "页面收到 voice:on");
    await pet.evaluate(() => window.atriDesktop.voiceOff());
    await waitFor(async () => !(await app.evaluate(() => global.atriSmoke.state())).voiceOn, "菜单里的语音对话关掉");
    assert.equal((await app.evaluate(() => global.atriSmoke.state())).speak, true);
    await app.evaluate(() => global.atriSmoke.setSpeak(false));
    await waitFor(() => pet.evaluate(() => window.commands.includes("speak:off")), "页面收到 speak:off");
    assert.equal(JSON.parse(fs.readFileSync(path.join(home, "settings.json"), "utf8")).speak, false);
    // 10. 系统通知：她在桌面上时不弹（气泡就够了），藏起来才弹
    await pet.evaluate(() => window.atriDesktop.notify("ATRI 提醒你", "喝水"));
    await new Promise((done) => setTimeout(done, 300));
    assert.equal((await app.evaluate(() => global.atriSmoke.state())).shownNotes, 0);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((win) => win.webContents.getURL().endsWith("/atri/pet")).hide());
    await pet.evaluate(() => window.atriDesktop.notify("ATRI 提醒你", "喝水"));
    await waitFor(async () => (await app.evaluate(() => global.atriSmoke.state())).shownNotes === 1, "藏起来时弹通知");
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((win) => win.webContents.getURL().endsWith("/atri/pet")).showInactive());
    // 摄像头不给；麦克风只给服务器的页面（这台机器没有麦克风时会说找不到设备，但不是被拒）
    const camera = await pet.evaluate(() => navigator.mediaDevices.getUserMedia({ video: true }).then(() => "ok", (error) => error.name));
    console.log("要摄像头：", camera);
    assert.notEqual(camera, "ok");
    console.log("冒烟测试通过");
  } finally {
    await app.close().catch(() => {});
    server.close();
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
