// ============================================================
// TraderRewind — 主进程入口
// ============================================================

import { app, BrowserWindow, ipcMain, Menu, shell } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import { registerDbHandlers } from './ipc/db-handlers'
import { registerFileHandlers } from './ipc/file-handlers'
import { registerWindowHandlers } from './ipc/window-handlers'
import { registerDataHandlers } from './ipc/data-handlers'
import { registerSettingsHandlers } from './ipc/settings-handlers'
import { registerUpdateHandlers } from './ipc/update-handlers'
import { scheduleStartupCheck } from './services/updater'
import { initDatabases, closeDatabases } from './db/connection'
import { sharedCtraderClient } from './services/ctrader-mcp'

// 使用独立的用户数据目录，避免与其它同名程序共用 AppData 造成表结构冲突
// TR_USER_DATA 仅供开发期自动化使用：把整个 userData 指到别处，测试就不会碰到真实数据
app.setPath(
  'userData',
  process.env.TR_USER_DATA || join(app.getPath('appData'), 'TraderRewindDesktop')
)

let mainWindow: BrowserWindow | null = null

// 仅当显式设置 TR_DEBUG_PORT 时开启 CDP，便于调试渲染进程
if (process.env.TR_DEBUG_PORT) {
  app.commandLine.appendSwitch('remote-debugging-port', process.env.TR_DEBUG_PORT)
  /**
   * 窗口被别的窗口挡住时，Chromium 的原生遮挡计算会把渲染停掉，
   * 于是 CDP 的 Page.captureScreenshot 一直拿不到帧、直接超时。
   * 关掉这项计算，窗口即使在后台也保持绘制 —— 自动化截图/巡检才跑得通。
   * 只在开了调试端口时才生效，正常启动不受影响。
   */
  app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#0b0b0b',
    /**
     * 标题栏融进界面：Windows 原生那条白色标题栏跟深色 UI 完全不搭。
     * 这里把它藏掉，只保留系统绘制的三个窗口按钮（最小化/最大化/关闭），
     * 并让它们用界面的深色底 —— 这样既没有白条，又不用自己实现按钮，
     * 顺带保住 Windows 的贴边分屏（悬停最大化键弹出布局选择）和键盘行为。
     *
     * height 必须和渲染进程里 .title-bar 的高度一致，否则按钮会压到内容。
     */
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#111111',
      symbolColor: '#a3a3a3',
      height: 36
    },
    /**
     * 开发时窗口标题栏 / 任务栏会退回到 Electron 的默认图标，很难看。
     * 打包后图标来自 exe 本身（build/icon.ico），所以只在 dev 这里兜一下。
     */
    ...(is.dev ? { icon: join(__dirname, '../../resources/icon.png') } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // 开发期把渲染进程错误打到终端，便于排查
  if (is.dev) {
    mainWindow.webContents.on('console-message' as any, (...args: any[]) => {
      const detail = args[1]
      if (detail && typeof detail === 'object') {
        if ((detail.level ?? 0) >= 2) {
          console.log('[renderer]', detail.message)
        }
      }
    })
    mainWindow.webContents.on('did-fail-load', (_e, code, desc) => {
      console.error('[renderer] did-fail-load', code, desc)
    })

    /**
     * 菜单被整个去掉了，默认的「重新加载 / 开发者工具」菜单项也就没了，
     * 这里把这两个开发常用快捷键补回来。
     */
    mainWindow.webContents.on('before-input-event', (_e, input) => {
      if (input.type !== 'keyDown') return
      const ctrl = input.control || input.meta
      const key = input.key.toLowerCase()
      if (input.key === 'F12' || (ctrl && input.shift && key === 'i')) {
        mainWindow?.webContents.toggleDevTools()
      } else if (ctrl && !input.shift && key === 'r') {
        mainWindow?.webContents.reload()
      }
    })
  }

  // 开发环境加载 Vite 服务器，生产环境加载打包后的文件
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// 单实例锁
const gotTheLock = app.requestSingleInstanceLock()
if (!gotTheLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  app.whenReady().then(() => {
    /**
     * 标题栏藏起来之后，按 Alt 会把原生菜单栏拽出来，把整个页面往下顶一截 ——
     * 既然界面自带导航，菜单就没什么用了，直接去掉。
     * 但开发期常用的刷新 / DevTools 快捷键要补回来，否则调试很别扭。
     */
    Menu.setApplicationMenu(null)

    // 初始化数据库（行情库 + 训练库）
    initDatabases()

    // 注册 IPC handlers
    registerDbHandlers()
    registerFileHandlers()
    registerWindowHandlers(() => mainWindow)
    registerDataHandlers()
    registerSettingsHandlers()
    registerUpdateHandlers()

    createWindow()

    /**
     * 开机顺手查一次版本：延迟 8 秒，等首屏、数据库、图表都就绪之后再说。
     * 查到新版会自动开始下载（界面右上角显示进度），下载完停在「可以安装」，
     * 真正安装要点一下——用户手上可能在打单，不能直接把他踢下线。
     */
    scheduleStartupCheck()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    closeDatabases()
    if (process.platform !== 'darwin') app.quit()
  })

  let ctraderReleased = false
  app.on('before-quit', (e) => {
    closeDatabases()
    if (ctraderReleased) return
    // cTrader 的 MCP session 不会自动过期，不显式 DELETE 就会一直占着名额，
    // 攒够上限之后连握手都会被 404 拒绝。有活跃会话时多等一小会儿把 DELETE 发完。
    const client = sharedCtraderClient()
    if (!client.hasSession) return
    e.preventDefault()
    ctraderReleased = true
    void client
      .close()
      .catch(() => undefined)
      .finally(() => app.exit(0))
  })
}
