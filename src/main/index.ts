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
  // from inside the real renderer AND drive the Phase 3 UI (New Session modal
  // → download → Vela chart), print the results, then quit.
  mainWindow.webContents.once('did-finish-load', () => {
    void (async () => {
      if (process.env['WANDERLUST_E2E'] !== '1') return
      try {
        // Collect renderer console output so page-level errors/warnings are
        // visible in the E2E log (canvas pixels prove the chart painted).
        const consoleLogs: string[] = []
        const onConsole = (...args: unknown[]): void => {
          const tail = args.filter((a) => a !== undefined && a !== null).join(' ')
          if (tail.trim()) consoleLogs.push(tail.slice(0, 300))
        }
        mainWindow.webContents.on('console-message', onConsole)
        const js = <T>(code: string): Promise<T> =>
          mainWindow.webContents.executeJavaScript(code) as Promise<T>
        const shot = async (file: string): Promise<void> => {
          const image = await mainWindow.webContents.capturePage()
          const { writeFileSync } = await import('fs')
          writeFileSync(file, image.toPNG())
        }

        // ---- 1. UI shell: header, empty state, session button ----
        const shellDom = await js(`({
          title: document.querySelector('h1')?.textContent ?? null,
          phaseBadge: document.body.textContent.includes('sessions & chart'),
          hasEmptyState: document.body.textContent.includes('No session yet'),
          hasNewSessionBtn: [...document.querySelectorAll('button')].some((b) =>
            b.textContent?.includes('New Session')
          )
        })`)
        await shot('/tmp/opencode/wanderlust-1-empty.png')

        // ---- 2. Data pipeline (window.api, as before) ----
        const range = {
          symbol: 'eurusd',
          timeframe: 'm1',
          startDate: '2024-01-02',
          endDate: '2024-01-04'
        }
        const download1 = await js(`window.api.downloadData(${JSON.stringify(range)})`)
        await js('new Promise(r => setTimeout(r, 250))') // let progress events flush
        const readback = await js<{ ok: boolean; count: number }>(
          `window.api.getCachedData(${JSON.stringify(range)})`
        )
        const summary1 = await js('window.api.getCacheSummary()')
        const download2 = await js(`window.api.downloadData(${JSON.stringify(range)})`)

        // ---- 3. UI journey: modal → download → Vela chart ----
        // Dates 2024-01-02..03 are cached by download#1 above, so the session
        // download resolves instantly (cache hit) and the chart mounts fast.
        const ui = await js(`(async () => {
          const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
          const btn = (txt) =>
            [...document.querySelectorAll('button')].find((b) => b.textContent?.includes(txt));
          const setVal = (el, v) => {
            const proto =
              el.tagName === 'SELECT'
                ? window.HTMLSelectElement.prototype
                : window.HTMLInputElement.prototype;
            Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
            el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
          };
          const from = document.querySelector('#ns-date-from');
          const to = document.querySelector('#ns-date-to');
          const diag = () => ({
            text: document.body.textContent.slice(0, 300),
            ids: [...document.querySelectorAll('[id]')].map((el) => el.id),
            buttons: [...document.querySelectorAll('button')].map((b) => b.textContent?.trim())
          });
          if (!btn('New Session')) return { ok: false, step: 'no-open-button', diag: diag() };
          btn('New Session').click();
          await sleep(300);
          const from2 = document.querySelector('#ns-date-from');
          const to2 = document.querySelector('#ns-date-to');
          if (!from2 || !to2) return { ok: false, step: 'modal-fields-missing', diag: diag() };
          setVal(from2, '2024-01-02');
          setVal(to2, '2024-01-03');
          await sleep(200);
          const start = btn('Start Session');
          if (!start || start.disabled) return { ok: false, step: 'start-disabled' };
          start.click();
          for (let i = 0; i < 40; i++) {
            const canvases = document.querySelectorAll('canvas').length;
            if (canvases > 0) {
              // Sample a 2D canvas: pixels differing from its background corner
              // prove the workspace actually painted (axis text/candles), not a
              // blank surface.
              let painted = { ok: false };
              try {
                for (const c of document.querySelectorAll('canvas')) {
                  const ctx = c.getContext('2d');
                  if (!ctx) continue;
                  const { width, height } = c;
                  if (width < 2 || height < 2) continue;
                  const d = ctx.getImageData(0, 0, width, height).data;
                  for (let p = 0; p < d.length; p += 40) {
                    if (Math.abs(d[p] - d[0]) + Math.abs(d[p + 1] - d[1]) + Math.abs(d[p + 2] - d[2]) > 60) {
                      painted = { ok: true, diff: (p / 40) + 1 };
                      break;
                    }
                  }
                  if (painted.ok) break;
                }
              } catch {
                painted = { ok: 'sampling-error' };
              }
              return {
                ok: true,
                canvases,
                painted,
                hasPlayback: document.body.textContent.includes('Playback'),
                hasSessionChip: document.body.textContent.includes('EUR/USD'),
                sourceBadge: document.body.textContent.includes('cache'),
                candleCounter: document.body.textContent.includes('candles')
              };
            }
            await sleep(500);
          }
          return { ok: false, step: 'no-canvas', diag: diag() };
        })()`)
        await shot('/tmp/opencode/wanderlust-2-session.png')

        console.log('[e2e] shell      =', JSON.stringify(shellDom))
        console.log('[e2e] download#1 =', JSON.stringify(download1))
        console.log(
          '[e2e] readback   =',
          JSON.stringify({ ok: readback.ok, count: readback.count })
        )
        console.log('[e2e] summary    =', JSON.stringify(summary1))
        console.log('[e2e] download#2 =', JSON.stringify(download2))
        console.log('[e2e] ui journey =', JSON.stringify(ui))
        console.log('[e2e] console   =', JSON.stringify(consoleLogs.slice(-8)))
        console.log('[e2e] screenshots: /tmp/opencode/wanderlust-{1-empty,2-session}.png')
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
