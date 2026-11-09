const { app, BrowserWindow, ipcMain, screen, Notification, shell, Tray, Menu, nativeImage } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

// 到点提示音由渲染进程播放自己带的 chime.wav，不依赖系统通知音
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')

// 独立程序：数据默认放在程序目录下的 data/，可用 STUDY_TIMER_DATA 覆盖
const DATA_DIR = process.env.STUDY_TIMER_DATA || path.join(__dirname, '..', 'data')
const STATE_FILE = path.join(DATA_DIR, 'state.json')
// 导出给外面的绘图工具用：日期,任务名,秒数（每次写盘同步刷新，不占界面）
const EXPORT_FILE = path.join(DATA_DIR, 'daily.csv')
// 折线图查看器：独立的单文件 HTML，计时器只负责把数据塞进去再打开
const CHART_TEMPLATE = path.join(__dirname, '..', 'tools', 'daily-chart.html')
const CHART_FILE = path.join(DATA_DIR, 'chart.html')
const KEEP_DAYS = 400
const BEAT_MS = 15000
// 学习日翻页：过了零点后，只要有 2 小时没动过，下一段计时就归新的一天
const DAY_ROLL_GAP_MS = 2 * 60 * 60 * 1000

let win = null
let tray = null
let quitting = false
let lastMtime = 0
let recovered = false

function today() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function emptyState() {
  return { version: 4, dayKey: null, lastActiveAt: 0, activeId: null, activeDay: null, days: {}, win: null, collapsed: false }
}

function readState() {
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf8').replace(/^\uFEFF/, '')
    const s = JSON.parse(raw)
    if (s && s.days && typeof s.days === 'object') {
      // v3 → v4：补上「学习日」和最后活动时间
      if (!s.dayKey || !s.lastActiveAt) {
        let mtime = Date.now()
        try {
          mtime = fs.statSync(STATE_FILE).mtimeMs
        } catch {
          /* 文件刚好不在，用当前时间 */
        }
        if (!s.dayKey) {
          // 老数据没有学习日：优先沿用正在跑的任务，其次最近一天
          const keys = Object.keys(s.days).sort()
          s.dayKey = s.activeDay || keys[keys.length - 1] || today()
        }
        if (!s.lastActiveAt) s.lastActiveAt = mtime
      }
      if (s.version !== 4) s.version = 4
      return s
    }
  } catch {
    /* 新文件还没建 */
  }
  return emptyState()
}

function writeState(state) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true })
    const keys = Object.keys(state.days || {}).sort()
    if (keys.length > KEEP_DAYS) {
      for (const k of keys.slice(0, keys.length - KEEP_DAYS)) delete state.days[k]
    }
    const tmp = STATE_FILE + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8')
    fs.renameSync(tmp, STATE_FILE)
    lastMtime = fs.statSync(STATE_FILE).mtimeMs
    writeExport(state)
    writeChart(state)
  } catch (err) {
    console.error('[study-timer] write failed:', err)
  }
}

function csvCell(value) {
  const s = String(value == null ? '' : value)
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/** 只有「收工」或「倒计时走完」的任务才算最终数据，进入导出和图表。
 *  finalized 一旦置位就不再撤销：完成过一次的任务，第二段还在跑时也保留在导出里。 */
function isFinal(t) {
  return t.finalized === true || t.settled === true || t.done === true
}

/** 每次写盘后刷新 daily.csv：date,task,seconds；只读数据，不影响计时 */
function writeExport(state) {
  try {
    const lines = ['\uFEFFdate,task,seconds']
    for (const day of Object.keys(state.days || {}).sort()) {
      for (const t of state.days[day] || []) {
        if (!isFinal(t)) continue
        const sec = Math.round(t.seconds || 0)
        if (sec <= 0) continue
        lines.push(`${day},${csvCell(t.name)},${sec}`)
      }
    }
    const tmp = EXPORT_FILE + '.tmp'
    fs.writeFileSync(tmp, lines.join('\n') + '\n', 'utf8')
    fs.renameSync(tmp, EXPORT_FILE)
  } catch (err) {
    console.error('[study-timer] export failed:', err)
  }
}

/** 折线图用的行数据：只收已收工 / 已完成的任务 */
function buildChartRows(state) {
  const rows = []
  for (const day of Object.keys(state.days || {}).sort()) {
    for (const t of state.days[day] || []) {
      if (!isFinal(t)) continue
      const sec = Math.round(t.seconds || 0)
      if (sec > 0) rows.push({ date: day, task: t.name, seconds: sec })
    }
  }
  return rows
}

/** 折线图文件：每次保存顺手重写 data/chart.html，用户双击就能看，不用任何操作 */
let chartTemplate = null
function writeChart(state) {
  try {
    if (!chartTemplate) chartTemplate = fs.readFileSync(CHART_TEMPLATE, 'utf8')
    const rows = buildChartRows(state)
    const payload = JSON.stringify({ rows, generatedAt: Date.now() }).replace(/</g, '\\u003c')
    const html = chartTemplate.replace('</body>', `<script>window.__STUDY_DATA__ = ${payload};</script>\n</body>`)
    const tmp = CHART_FILE + '.tmp'
    fs.writeFileSync(tmp, html, 'utf8')
    fs.renameSync(tmp, CHART_FILE)
  } catch (err) {
    console.error('[study-timer] chart failed:', err)
  }
}

function dayTasks(state, day) {
  if (!state.days[day]) state.days[day] = []
  return state.days[day]
}

/** 当前学习日：过零点后若已空闲满 2 小时，才翻到新的一天 */
function ensureDay(state) {
  const cal = today()
  if (!state.dayKey) state.dayKey = state.activeDay || cal
  if (cal > state.dayKey) {
    const idle = Date.now() - (state.lastActiveAt || 0)
    if (idle >= DAY_ROLL_GAP_MS) state.dayKey = cal
  }
  return state.dayKey
}

/** 有计时动作就把「最后活动时间」推到当前，翻页判定靠它 */
function touch(state) {
  ensureDay(state)
  state.lastActiveAt = Date.now()
}

/** 按 id 在所有学习日里找任务（正在跑的旧任务也要找得到） */
function findTask(state, id) {
  for (const day of Object.keys(state.days || {})) {
    const t = (state.days[day] || []).find((x) => x.id === id)
    if (t) return { day, task: t }
  }
  return null
}

function activeTask(state) {
  if (!state.activeId || !state.activeDay) return null
  return (state.days[state.activeDay] || []).find((x) => x.id === state.activeId) || null
}

function usedOf(t) {
  return (t.seconds || 0) + (t.runningSince ? Math.max(0, (Date.now() - t.runningSince) / 1000) : 0)
}

function fold(state) {
  const t = activeTask(state)
  if (t && t.runningSince) {
    t.seconds = (t.seconds || 0) + Math.max(0, Math.round((Date.now() - t.runningSince) / 1000))
    t.runningSince = null
  }
  state.activeId = null
  state.activeDay = null
  return state
}

function recoverStale() {
  const s = readState()
  const t = activeTask(s)
  if (!t) return
  if (t.runningSince) {
    const end = Math.min(t.beat || t.runningSince, Date.now())
    t.seconds = (t.seconds || 0) + Math.max(0, Math.round((end - t.runningSince) / 1000))
    t.runningSince = null
    t.beat = null
  }
  s.activeId = null
  s.activeDay = null
  writeState(s)
}

function startTask(state, name, minutes) {
  const trimmed = String(name || '').trim().slice(0, 60)
  if (!trimmed) return state
  const mins = Number(minutes)
  ensureDay(state)
  fold(state)
  const day = state.dayKey
  const tasks = dayTasks(state, day)
  let t = tasks.find((x) => x.name === trimmed)
  if (t && t.settled) {
    state.notice = `「${trimmed}」今天已收工，明天再记`
    return state
  }
  if (!t) {
    t = {
      id: Math.random().toString(36).slice(2, 10),
      name: trimmed,
      seconds: 0,
      runningSince: null,
      beat: null,
      budgetSec: null,
      done: false,
      ended: false,
      settled: false,
    }
    tasks.unshift(t)
  }
  if (Number.isFinite(mins) && mins > 0) {
    if (t.done) t.finalized = true // 老数据没有 finalized，靠 done 补上
    t.budgetSec = (t.budgetSec || 0) + Math.round(mins * 60)
    t.done = false
  }
  t.ended = false
  t.runningSince = Date.now()
  t.beat = t.runningSince
  state.activeId = t.id
  state.activeDay = day
  touch(state)
  return state
}

function toggleTask(state, id) {
  const found = findTask(state, id)
  if (!found) return state
  const { day, task: t } = found
  if (state.activeId === id) {
    fold(state)
    touch(state)
    return state
  }
  if (t.settled) {
    state.notice = `「${t.name}」今天已收工`
    return state
  }
  if (t.done && t.budgetSec) {
    t.finalized = true
    t.seconds = Math.max(0, t.seconds - t.budgetSec)
    t.budgetSec = null
    t.done = false
  }
  fold(state)
  t.ended = false
  t.runningSince = Date.now()
  t.beat = t.runningSince
  state.activeId = id
  state.activeDay = day
  touch(state)
  return state
}

/** 收工：只结算这一条任务，并把它在这个学习日封账，当天不再累计 */
function settleTask(state, id) {
  const found = findTask(state, id)
  if (!found) return state
  const t = found.task
  if (t.runningSince) {
    t.seconds = (t.seconds || 0) + Math.max(0, Math.round((Date.now() - t.runningSince) / 1000))
    t.runningSince = null
    t.beat = null
  }
  t.settled = true
  t.finalized = true
  t.ended = false
  t.done = false
  if (state.activeId === id) {
    state.activeId = null
    state.activeDay = null
  }
  touch(state)
  return state
}

function removeTask(state, id) {
  if (state.activeId === id) fold(state)
  const found = findTask(state, id)
  if (!found) return state
  state.days[found.day] = state.days[found.day].filter((x) => x.id !== id)
  touch(state)
  return state
}

/** 到点提示音：交给渲染进程播 wav；播不出来才退回系统蜂鸣 */
function playDoneChime() {
  if (win && !win.isDestroyed()) {
    try {
      win.webContents.send('sound:done')
      return
    } catch {
      /* 落到 beep */
    }
  }
  try {
    shell.beep()
  } catch {
    /* ignore */
  }
}

function notifyDone(name, budgetSec) {
  const mins = Math.max(1, Math.round(budgetSec / 60))
  try {
    new Notification({
      title: '时间到',
      body: `${name} · ${mins} 分钟结束，休息一下吧`,
      silent: true, // 声音我们自己播，避免和系统提示音叠在一起
    }).show()
  } catch {
    /* 通知不可用，声音照常 */
  }
  playDoneChime()
  if (win && !win.isDestroyed()) {
    win.show()
    win.setAlwaysOnTop(true, 'screen-saver')
    win.flashFrame(true)
  }
}

function showWindow() {
  if (!win || win.isDestroyed()) return
  win.show()
  win.setAlwaysOnTop(true, 'screen-saver')
  win.focus()
}

function hideWindow() {
  if (win && !win.isDestroyed()) win.hide()
}

function createTray() {
  try {
    const iconPath = path.join(__dirname, 'tray.png')
    const image = fs.existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : nativeImage.createEmpty()
    tray = new Tray(image)
    tray.setToolTip('学习计时 · 点一下显示/隐藏')
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: '显示 / 隐藏', click: () => { if (win && win.isVisible()) hideWindow(); else showWindow() } },
      { type: 'separator' },
      {
        label: '退出（结算计时）',
        click: () => {
          quitting = true
          try { writeState(fold(readState())) } catch { /* ignore */ }
          app.quit()
        },
      },
    ]))
    tray.on('click', () => { if (win && win.isVisible()) hideWindow(); else showWindow() })
    tray.on('double-click', showWindow)
  } catch (err) {
    console.error('[study-timer] tray failed:', err)
  }
}

function createWindow() {
  const state = readState()
  const area = screen.getPrimaryDisplay().workArea
  const collapsed = state.collapsed === true
  const width = collapsed ? 142 : 380
  const height = collapsed ? 44 : 300
  const saved = state.win || { x: area.x + area.width - width - 24, y: area.y + 40 }
  const pos = {
    x: Math.max(area.x, Math.min(Math.round(saved.x), area.x + area.width - width)),
    y: Math.max(area.y, Math.min(Math.round(saved.y), area.y + area.height - height)),
  }

  win = new BrowserWindow({
    width,
    height,
    x: pos.x,
    y: pos.y,
    frame: false,
    transparent: true,
    resizable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: false,
    hasShadow: true,
    alwaysOnTop: true,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  })

  win.setAlwaysOnTop(true, 'screen-saver')
  win.loadFile(path.join(__dirname, 'index.html'))

  let moveTimer = null
  win.on('moved', () => {
    clearTimeout(moveTimer)
    moveTimer = setTimeout(() => {
      const b = win.getBounds()
      const s = readState()
      s.win = { x: b.x, y: b.y }
      writeState(s)
    }, 400)
  })

  win.on('closed', () => {
    win = null
  })

  // 点 ✕ / Alt+F4 只隐藏到托盘，不退出
  win.on('close', (e) => {
    if (!quitting) {
      e.preventDefault()
      win.hide()
    }
  })

  setInterval(() => {
    try {
      const st = fs.statSync(STATE_FILE)
      if (st.mtimeMs !== lastMtime) {
        lastMtime = st.mtimeMs
        if (win && !win.isDestroyed()) win.webContents.send('state:update', readState())
      }
    } catch {
      /* ignore */
    }
  }, 600)

  setInterval(() => {
    const s = readState()
    const t = activeTask(s)
    if (!t || !t.runningSince) return
    t.beat = Date.now()
    writeState(s)
  }, BEAT_MS)

  // 倒计时归零：主进程判定，窗口隐藏/被遮挡都不影响
  setInterval(() => {
    const s = readState()
    const t = activeTask(s)
    if (!t || !t.runningSince || !t.budgetSec) return
    if (usedOf(t) >= t.budgetSec) {
      t.seconds = t.budgetSec
      t.runningSince = null
      t.done = true
      t.finalized = true
      s.activeId = null
      s.activeDay = null
      writeState(s)
      notifyDone(t.name, t.budgetSec)
      if (win && !win.isDestroyed()) win.webContents.send('state:update', s)
    }
  }, 1000)
}

/** 把一次性提示（已收工等）带出主进程，但不落盘 */
function respond(state) {
  const notice = state.notice
  delete state.notice
  writeState(state)
  const out = JSON.parse(JSON.stringify(state))
  if (notice) out.notice = notice
  return out
}

ipcMain.handle('app:get', () => {
  const s = readState()
  const before = s.dayKey
  ensureDay(s)
  if (s.dayKey !== before) writeState(s) // 翻页要落盘，否则轮询会把旧的学习日又推回来
  return s
})

ipcMain.handle('task:start', (_e, name, minutes) => respond(startTask(readState(), name, minutes)))

ipcMain.handle('task:toggle', (_e, id) => respond(toggleTask(readState(), id)))

ipcMain.handle('task:remove', (_e, id) => respond(removeTask(readState(), id)))

ipcMain.handle('task:settle', (_e, id) => respond(settleTask(readState(), id)))

ipcMain.handle('app:quit', () => {
  quitting = true
  writeState(fold(readState()))
  app.quit()
  return true
})

ipcMain.on('win:hide', () => hideWindow())

// 渲染进程播不出 wav（文件缺失/音频设备异常）时退回系统蜂鸣，至少能听见
ipcMain.on('sound:failed', () => {
  try {
    shell.beep()
  } catch {
    /* ignore */
  }
})

ipcMain.on('ui:collapse', (_e, collapsed) => {
  const s = readState()
  s.collapsed = collapsed === true
  writeState(s)
})

ipcMain.on('win:shape', (_e, size) => {
  if (!win || win.isDestroyed()) return
  const w = Math.max(120, Math.min(600, Math.round(Number(size && size.w) || 380)))
  const h = Math.max(40, Math.min(640, Math.round(Number(size && size.h) || 300)))
  const before = win.getBounds()
  const [cw, ch] = win.getContentSize()
  if (Math.abs(w - cw) > 2 || Math.abs(h - ch) > 2) {
    // 右边缘保持不动：收起/展开时胶囊留在原地，不往外跳
    win.setContentSize(w, h)
    const after = win.getBounds()
    const right = before.x + before.width
    const area = screen.getDisplayMatching(after).workArea
    let x = right - after.width
    let y = after.y
    if (x < area.x) x = area.x
    if (x + after.width > area.x + area.width) x = area.x + area.width - after.width
    if (y < area.y) y = area.y
    if (y + after.height > area.y + area.height) y = area.y + area.height - after.height
    if (x !== after.x || y !== after.y) win.setPosition(Math.round(x), Math.round(y))
  }
})

// 首次运行 data/ 还不存在；必须在设置 userData 之前建好，
// 否则 Electron 拿不到可用的 userData 目录会直接静默退出。
try {
  fs.mkdirSync(DATA_DIR, { recursive: true })
} catch (err) {
  console.error('[study-timer] cannot create data dir:', err)
}
app.setPath('userData', path.join(DATA_DIR, 'electron'))
app.setAppUserModelId('dsh.study.timer')

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    showWindow()
  })

  app.on('before-quit', () => {
    quitting = true
    try {
      writeState(fold(readState()))
    } catch {
      /* ignore */
    }
  })

  app.whenReady().then(() => {
    fs.mkdirSync(DATA_DIR, { recursive: true })
    if (!recovered) {
      recoverStale()
      recovered = true
    }
    writeExport(readState()) // 启动先把已有的历史导出一份，老数据也能直接画图
    writeChart(readState()) // 同时生成一份带数据的 chart.html，双击就能看折线图
    createWindow()
    createTray()
  })
}

app.on('window-all-closed', () => {
  if (quitting) app.quit()
})