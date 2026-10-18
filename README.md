# ATRI 桌面端

ATRI 的桌宠：她站在你的桌面上，点一下会有反应，双击就能和她说话，到点的提醒她会说出来。

这只是个外壳（Electron）。聊天、记忆、形象模型都在你自己的 ATRI 服务器上，这里不存任何密钥，也不带模型文件：
应用打开服务器上的桌宠页（`/atri/pet`），放进一个透明、没边框、总在最前的小窗口。

## 安装

在 [Releases](https://github.com/YuxiangLin-kaslana/atri-desktop/releases) 下载 `ATRI-Setup-x.y.z.exe`，双击安装（只支持 Windows）。
安装包没有代码签名，第一次运行时 Windows 可能提示“已保护你的电脑”，点“更多信息”→“仍要运行”。

第一次打开会让你登录一次（和网页版同一个账号）。默认连 https://atri.yuxianglin.xyz；要连别的 ATRI 服务器，在托盘菜单“服务器地址…”里改。

## 怎么用

- 按住她拖动，可以把她挪到屏幕任何地方；她身边透明的地方点得到后面的窗口。
- 点她一下她会有反应；双击她，或者按 `Ctrl+Alt+A`，下面会出来输入框，说完按回车。
- 她的回答出现在头顶的气泡里；太长或者做了文件，点“在聊天窗口看全文”。
- 右键她或者点托盘图标：打开聊天窗口、调大小、换形象、总在最前、开机启动、服务器地址、检查更新、退出。

## 更新

应用启动时和每隔 4 小时检查一次这个仓库的 Release，有新版就在后台下载，退出时自动装上（托盘菜单里也可以马上重启更新）。

## 开发和发布

```bash
npm install
npm start              # 本地运行
npm run dist           # 在 Windows 上打安装包到 dist/
```

发布：改 `package.json` 里的版本号，提交，推一个同名标签（比如 `git tag v0.1.1 && git push origin v0.1.1`）。
GitHub Actions 会在 Windows 机器上打包，并发到 Release。
