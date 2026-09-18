import { app, shell, BrowserWindow } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { registerIpcHandlers } from './ipc'
import { closeDb } from './db'
import { runDbSmokeTest } from './smoke'
import icon from '../../resources/icon.png?asset'

function createWindow(): void {
  // Create the browser window.
  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 940,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    title: 'Wanderlust',
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // Dev-only end-to-end check: once the page is up, exercise `window.api`
  // from inside the real renderer and print the results, then quit.
  mainWindow.webContents.once('did-finish-load', () => {
    void (async () => {
      if (process.env['WANDERLUST_E2E'] !== '1') return
      try {
        const summary = await mainWindow.webContents.executeJavaScript(
          'window.api.getCacheSummary()'
        )
        const download = await mainWindow.webContents.executeJavaScript(
          "window.api.downloadData({ symbol: 'eurusd', timeframe: 'm1', startDate: '2024-01-02', endDate: '2024-01-03' })"
        )
        const dom = await mainWindow.webContents.executeJavaScript(`({
          title: document.querySelector('h1')?.textContent ?? null,
          buttons: [...document.querySelectorAll('button')].map((b) => b.textContent?.trim()),
          hasProgressPanel: document.body.textContent.includes('Download progress events'),
          hasCachePanel: document.body.textContent.includes('SQLite cache contents'),
          buttonStyle: document.querySelector('button')?.className.slice(0, 80) ?? null
        })`)
        const image = await mainWindow.webContents.capturePage()
        const { writeFileSync } = await import('fs')
        writeFileSync('/tmp/opencode/wanderlust-ui.png', image.toPNG())
        console.log('[e2e] cacheSummary =', JSON.stringify(summary))
        console.log('[e2e] downloadData  =', JSON.stringify(download))
        console.log('[e2e] dom           =', JSON.stringify(dom))
        console.log('[e2e] screenshot written to /tmp/opencode/wanderlust-ui.png')
      } catch (err) {
        console.error('[e2e] FAILED', err)
      } finally {
        app.exit(0)
      }
    })()
  })

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(() => {
  // Set app user model id for windows
  electronApp.setAppUserModelId('com.wanderlust.app')

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // Dev-only SQLite smoke test: WANDERLUST_SMOKE=1 npm run dev
  if (process.env['WANDERLUST_SMOKE'] === '1') {
    void runDbSmokeTest()
      .then((line) => {
        console.log('[smoke]', line)
        app.exit(0)
      })
      .catch((err) => {
        console.error('[smoke] FAILED', err)
        app.exit(1)
      })
    return
  }

  registerIpcHandlers()

  createWindow()

  app.on('activate', function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('will-quit', () => {
  closeDb()
})

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
