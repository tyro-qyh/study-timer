# 学习计时 · Study Timer

一个常驻桌面的极简学习计时器：**输入任务名回车就开始计时**，可以给任务设分钟数倒计时，到点提醒；所有任务按名字跨天累计学习时长。

Windows 桌面小工具，Electron 实现，零依赖、数据全本地、不联网。

![今天](screenshots/01-today.png)
![累计](screenshots/02-total.png)

---

## 功能

- **两种计时**：只填任务名 = 正计时；再填分钟数（如 `30`）= 从 30 分钟倒数。
- **到点提醒**：倒计时归零时系统提示音 + Windows 通知，窗口自动提到最前。窗口被遮挡、最小化都不影响。
- **按任务累计**：底部「累计」页按任务名合并所有天数，显示总时长、记了几天、今天多少。中途暂停、提前终止都照常计入。
- **提前终止**：悬停任务行点「终止」，已用时间保留，只是不再倒计时。
- **收起成胶囊**：点标题栏的 `—` 缩成一颗 142×44 的小胶囊，只显示一个数字（倒计时剩余 / 正计时已用 / 今日合计），点一下展开。
- **隐藏到托盘**：点 `✕` 只是隐藏，计时继续；托盘左键显示/隐藏，右键「退出（结算计时）」。
- **窗口贴边置顶**：无边框、可拖动、位置记住，换分辨率会自动夹回屏幕内。
- **数据可读可迁**：`data/state.json` 是纯 JSON，整个文件夹拷走就能换机器。

## 安装（Windows）

1. 下载本仓库：右上角 **Code → Download ZIP**，解压到任意目录（建议 `D:\SOFTWARE\study-timer`）。
2. 在该目录里**右键 `install.ps1` → 使用 PowerShell 运行**。
   或者在 PowerShell 里执行：

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
   ```

3. 脚本会在首次运行时下载 Electron 运行时（约 137 MB，解压后约 350 MB），然后创建桌面快捷方式「学习计时」。

之后双击桌面图标即可。安装脚本不做任何系统级改动，不写注册表、不开机自启。

### 手动运行

```powershell
runtime\electron.exe app
```

## 使用

| 想干什么 | 怎么做 |
| --- | --- |
| 开始正计时 | 任务名 → 回车（分钟留空） |
| 开始倒计时 | 任务名 + `30` → 回车 |
| 暂停 / 继续 | 点这一行 |
| 提前终止 | 悬停这一行 → 点「终止」（时间保留） |
| 删除当天记录 | 悬停 → 点 `✕` → 再点一次「确认删除」（会丢当天分钟） |
| 收起成胶囊 | 标题栏 `—`；点胶囊展开 |
| 暂时隐藏 | 标题栏 `✕` 或 `Alt+F4` |
| 彻底退出 | 托盘图标右键 →「退出（结算计时）」 |

计时精度：暂停/退出时精确到秒；进程被强杀时靠 15 秒心跳兜底，最多丢最后 15 秒。跨零点继续跑会记在开始那天。

## 数据与隐私

- 数据位置：`data/state.json`（相对程序目录），纯 JSON，可直接读改、可进 git、可迁移。
- 不联网、不上传、无遥测、无账号。
- 历史保留最近 400 天，超出的最旧日期自动裁剪。
- 累计按**任务名**合并：改名会被当成新任务。

## 已知限制

- 仅 Windows（脚本用 PowerShell + .lnk 快捷方式；应用本身跨平台，改一下启动方式即可）。
- 运行时体积较大（Electron 约 350 MB），这是"不用装浏览器/不用开 IDE 就能跑"的代价。
- 没有云端同步、没有多设备、没有报表导出——这是刻意的，保持一件事做好。

## 结构

```
study-timer/
├─ app/              应用本体
│  ├─ main.js        主进程：窗口、托盘、计时状态机、通知
│  ├─ preload.js     contextBridge 暴露的最小 IPC
│  ├─ index.html     界面（无框架，原生 DOM）
│  ├─ package.json
│  └─ tray.png       托盘图标
├─ install.ps1       Windows 一键安装
├─ screenshots/
└─ data/             运行后生成（不纳入版本库）
```

## English

A minimal always-on-top study timer for Windows. Type a task name and hit Enter to count up; add minutes (e.g. `30`) to count down with a notification at zero. Totals are aggregated per task name across days. Data lives in `data/state.json` — local, plain JSON, no network, no telemetry.

Install: download the ZIP, run `install.ps1` in PowerShell (it fetches the Electron runtime on first run), then launch from the desktop shortcut.

## License

MIT