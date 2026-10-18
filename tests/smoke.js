// 冒烟测试：起一个假的 ATRI 服务器，用 Playwright 启动这个应用，确认外壳的几件事都对：
// 读设置、没登录先弹登录窗口、登录后打开透明桌宠窗口、页面拿得到 atriDesktop 拿不到 Node、
// 鼠标位置传得进去、拖动能挪窗口、点透开关不报错、去别的网站会被拦下。
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
  window.cursorCount = 0; window.commands = [];
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
  fs.writeFileSync(path.join(home, "settings.json"), JSON.stringify({ server: address, size: "medium" }));
  const app = await electron.launch({ args: [path.join(__dirname, "..")], env: { ...process.env, ATRI_USER_DATA: home } });
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
    assert.equal(petWindow.bounds.width, 360);
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
    console.log("冒烟测试通过");
  } finally {
    await app.close().catch(() => {});
    server.close();
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
