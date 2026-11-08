const { app, BrowserWindow, ipcMain, screen, Notification, shell, Tray, Menu, nativeImage } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

// 独立程序：数据默认放在程序目录下的 data/，可用 STUDY_TIMER_DATA 覆盖
const DATA_DIR = process.env.STUDY_TIMER_DATA || path.join(__dirname, '..', 'data')
const STATE_FILE = path.join(DATA_DIR, 'state.json')
const KEEP_DAYS = 400
const BEAT_MS = 15000

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
  return { version: 3, activeId: null, activeDay: null, days: {}, win: null, collapsed: false }
}

function readState() {
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf8').replace(/^\uFEFF/, '')
    const s = JSON.parse(raw)
    if (s && s.days && typeof s.days === 'object') return s
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
  } catch (err) {
    console.error('[study-timer] write failed:', err)
  }
}

function dayTasks(state, day) {
  if (!state.days[day]) state.days[day] = []
  return state.days[day]
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
  fold(state)
  const day = today()
  const tasks = dayTasks(state, day)
  let t = tasks.find((x) => x.name === trimmed)
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
    }
    tasks.unshift(t)
  }
  if (Number.isFinite(mins) && mins > 0) {
    t.budgetSec = (t.budgetSec || 0) + Math.round(mins * 60)
    t.done = false
  }
  t.ended = false
  t.runningSince = Date.now()
  t.beat = t.runningSince
  state.activeId = t.id
  state.activeDay = day
  return state
}

function toggleTask(state, id) {
  if (state.activeId === id) return fold(state)
  const day = today()
  const tasks = dayTasks(state, day)
  const t = tasks.find((x) => x.id === id)
  if (!t) return state
  if (t.done && t.budgetSec) {
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
  return state
}

/** 提前终止：结算当前这段、标记 ended，时间照常计入累计 */
function endTask(state, id) {
  if (state.activeId === id) fold(state)
  const day = today()
  const t = (state.days[day] || []).find((x) => x.id === id)
  if (!t) return state
  if (t.runningSince) {
    t.seconds = (t.seconds || 0) + Math.max(0, Math.round((Date.now() - t.runningSince) / 1000))
    t.runningSince = null
  }
  t.ended = true
  t.done = false
  if (state.activeId === id) {
    state.activeId = null
    state.activeDay = null
  }
  return state
}

function removeTask(state, id) {
  if (state.activeId === id) fold(state)
  const day = today()
  state.days[day] = (state.days[day] || []).filter((x) => x.id !== id)
  return state
}

function notifyDone(name, budgetSec) {
  const mins = Math.max(1, Math.round(budgetSec / 60))
  try {
    shell.beep()
    new Notification({
      title: '时间到',
      body: `${name} · ${mins} 分钟结束，休息一下吧`,
      silent: false,
    }).show()
  } catch {
    /* 通知不可用，声音已经响过 */
  }
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
      s.activeId = null
      s.activeDay = null
      writeState(s)
      notifyDone(t.name, t.budgetSec)
      if (win && !win.isDestroyed()) win.webContents.send('state:update', s)
    }
  }, 1000)
}

ipcMain.handle('app:get', () => readState())

ipcMain.handle('task:start', (_e, name, minutes) => {
  const s = startTask(readState(), name, minutes)
  writeState(s)
  return s
})

ipcMain.handle('task:toggle', (_e, id) => {
  const s = toggleTask(readState(), id)
  writeState(s)
  return s
})

ipcMain.handle('task:remove', (_e, id) => {
  const s = removeTask(readState(), id)
  writeState(s)
  return s
})

ipcMain.handle('task:end', (_e, id) => {
  const s = endTask(readState(), id)
  writeState(s)
  return s
})

ipcMain.handle('app:quit', () => {
  quitting = true
  writeState(fold(readState()))
  app.quit()
  return true
})

ipcMain.on('win:hide', () => hideWindow())

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
    createWindow()
    createTray()
  })
}

app.on('window-all-closed', () => {
  if (quitting) app.quit()
})