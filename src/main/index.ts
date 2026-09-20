import { app, shell, BrowserWindow } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { registerIpcHandlers } from './ipc'
import { closeDb } from './db'
import { runDbSmokeTest } from './smoke'
import { TIMEFRAMES } from '../shared/timeframes'
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

  // `autoHideMenuBar` only hides the menu bar; pressing Alt still reveals it.
  // Removing the menu entirely prevents the Alt key from summoning it.
  mainWindow.removeMenu()

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
      // Trace every phase to a file + stdout so a hang is attributable even if
      // buffered stdout is lost when we app.exit(). A watchdog bounds the whole
      // run so a stuck IPC/network call can't stall forever.
      const trace: Array<{ phase: string; at: number; detail?: unknown }> = []
      const writeTrace = async (): Promise<void> => {
        try {
          const { writeFileSync } = await import('fs')
          writeFileSync('/tmp/opencode/e2e-trace.json', JSON.stringify(trace, null, 2))
        } catch {
          /* best-effort */
        }
      }
      const note = (phase: string, detail?: unknown): void => {
        trace.push({ phase, at: Date.now(), detail })
        console.log('[e2e]', phase, detail === undefined ? '' : JSON.stringify(detail))
      }
      const watchdog = setTimeout(() => {
        void writeTrace().then(() => {
          console.error('[e2e] TIMEOUT')
          app.exit(2)
        })
      }, 150_000)
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

        note('did-finish-load')

        // Phase 5 E2E: mount the chart's test handle (window.__wanderlust) —
        // VelaChart creates it when the page hash contains 'e2e', so set it
        // before any session mounts. It lets the journey inject + select a
        // Long/Short Position drawing exactly like the toolbar would.
        await js(`location.hash = '#e2e'`).catch(() => null)

        // ---- 1. UI shell: header, empty state, session button ----
        const shellDom = await js(`({
          title: document.querySelector('h1')?.textContent ?? null,
          phaseBadge: document.body.textContent.includes('Phase 5'),
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
        note('download1', download1)
        await js('new Promise(r => setTimeout(r, 250))') // let progress events flush
        const readback = await js<{ ok: boolean; count: number }>(
          `window.api.getCachedData(${JSON.stringify(range)})`
        )
        note('readback', { ok: readback.ok, count: readback.count })
        // The run-up day (startDate − 1) must be a FULL 24 hours of candles —
        // first candle 00:00, last 23:59 — or the "previous 24 hours" promise
        // is broken. (The UI journey asserts the last one via playback-time.)
        const runUpDay = await js(`window.api.getCachedData({
          symbol: 'eurusd', timeframe: 'm1', startDate: '2024-01-02', endDate: '2024-01-02'
        }).then((d) => ({
          count: d.candles.length,
          first: d.candles[0] ? new Date(d.candles[0].timestamp).toISOString() : null,
          last: d.candles.length
            ? new Date(d.candles[d.candles.length - 1].timestamp).toISOString()
            : null
        }))`)
        note('runUpDay', runUpDay)
        const summary1 = await js('window.api.getCacheSummary()')
        note('summary1', summary1)
        const download2 = await js(`window.api.downloadData(${JSON.stringify(range)})`)
        note('download2', download2)

        // ---- 3. Batch download over IPC (session behavior: many timeframes) ----
        // Pre-caches EVERY timeframe for 01-02..04 — a superset of the UI
        // journey's session (03..04) and its run-up day (01-02) — so the UI
        // section below is fully cache-served on a fresh database.
        const batchReq = {
          symbol: 'eurusd',
          timeframes: [...TIMEFRAMES],
          startDate: '2024-01-02',
          endDate: '2024-01-04'
        }
        const batch = await js(`window.api.downloadData(${JSON.stringify(batchReq)})`)
        note('batch', batch)
        const summary2 = await js('window.api.getCacheSummary()')
        note('summary2', summary2)

        // ---- 4. UI journey: modal → session → Vela chart → playback loop → tf switch ----
        const logsBefore = consoleLogs.length
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
          const samplePainted = () => {
            try {
              for (const c of document.querySelectorAll('canvas')) {
                const ctx = c.getContext('2d');
                if (!ctx) continue;
                const { width, height } = c;
                if (width < 2 || height < 2) continue;
                const d = ctx.getImageData(0, 0, width, height).data;
                for (let p = 0; p < d.length; p += 40) {
                  if (Math.abs(d[p] - d[0]) + Math.abs(d[p + 1] - d[1]) + Math.abs(d[p + 2] - d[2]) > 60) {
                    return { ok: true, diff: (p / 40) + 1 };
                  }
                }
              }
              return { ok: false };
            } catch {
              return { ok: 'sampling-error' };
            }
          };
          const diag = () => ({
            text: document.body.textContent.slice(0, 300),
            ids: [...document.querySelectorAll('[id]')].map((el) => el.id),
            buttons: [...document.querySelectorAll('button')].map((b) => b.textContent?.trim()),
            menus: [...document.querySelectorAll('[data-slot="dropdown-menu-content"]')].map((e) => ({
              slot: e.getAttribute('data-slot'),
              state: e.getAttribute('data-state'),
              html: e.innerHTML.slice(0, 400)
            })),
            gotoDate: !!document.querySelector('[data-testid="playback-goto-date"]'),
            radix: [...document.querySelectorAll('[id^="radix-"]')].map((e) => ({
              id: e.id,
              tag: e.tagName,
              slot: e.getAttribute('data-slot'),
              role: e.getAttribute('role'),
              text: (e.textContent || '').slice(0, 120)
            }))
          });
          if (!btn('New Session')) return { ok: false, step: 'no-open-button', diag: diag() };
          btn('New Session').click();
          await sleep(300);
          const from2 = document.querySelector('#ns-date-from');
          const to2 = document.querySelector('#ns-date-to');
          if (!from2 || !to2) return { ok: false, step: 'modal-fields-missing', diag: diag() };
          setVal(from2, '2024-01-03');
          setVal(to2, '2024-01-04');
          await sleep(200);
          const start = btn('Start Session');
          if (!start || start.disabled) return { ok: false, step: 'start-disabled' };
          start.click();
          for (let i = 0; i < 60; i++) {
            const canvases = document.querySelectorAll('canvas').length;
            if (canvases > 0 && document.body.textContent.includes('Playback')) {
              const idxText = () =>
                document.querySelector('[data-testid="playback-index"]')?.textContent ?? null;
              const timeText = () =>
                document.querySelector('[data-testid="playback-time"]')?.textContent ?? null;

              // 4a. Session starts at index 0 with RUN-UP context: the chart
              // must already be painted (yesterday's candles) and the clock
              // shows the run-up day's close (2024-01-02 23:59 UTC), not '—'.
              const counter0 = idxText();
              const time0 = timeText();
              const paintedAtStart = samplePainted();

              // 4b. Go To: open the dropdown, then jump to 2024-01-04 via
              // Custom Date → the index must land inside the second day
              // (~1440 of ~2880 m1 candles) and the chart repaint.
              const gtb = document.querySelector('[data-testid="playback-session-goto-btn"]');
              if (!gtb) return { ok: false, step: 'no-goto-btn', diag: diag() };
              gtb.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerId: 1, button: 0, buttons: 1 }));
              gtb.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, pointerId: 1, button: 0, buttons: 0 }));
              gtb.click();
              await sleep(200);
              const gd = document.querySelector('[data-testid="playback-goto-date"]');
              if (!gd) return { ok: false, step: 'no-goto-input', diag: diag() };
              setVal(gd, '2024-01-04');
              await sleep(150);
              const gb = document.querySelector('[data-testid="playback-goto-btn"]');
              if (!gb) return { ok: false, step: 'no-goto-btn2', diag: diag() };
              gb.click();
              await sleep(1400);
              const counterGo = idxText();
              const timeGo = timeText();
              const paintedGo = samplePainted();

              // 4c. Step forward: exactly +1.
              const stepBtn = document.querySelector('[data-testid="playback-step"]');
              if (!stepBtn) return { ok: false, step: 'no-step-btn', diag: diag() };
              stepBtn.click();
              await sleep(900);
              const counterStep = idxText();

              // 4d. Play at max speed (~20 bars/s): the index must visibly
              // advance while playing, then Pause freezes it. The b0 shadcn
              // control is a Radix Slider (not a native range input): jump it
              // to max with its End-key keyboard behavior.
              const spd = document.querySelector('[data-testid="playback-speed"]');
              if (spd) {
                const slider = spd.querySelector('[role="slider"]');
                if (slider) {
                  slider.focus?.();
                  slider.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
                  slider.dispatchEvent(new KeyboardEvent('keyup', { key: 'End', bubbles: true }));
                }
                await sleep(250);
              }
              const playBtn = document.querySelector('[data-testid="playback-play"]');
              if (!playBtn) return { ok: false, step: 'no-play-btn', diag: diag() };
              playBtn.click();
              await sleep(1700);
              const playingNow = (playBtn.textContent ?? '').includes('Pause');
              const counterDuring = idxText();
              const timeDuring = timeText();
              const paintedDuring = samplePainted();
              const pauseBtn = btn('Pause');
              if (pauseBtn) pauseBtn.click();
              await sleep(300);
              const counterPaused = idxText();

              // 4e. Switch the chart to 15m via the workspace topbar. Vela
              // formats the active timeframe with a suffix ('1m') and hides
              // the other options in a popover: click the tf button, then the
              // '15m' option. The "wanderlust" provider must serve the new
              // timeframe's revealed slice (not the full dataset).
              const tfButton = () =>
                [...document.querySelectorAll('button')].find((b) => {
                  const t = (b.textContent ?? '').trim();
                  return /^\\d{1,4}[mh]$/.test(t);
                });
              const before = tfButton();
              const tfClicked = !!before;
              let tfOptFound = false;
              let tfOptClicked = false;
              let tfLabelAfter = before?.textContent?.trim() ?? null;
              if (before) {
                before.click();
                await sleep(800);
                const opt = [
                  ...document.querySelectorAll(
                    'button, [role="button"], [role="option"], [role="menuitem"], li'
                  )
                ].find((el) => {
                  const t = (el.textContent ?? '').trim();
                  return t === '15m' || t === '15';
                });
                tfOptFound = !!opt;
                if (opt) {
                  const tgt = opt.tagName === 'BUTTON' ? opt : (opt.querySelector('button') ?? opt);
                  tgt.click();
                  tfOptClicked = true;
                  await sleep(1800);
                }
                tfLabelAfter = tfButton()?.textContent?.trim() ?? null;
              }
              await sleep(300);
              return {
                ok: true,
                canvases,
                // run-up context → go-to → step → play
                counter0,
                time0,
                paintedAtStart,
                counterGo,
                timeGo,
                paintedGo,
                counterStep,
                playingNow,
                counterDuring,
                timeDuring,
                paintedDuring,
                counterPaused,
                // timeframe switch
                tfClicked,
                tfOptFound,
                tfOptClicked,
                tfLabelAfter,
                canvasesAfterTf: document.querySelectorAll('canvas').length,
                paintedAfterTf: samplePainted(),
                tfCandidates: [...document.querySelectorAll('button')]
                  .map((b) => (b.textContent ?? '').trim())
                  .filter((t) => t.length > 0 && t.length <= 8)
                  .slice(0, 60),
                hasPlayback: true,
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
        note('ui', ui)

        // ---- 4b. Run-up GRACE check: a session in a fully-CACHED era whose
        // run-up days are NOT cached (nothing exists on disk before
        // 2026-09-01). The run-up phase must still terminate within its
        // cache-only budget (no long stall) and the session MUST start —
        // a missing / undownloadable run-up can never block or abort it.
        // Note: if Dukascopy is reachable this run-up may actually download.
        const ui2 = await js(`(async () => {
          const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
          const btn = (txt) =>
            [...document.querySelectorAll('button')].find((b) => b.textContent?.includes(txt));
          const setVal = (el, v) => {
            const proto = window.HTMLInputElement.prototype;
            Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
            el.dispatchEvent(new Event('input', { bubbles: true }));
          };
          if (!btn('New Session')) return { ok: false, step: 'no-open-button2' };
          btn('New Session').click();
          await sleep(300);
          const from2 = document.querySelector('#ns-date-from');
          const to2 = document.querySelector('#ns-date-to');
          if (!from2 || !to2) return { ok: false, step: 'modal-fields-missing2' };
          setVal(from2, '2026-09-01');
          setVal(to2, '2026-09-02');
          await sleep(200);
          const start2 = btn('Start Session');
          if (!start2 || start2.disabled) return { ok: false, step: 'start-disabled2' };
          start2.click();
          for (let i = 0; i < 100; i++) {
            // The NEW session always starts at index 0 — poll for that (the
            // old session's chart/state must be fully replaced first), then
            // the download + run-up phases have ended and the chart re-mounted.
            const idx = document.querySelector('[data-testid="playback-index"]')?.textContent;
            if (
              idx === '0' &&
              document.querySelectorAll('canvas').length > 0 &&
              document.body.textContent.includes('Playback')
            ) {
              return {
                ok: true,
                counter0: idx,
                time0: document.querySelector('[data-testid="playback-time"]')?.textContent ?? null,
                hasSessionChip: document.body.textContent.includes('EUR/USD')
              };
            }
            await sleep(500);
          }
          return { ok: false, step: 'no-ready2', diag: document.body.textContent.slice(0, 300) };
        })()`)
        await shot('/tmp/opencode/wanderlust-3-runup-grace.png')
        note('ui2', ui2)

        const layout = await js(`(() => {
          const rect = (el) => el ? (() => { const r = el.getBoundingClientRect(); return { h: +r.height.toFixed(2), w: +r.width.toFixed(2), top: +r.top.toFixed(2) }; })() : null;
          const host = document.querySelector('[data-testid="vela-container"]')?.parentElement;
          const speed = document.querySelector('[data-testid="playback-speed"]');
          const panel = speed ? speed.closest('[class*="flex-wrap"]') : null;
          const gotoBtn = document.querySelector('[data-testid="playback-session-goto-btn"]');
          return {
            innerH: window.innerHeight,
            host: rect(host),
            panel: rect(panel),
            panelChildren: panel ? [...panel.children].map((c) => rect(c)) : null,
            panelChildKinds: panel ? [...panel.children].map((c) => c.tagName + '.' + (c.className || '').slice(0, 40)) : null,
            goto: rect(gotoBtn),
            speed: rect(speed),
            speedTag: speed ? speed.tagName : null,
            speedChild: speed && speed.firstElementChild ? rect(speed.firstElementChild) : null
          };
        })()`)
        note('layout', layout)

        // ---- 4c. Phase 5: order execution + tick-by-tick evaluation. Runs on
        // the ui2 session (2026-09-01..02, m1 base) parked at index 0. Four
        // orders go through the full New Order flow, each seeded by a SELECTED
        // Long/Short Position drawing (SL/TP locked to the tool), stepping one
        // candle at a time so each fills/closes deterministically on a known
        // candle (session candle index = evaluation index):
        //   A market long → fills at candle[4] open, take-profit at its high
        //   B market long → fills at candle[5] open, stop-loss at its low
        //   C limit  long → fills at candle[6] low,  take-profit at its high
        //   D stop   long → fills at candle[7] low,  take-profit at its high
        // Every expected pnl/balance is recomputed from the same cached candles
        // the session plays, with risk = 1% of the then-current balance.
        // Also exercised: selection→menu prefill, SL/TP locked, order-type
        // switch, risk % templates, stop-first evaluation, live balance + the
        // closed-trade rows (1 SL, 3 TP).
        const ui3 = await js(`(async () => {
          const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
          const q = (s) => document.querySelector(s);
          const qa = (s) => [...document.querySelectorAll(s)];
          const text = (s) => q(s)?.textContent?.trim() ?? null;
          const click = (s) => { const el = q(s); if (!el) return false; const o = { bubbles: true, cancelable: true, pointerId: 1, button: 0 }; el.dispatchEvent(new PointerEvent('pointerdown', { ...o, buttons: 1 })); el.dispatchEvent(new MouseEvent('mousedown', { ...o, buttons: 1 })); el.dispatchEvent(new PointerEvent('pointerup', { ...o, buttons: 0 })); el.dispatchEvent(new MouseEvent('mouseup', { ...o, buttons: 0 })); el.click(); return true; };
          const fail = (step, extra = {}) => ({ ok: false, step, ...extra });
          const near = (a, b) => Math.abs(a - b) < 0.01;
          const readBalance = () =>
            Number((text('[data-testid="trading-balance"]') ?? '').replace(/[^0-9.+-]/g, ''));
          const count = (sel) => {
            const m = (text(sel) ?? '').match(/\\d+/);
            return m ? Number(m[0]) : NaN;
          };
          const wl = window.__wanderlust;
          if (!wl) return fail('no-e2e-handle');

          const res = await window.api.getCachedData({
            symbol: 'eurusd', timeframe: 'm1', startDate: '2026-09-01', endDate: '2026-09-02'
          });
          const candles = res.candles ?? [];
          if (candles.length < 9) return fail('no-candles', { count: candles.length });

          const stepTo = async (n) => {
            for (let i = 0; i < n * 4 + 10; i++) {
              if ((q('[data-testid="playback-index"]')?.textContent ?? '').trim() === String(n)) return true;
              if (!click('[data-testid="playback-step"]')) return false;
              await sleep(50);
            }
            return (q('[data-testid="playback-index"]')?.textContent ?? '').trim() === String(n);
          };
          const placeAndSelect = async (lv) => {
            const id = wl.addPosition(lv);
            if (!id) return false;
            wl.chart.drawings.select(id);
            await sleep(150);
            return true;
          };
          const openOrderMenu = async (type) => {
            if (!click('[data-testid="new-order-btn"]')) return false;
            await sleep(300);
            const typeBtn = qa('[data-testid="order-type"] button').find(
              (b) => (b.textContent ?? '').trim() === type
            );
            if (!typeBtn) return false;
            const ev = { bubbles: true, cancelable: true, pointerId: 1, button: 0 };
            typeBtn.dispatchEvent(new PointerEvent('pointerdown', { ...ev, buttons: 1 }));
            typeBtn.dispatchEvent(new MouseEvent('mousedown', { ...ev, buttons: 1 }));
            typeBtn.dispatchEvent(new PointerEvent('pointerup', { ...ev, buttons: 0 }));
            typeBtn.dispatchEvent(new MouseEvent('mouseup', { ...ev, buttons: 0 }));
            typeBtn.click();
            await sleep(120);
            return true;
          };
          const confirmOrder = async () => {
            click('[data-testid="confirm-order"]');
            await sleep(300);
            return !q('[data-testid="confirm-order"]'); // modal closed ⇒ accepted
          };

          // ---- expected values, recomputed from the very candles being played
          const startBalance = readBalance();
          const cA = candles[4], cB = candles[5], cC = candles[6], cD = candles[7];
          const sizeA = (startBalance * 0.01) / (cA.open - cA.low + 0.002);
          const pnlA = (cA.high - cA.open) * sizeA; // TP at high, long
          const balAfterA = startBalance + pnlA;
          const bDist = cB.open - cB.low;
          const sizeB = bDist > 0 ? (balAfterA * 0.01) / bDist : 0; // open==low ⇒ 0 size
          const pnlB = (cB.low - cB.open) * sizeB; // SL at low, long ⇒ ≤ 0
          const balAfterB = balAfterA + pnlB;
          const sizeC = (balAfterB * 0.01) / 0.002; // |entry − SL| = 0.002 fixed
          const pnlC = (cC.high - cC.low) * sizeC;
          const balAfterC = balAfterB + pnlC;
          const sizeD = (balAfterC * 0.01) / 0.002;
          const pnlD = (cD.high - cD.low) * sizeD;
          const balFinal = balAfterC + pnlD;

          // ---- 0. park the replay (start index = currentIndex 0)
          if (!(await stepTo(4))) return fail('park-index', { idx: text('[data-testid="playback-index"]') });
          if (!near(startBalance, 100000)) return fail('seed-balance', { startBalance });

          // ---- A. market long from the SELECTED tool; TP on candle[4]
          if (!(await placeAndSelect({ entry: cA.close, stop: cA.low - 0.002, target: cA.high, time: cA.timestamp })))
            return fail('place-a');
          if (!text('[data-testid="selected-position"]')) return fail('selection-a');
          if (!(await openOrderMenu('Market'))) return fail('open-a');
          const sourceA = text('[data-testid="order-source"]') ?? '';
          const slDisabled = q('[data-testid="order-sl"]')?.disabled === true;
          const tpDisabled = q('[data-testid="order-tp"]')?.disabled === true;
          const entryIsMarket = (q('[data-testid="order-entry"]')?.value ?? '') === 'Market';
          if (!(await confirmOrder())) return fail('confirm-a');
          if (count('[data-testid="pending-count"]') !== 1) return fail('pending-a', { c: text('[data-testid="pending-count"]') });
          if (!near(readBalance(), startBalance)) return fail('balance-frozen-a');
          if (!(await stepTo(5))) return fail('step-a');
          if (count('[data-testid="closed-count"]') !== 1) return fail('closed-a', { c: text('[data-testid="closed-count"]') });
          if (!near(readBalance(), balAfterA)) return fail('pnl-a', { actual: readBalance(), expected: balAfterA, pnlA });

          // ---- B. market long; SL on candle[5]
          if (!(await placeAndSelect({ entry: cB.close, stop: cB.low, target: cB.high + 0.002, time: cB.timestamp })))
            return fail('place-b');
          if (!(await openOrderMenu('Market'))) return fail('open-b');
          if (!(await confirmOrder())) return fail('confirm-b');
          if (count('[data-testid="pending-count"]') !== 1) return fail('pending-b');
          if (!(await stepTo(6))) return fail('step-b');
          if (count('[data-testid="closed-count"]') !== 2) return fail('closed-b', { c: text('[data-testid="closed-count"]') });
          if (!near(readBalance(), balAfterB)) return fail('pnl-b', { actual: readBalance(), expected: balAfterB, pnlB });

          // ---- C. LIMIT long; fills at candle[6] low, TP at its high.
          // Risk-template buttons must change the live size preview.
          if (!(await placeAndSelect({ entry: cC.low, stop: cC.low - 0.002, target: cC.high, time: cC.timestamp })))
            return fail('place-c');
          if (!(await openOrderMenu('Limit'))) return fail('open-c');
          const previewAt1 = text('[data-testid="size-preview"]') ?? '';
          const risk2 = qa('[data-testid="risk-templates"] button').find((b) => (b.textContent ?? '').trim() === '2%');
          if (!risk2) return fail('risk-template-missing');
          risk2.click();
          await sleep(120);
          const previewAt2 = text('[data-testid="size-preview"]') ?? '';
          const risk1 = qa('[data-testid="risk-templates"] button').find((b) => (b.textContent ?? '').trim() === '1%');
          if (risk1) { risk1.click(); await sleep(120); }
          if (previewAt1 === previewAt2) return fail('risk-template-inert', { previewAt1, previewAt2 });
          if (!(await confirmOrder())) return fail('confirm-c');
          if (count('[data-testid="pending-count"]') !== 1) return fail('pending-c');
          if (!(await stepTo(7))) return fail('step-c');
          if (count('[data-testid="closed-count"]') !== 3) return fail('closed-c', { c: text('[data-testid="closed-count"]') });
          if (!near(readBalance(), balAfterC)) return fail('pnl-c', { actual: readBalance(), expected: balAfterC, pnlC });

          // ---- D. STOP long; fills at candle[7] low, TP at its high
          if (!(await placeAndSelect({ entry: cD.low, stop: cD.low - 0.002, target: cD.high, time: cD.timestamp })))
            return fail('place-d');
          if (!(await openOrderMenu('Stop'))) return fail('open-d');
          if (!(await confirmOrder())) return fail('confirm-d');
          if (count('[data-testid="pending-count"]') !== 1) return fail('pending-d');
          if (!(await stepTo(8))) return fail('step-d');
          if (count('[data-testid="closed-count"]') !== 4) return fail('closed-d', { c: text('[data-testid="closed-count"]') });

          // ---- final state
          const closedFinal = count('[data-testid="closed-count"]');
          const activeFinal = count('[data-testid="active-count"]');
          const pendingFinal = count('[data-testid="pending-count"]');
          const balActual = readBalance();
          const headerActual = Number((text('[data-testid="header-balance"]') ?? '').replace(/[^0-9.+-]/g, ''));
          const slRows = qa('[data-testid="closed-row"]').filter((r) => r.textContent.includes('SL')).length;
          const tpRows = qa('[data-testid="closed-row"]').filter((r) => r.textContent.includes('TP')).length;
          return {
            ok:
              closedFinal === 4 && activeFinal === 0 && pendingFinal === 0 &&
              near(balActual, balFinal) && near(headerActual, balFinal) &&
              slRows === 1 && tpRows === 3,
            step: 'final',
            closedFinal, activeFinal, pendingFinal,
            balActual, balFinal, headerActual,
            slRows, tpRows,
            startBalance, sourceA, slDisabled, tpDisabled, entryIsMarket,
            previewRiskTemplatesWorked: previewAt1 !== previewAt2,
            pnls: { pnlA, pnlB, pnlC, pnlD },
            candles: { cA: cA.timestamp, cB: cB.timestamp, cC: cC.timestamp, cD: cD.timestamp }
          };
        })()`)
        await shot('/tmp/opencode/wanderlust-4-trading.png')
        note('ui3', ui3)

        // ---- 4d. Regression for the reported bug: selecting a position tool
        // correctly updates the store, but clicking New Order fell back to
        // manual. Root cause: a plain click on a drawing also opens Vela's
        // floating drawing-toolbar popup, and ANY subsequent outside press
        // (e.g. clicking the New Order button — a document-level pointerdown)
        // dismisses it, which clears the selection — Vela then announces
        // `drawing:selected` with an EMPTY ids array, and the menu mounts a
        // beat later already in manual mode. Fix: empty selection events are
        // chart-UI churn and must not drop the drawing backing New Order.
        // ui4 replays the user's steps end-to-end and asserts the dismiss
        // (sawEmpty) no longer clears the pick, then New Order seeds from the
        // tool, places a market order and closes it with the expected pnl.
        const ui4 = await js(`(async () => {
          const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
          const q = (s) => document.querySelector(s);
          const qa = (s) => [...document.querySelectorAll(s)];
          const text = (s) => q(s)?.textContent?.trim() ?? null;
          const click = (s) => { const el = q(s); if (!el) return false; const o = { bubbles: true, cancelable: true, pointerId: 1, button: 0 }; el.dispatchEvent(new PointerEvent('pointerdown', { ...o, buttons: 1 })); el.dispatchEvent(new MouseEvent('mousedown', { ...o, buttons: 1 })); el.dispatchEvent(new PointerEvent('pointerup', { ...o, buttons: 0 })); el.dispatchEvent(new MouseEvent('mouseup', { ...o, buttons: 0 })); el.click(); return true; };
          const fail = (step, extra = {}) => ({ ok: false, step, ...extra });
          const near = (a, b) => Math.abs(a - b) < 0.01;
          const readBalance = () =>
            Number((text('[data-testid="trading-balance"]') ?? '').replace(/[^0-9.+-]/g, ''));
          const count = (sel) => {
            const m = (text(sel) ?? '').match(/\\d+/);
            return m ? Number(m[0]) : NaN;
          };
          const wl = window.__wanderlust;
          if (!wl) return fail('no-e2e-handle');

          const res = await window.api.getCachedData({
            symbol: 'eurusd', timeframe: 'm1', startDate: '2026-09-01', endDate: '2026-09-02'
          });
          const candles = res.candles ?? [];
          if (candles.length < 11) return fail('no-candles', { count: candles.length });

          const stepTo = async (n) => {
            for (let i = 0; i < n * 4 + 10; i++) {
              if ((q('[data-testid="playback-index"]')?.textContent ?? '').trim() === String(n)) return true;
              if (!click('[data-testid="playback-step"]')) return false;
              await sleep(50);
            }
            return (q('[data-testid="playback-index"]')?.textContent ?? '').trim() === String(n);
          };

          const balBefore = readBalance();
          const cE = candles[9]; // submitted at index 9 → fills candle idx 9
          const sizeE = (balBefore * 0.01) / (cE.open - cE.low + 0.002);
          const pnlE = (cE.high - cE.open) * sizeE;
          const balAfter = balBefore + pnlE;

          if (!(await stepTo(9))) return fail('park', { idx: text('[data-testid="playback-index"]') });

          // The user's flow: place the position tool + click it to select.
          const id = wl.addPosition({ entry: cE.close, stop: cE.low - 0.002, target: cE.high, time: cE.timestamp });
          if (!id) return fail('place');
          wl.chart.drawings.select(id);
          await sleep(150);
          if (!text('[data-testid="selected-position"]')) return fail('no-chip');

          // A click on a drawing ALSO opens Vela's floating drawing-toolbar
          // popup (openSettings is its programmatic twin). Probe for the empty
          // selection announcement its dismissal causes.
          wl.chart.drawings.openSettings(id);
          await sleep(200);
          let sawEmpty = false;
          const unsub = wl.chart.on('drawing:selected', (e) => {
            if (!e.ids || e.ids.length === 0) sawEmpty = true;
          });
          document.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
          await sleep(200);
          unsub();

          if (!text('[data-testid="selected-position"]')) return fail('chip-cleared-by-dismiss', { sawEmpty });

          if (!click('[data-testid="new-order-btn"]')) return fail('open-menu');
          await sleep(300);
          const source = text('[data-testid="order-source"]') ?? '';
          const slDisabled = q('[data-testid="order-sl"]')?.disabled === true;
          const tpDisabled = q('[data-testid="order-tp"]')?.disabled === true;
          const entryIsMarket = (q('[data-testid="order-entry"]')?.value ?? '') === 'Market';
          click('[data-testid="confirm-order"]');
          await sleep(300);
          if (q('[data-testid="confirm-order"]')) return fail('menu-stayed-open', { source });
          if (count('[data-testid="pending-count"]') !== 1) return fail('pending', { c: text('[data-testid="pending-count"]') });
          if (!(await stepTo(10))) return fail('step');
          const balActual = readBalance();
          const closed = count('[data-testid="closed-count"]');
          return {
            ok: sawEmpty && closed === 5 && near(balActual, balAfter) && source.includes('From chart tool') && slDisabled && tpDisabled && entryIsMarket,
            step: 'final',
            closed, balActual, balAfter, pnlE,
            source, sawEmpty, slDisabled, tpDisabled, entryIsMarket,
            candle: cE.timestamp
          };
        })()`)
        await shot('/tmp/opencode/wanderlust-5-selection.png')
        note('ui4', ui4)

        // ---- 4e. Regression for the view reset: `setMarket({ data })` is a
        // full market switch that nulls the chart viewport, so a hard-coded
        // frame in pushSlice re-zoomed the chart on EVERY play/step (and jumped
        // from "frame all 24h run-up" to the 120-bar window the moment playback
        // started). Fix: after the initial reveal the current view is preserved
        // — pinned to the newest candle it slides along at the SAME zoom, so
        // the width (zoom) is untouched and the right edge advances by exactly
        // the reveal delta. ui5 steps forward and asserts both.
        const ui5 = await js(`(async () => {
          const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
          const q = (s) => document.querySelector(s);
          const text = (s) => q(s)?.textContent?.trim() ?? null;
          const click = (s) => { const el = q(s); if (!el) return false; const o = { bubbles: true, cancelable: true, pointerId: 1, button: 0 }; el.dispatchEvent(new PointerEvent('pointerdown', { ...o, buttons: 1 })); el.dispatchEvent(new MouseEvent('mousedown', { ...o, buttons: 1 })); el.dispatchEvent(new PointerEvent('pointerup', { ...o, buttons: 0 })); el.dispatchEvent(new MouseEvent('mouseup', { ...o, buttons: 0 })); el.click(); return true; };
          const fail = (step, extra = {}) => ({ ok: false, step, ...extra });
          const wl = window.__wanderlust;
          if (!wl) return fail('no-e2e-handle');
          const res = await window.api.getCachedData({
            symbol: 'eurusd', timeframe: 'm1', startDate: '2026-09-01', endDate: '2026-09-02'
          });
          const candles = res.candles ?? [];
          if (candles.length < 13) return fail('no-candles', { count: candles.length });
          const barMs = 60000;
          const stepTo = async (n) => {
            for (let i = 0; i < n * 4 + 10; i++) {
              if ((q('[data-testid="playback-index"]')?.textContent ?? '').trim() === String(n)) return true;
              if (!click('[data-testid="playback-step"]')) return false;
              await sleep(50);
            }
            return (q('[data-testid="playback-index"]')?.textContent ?? '').trim() === String(n);
          };
          if (!(await stepTo(10))) return fail('park');
          await sleep(200); // let the last push's view settle
          const v1 = wl.chart.getVisibleRange();
          if (!v1) return fail('no-view-1');
          if (!(await stepTo(12))) return fail('step');
          await sleep(200);
          const v2 = wl.chart.getVisibleRange();
          if (!v2) return fail('no-view-2');
          const w1 = v1.to - v1.from;
          const w2 = v2.to - v2.from;
          const zoomStable = Math.abs(w2 - w1) <= 2 * barMs;
          const rightFollowed = Math.abs(v2.to - (v1.to + 2 * barMs)) <= barMs;
          return {
            ok: zoomStable && rightFollowed,
            step: 'final',
            w1, w2, v1to: v1.to, v2to: v2.to, zoomStable, rightFollowed
          };
        })()`)
        await shot('/tmp/opencode/wanderlust-6-viewport.png')
        note('ui5', ui5)

        // ---- 4f. Regression for "playback zooms in on the newest candle":
        // `setMarket({ data })` is a full reload that CLEARS the bars first, so
        // during the load `getVisibleRange()` returns null. Under fast playback
        // pushes overlap that window, and the old fallback re-framed a fixed
        // 120-bar window → the view snapped zoomed-in on the latest candle no
        // matter what the user zoomed to. Fix: on an unreadable viewport, slide
        // the LAST applied range instead of framing anything new. ui6 zooms in
        // with a wheel gesture, then plays at max-speed cadence and asserts the
        // zoomed width survives (no snap back to the wide view, no 120-bar).
        const ui6 = await js(`(async () => {
          const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
          const q = (s) => document.querySelector(s);
          const text = (s) => q(s)?.textContent?.trim() ?? null;
          const click = (s) => { const el = q(s); if (!el) return false; const o = { bubbles: true, cancelable: true, pointerId: 1, button: 0 }; el.dispatchEvent(new PointerEvent('pointerdown', { ...o, buttons: 1 })); el.dispatchEvent(new MouseEvent('mousedown', { ...o, buttons: 1 })); el.dispatchEvent(new PointerEvent('pointerup', { ...o, buttons: 0 })); el.dispatchEvent(new MouseEvent('mouseup', { ...o, buttons: 0 })); el.click(); return true; };
          const fail = (step, extra = {}) => ({ ok: false, step, ...extra });
          const wl = window.__wanderlust;
          if (!wl) return fail('no-e2e-handle');
          const barMs = 60000;
          const stepTo = async (n) => {
            for (let i = 0; i < n * 4 + 10; i++) {
              if ((q('[data-testid="playback-index"]')?.textContent ?? '').trim() === String(n)) return true;
              if (!click('[data-testid="playback-step"]')) return false;
              await sleep(50);
            }
            return (q('[data-testid="playback-index"]')?.textContent ?? '').trim() === String(n);
          };
          const readWidth = () => {
            const v = wl.chart.getVisibleRange();
            return v ? { from: v.from, to: v.to, w: v.to - v.from } : null;
          };
          const wheelZoom = async (deltaY, count, gapMs) => {
            const canvas = [...document.querySelectorAll('canvas')]
              .map((c) => c.getBoundingClientRect())
              .sort((a, b) => b.width * b.height - a.width * a.height)[0];
            if (!canvas || canvas.width === 0) return false;
            const target = document.elementFromPoint(canvas.left + canvas.width / 2, canvas.top + canvas.height / 2);
            const el = target ?? document.querySelector('canvas');
            for (let i = 0; i < count; i++) {
              el.dispatchEvent(new WheelEvent('wheel', {
                deltaY, clientX: canvas.left + canvas.width * 0.6, clientY: canvas.top + canvas.height * 0.5,
                bubbles: true, cancelable: true
              }));
              await sleep(gapMs);
            }
            return true;
          };
          if (!(await stepTo(12))) return fail('park');
          await sleep(250);
          const v1 = readWidth();
          if (!v1) return fail('no-view-1');
          // User gesture: wheel-zoom IN (deltaY < 0), right edge stays anchored.
          if (!(await wheelZoom(-160, 3, 60))) return fail('wheel');
          await sleep(200);
          const vZoom = readWidth();
          if (!vZoom) return fail('no-view-zoom');
          const zoomedIn = vZoom.w < v1.w * 0.7;
          // Max-speed playback cadence: 50ms ticks for 10 candles.
          const samples = [];
          for (let i = 0; i < 10; i++) {
            if (!click('[data-testid="playback-step"]')) return fail('step');
            await sleep(50);
            const v = readWidth();
            if (v) samples.push(v.w);
          }
          await sleep(250);
          const vFin = readWidth();
          if (!vFin) return fail('no-view-fin');
          const drift = samples.length ? Math.max(...samples.map((w) => Math.abs(w - vZoom.w))) : Infinity;
          const snappedWide = Math.abs(vFin.w - v1.w) < barMs * 3;
          const snapped120 = Math.abs(vFin.w - 120 * barMs) < barMs * 12;
          const ok = zoomedIn && drift <= 3 * barMs && !snappedWide && !snapped120;

          // Tight synchronous burst: pushSlices stack in ONE task. Each new push
          // sees the bars already CLEARED by the previous push's setMarket (the
          // load only finishes in the microtask drain), so chart.getVisibleRange()
          // returns null - the old fallback then framed a fixed 120-bar window
          // around the newest candle ("playback zooms in on the latest candle").
          for (let i = 0; i < 8; i++) click('[data-testid="playback-step"]')
          await sleep(200);
          const vBurst = readWidth();
          if (!vBurst) return fail('no-view-burst');
          const burstSnapped120 = Math.abs(vBurst.w - 120 * barMs) < barMs * 12;
          const burstWidthKept = Math.abs(vBurst.w - vZoom.w) <= 3 * barMs;
          return {
            ok: ok && burstWidthKept && !burstSnapped120, step: 'final',
            w1: v1.w, wZoom: vZoom.w, wFin: vFin.w, wBurst: vBurst.w,
            to1: v1.to, toFin: vFin.to, drift,
            snappedWide, snapped120, burstSnapped120, burstWidthKept, zoomedIn
          };
        })()`)
        await shot('/tmp/opencode/wanderlust-7-playback-view.png')
        note('ui6', ui6)

        // ---- 4g. Regression for "charts always maxed to the right" + "the free
        // view from resizing the vertical price scroll bar gets reset": the
        // public getVisibleRange() clamps right-side whitespace away, so every
        // push reset the right offset to 0 (newest candle glued to the screen
        // edge), and Vela's reload path (reframeKeepZoom) reset manual price
        // frames to autoscale. ui7 freezes a manual price frame on the main
        // pane exactly like the price-axis drag does, plays at max-speed
        // cadence, and asserts the price frame + the right offset survive.
        const ui7 = await js(`(async () => {
          const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
          const q = (s) => document.querySelector(s);
          const text = (s) => q(s)?.textContent?.trim() ?? null;
          const click = (s) => { const el = q(s); if (!el) return false; const o = { bubbles: true, cancelable: true, pointerId: 1, button: 0 }; el.dispatchEvent(new PointerEvent('pointerdown', { ...o, buttons: 1 })); el.dispatchEvent(new MouseEvent('mousedown', { ...o, buttons: 1 })); el.dispatchEvent(new PointerEvent('pointerup', { ...o, buttons: 0 })); el.dispatchEvent(new MouseEvent('mouseup', { ...o, buttons: 0 })); el.click(); return true; };
          const fail = (step, extra = {}) => ({ ok: false, step, ...extra });
          const wl = window.__wanderlust;
          if (!wl) return fail('no-e2e-handle');
          // chart.renderer is Vela's RendererControl facade — the native
          // renderer (with scene/coords) lives one hop deeper.
          const shell = wl.chart;
          const renderer = [shell?.rendererControl?.renderer, shell?.renderer, shell?.orchestrator?.renderer]
            .find((r) => r && r.scene && r.coords);
          if (!renderer) return fail('no-renderer');
          const stepTo = async (n) => {
            for (let i = 0; i < n * 4 + 10; i++) {
              if ((q('[data-testid="playback-index"]')?.textContent ?? '').trim() === String(n)) return true;
              if (!click('[data-testid="playback-step"]')) return false;
              await sleep(50);
            }
            return (q('[data-testid="playback-index"]')?.textContent ?? '').trim() === String(n);
          };
          if (!(await stepTo(30))) return fail('park');
          await sleep(250);
          const vp0 = renderer.coords.getViewport();
          const r0 = vp0 ? vp0.rightOffset : null;
          const pane = [...(renderer.scene?.panes?.values() ?? [])].find((p) => p.kind === 'price');
          if (!pane) return fail('no-pane');
          // The user's "free view": resize the vertical price scale (axis drag
          // freezes the pane into manual mode). setManualScale is that freeze.
          renderer.setManualScale(pane, { min: 1.05, max: 1.11 });
          if (pane.manualScale == null) return fail('no-manual');
          // Play at max-speed cadence.
          for (let i = 0; i < 5; i++) { if (!click('[data-testid="playback-step"]')) return fail('step'); await sleep(55); }
          await sleep(200);
          const vp1 = renderer.coords.getViewport();
          const r1 = vp1 ? vp1.rightOffset : null;
          const manualKept = pane.manualScale != null;
          const rangeKept = manualKept && Math.abs(pane.scale.min - 1.05) < 1e-6 && Math.abs(pane.scale.max - 1.11) < 1e-6;
          const offsetStable = r0 != null && r1 != null && Math.abs(r1 - r0) <= 2;
          return {
            ok: manualKept && rangeKept && offsetStable, step: 'final',
            r0, r1, manualKept, rangeKept, offsetStable, min: pane.scale?.min, max: pane.scale?.max
          };
        })()`)
        await shot('/tmp/opencode/wanderlust-8-freeview.png')
        note('ui7', ui7)

        // ---- 4h. Phase 6: OrderLevelsOverlay — draggable TP/SL strips. The
        // chart must render one overlay strip per level (entry/SL/TP) for the
        // pending order, positioned through the native coords bridge, and a
        // pointer drag on the SL strip must reprice that order's stopLoss via
        // yToPrice → updateOrderLevel (label reflects the new price). The
        // order is submitted at the CURRENT parked index so it stays pending
        // (a market order only fills on the NEXT reveal).
        const ui8 = await js(`(async () => {
          const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
          const q = (s) => document.querySelector(s);
          const qa = (s) => [...document.querySelectorAll(s)];
          const text = (s) => q(s)?.textContent?.trim() ?? null;
          const click = (s) => { const el = q(s); if (!el) return false; const o = { bubbles: true, cancelable: true, pointerId: 1, button: 0 }; el.dispatchEvent(new PointerEvent('pointerdown', { ...o, buttons: 1 })); el.dispatchEvent(new MouseEvent('mousedown', { ...o, buttons: 1 })); el.dispatchEvent(new PointerEvent('pointerup', { ...o, buttons: 0 })); el.dispatchEvent(new MouseEvent('mouseup', { ...o, buttons: 0 })); el.click(); return true; };
          const fail = (step, extra = {}) => ({ ok: false, step, ...extra });
          const wl = window.__wanderlust;
          if (!wl) return fail('no-e2e-handle');
          const cur = Number((text('[data-testid="playback-index"]') ?? '').trim());
          if (!Number.isFinite(cur)) return fail('no-index', { idx: text('[data-testid="playback-index"]') });
          const res = await window.api.getCachedData({
            symbol: 'eurusd', timeframe: 'm1', startDate: '2026-09-01', endDate: '2026-09-02'
          });
          const candles = res.candles ?? [];
          const cE = candles[cur];
          if (!cE) return fail('no-candle', { cur });
          // Place a fresh pending order exactly like the toolbar would.
          const did = wl.addPosition({ entry: cE.close, stop: cE.low - 0.002, target: cE.high, time: cE.timestamp });
          if (!did) return fail('place');
          wl.chart.drawings.select(did);
          await sleep(150);
          if (!text('[data-testid="selected-position"]')) return fail('no-chip');
          if (!click('[data-testid="new-order-btn"]')) return fail('open-menu');
          await sleep(300);
          click('[data-testid="confirm-order"]');
          await sleep(200); // order is now pending → overlay strips mount

          // ui7 left a manual price frame (min 1.05/max 1.11) on the main pane,
          // so levels around the candle (~1.16) sit ABOVE the visible scale.
          // Reframe the main price pane around the traded candle so the strips
          // land inside the pane — exactly what a real user's view would show.
          const shell = wl.chart;
          const renderer = [shell?.rendererControl?.renderer, shell?.renderer, shell?.orchestrator?.renderer]
            .find((rr) => rr && rr.scene && rr.coords);
          if (!renderer) return fail('no-renderer');
          const pane = [...(renderer.scene?.panes?.values() ?? [])].find((p) => p.kind === 'price');
          if (!pane) return fail('no-pane');
          const pad = Math.max(0.005, (cE.high - cE.low) * 2);
          renderer.setManualScale(pane, { min: cE.low - pad, max: cE.high + pad });
          await sleep(400); // let the rendered frame + rAF placement settle

          // Exactly one pending order was just created → exactly 3 level strips.
          const entryEl = q('[data-testid="order-level-entry"]');
          const slEl = q('[data-testid="order-level-stopLoss"]');
          const tpEl = q('[data-testid="order-level-takeProfit"]');
          const stripCount = qa('[data-testid="order-level-stopLoss"], [data-testid="order-level-takeProfit"], [data-testid="order-level-entry"]').length;
          if (!entryEl || !slEl || !tpEl) return fail('no-strips', { count: stripCount });

          // Strips must have been placed (opacity 1) and sit inside the chart
          // container's vertical bounds. The wheel-zoom glide test below also
          // needs the container element (Vela's zoom handler listens on it).
          const placed = [entryEl, slEl, tpEl].every((el) => getComputedStyle(el).opacity === '1');
          const rootRect = entryEl.parentElement.getBoundingClientRect();
          const containerEl = q('[data-testid="vela-container"]');
          const containerRect = containerEl?.getBoundingClientRect?.() ?? null;
          const originDelta = containerRect ? Math.round(rootRect.top - containerRect.top) : null;
          const rows = [entryEl, slEl, tpEl].map((el) => {
            const rr = el.getBoundingClientRect();
            return { top: Math.round(rr.top), inside: rr.top >= rootRect.top - 2 && rr.top + rr.height <= rootRect.bottom + 2 };
          });
          const insidePane = rows.every((r) => r.inside);

          // --- Regression A: strips must sit EXACTLY on the price axis. Each
          // strip's DOM Y (through the overlay's own origin) must equal the
          // native coords.priceToY(price, pane.scale, pane.bounds) — the exact
          // math Vela paints candles with — ±1.5px. A stray container offset
          // or a wrong scale/bounds read would show up here.
          // The overlay renders each strip from the ORDER's own fields (orders
          // are independent of the seeding drawing once submitted): a pending
          // market order anchors its entry to the latest revealed close, so the
          // ground-truth prices below come from the order, not the tool anchors.
          const STRIP_HALF = 6;
          const pendingOrder = (wl.orders() ?? []).find((o) => o.drawingId === did) ?? null;
          if (!pendingOrder) return fail('no-order-strips');
          const levelPrices = [
            ['entry', pendingOrder.fillPrice ?? pendingOrder.orderPrice],
            ['stopLoss', pendingOrder.stopLoss],
            ['takeProfit', pendingOrder.takeProfit]
          ];
          const exactDeltas = [];
          for (const [kind, price] of levelPrices) {
            const el = q('[data-testid="order-level-' + kind + '"]');
            if (!el) return fail('no-strip-' + kind);
            const expTop = (renderer.dataCanvas?.getBoundingClientRect().top ?? rootRect.top) - rootRect.top + renderer.coords.priceToY(price, pane.scale, pane.bounds) - STRIP_HALF;
            const actTop = el.getBoundingClientRect().top - rootRect.top;
            exactDeltas.push({ kind, exp: Math.round(expTop), act: Math.round(actTop), d: Math.round((actTop - expTop) * 10) / 10 });
          }
          const exact = exactDeltas.every((d) => Math.abs(d.d) <= 1.5);

          // --- Regression B: strips must stay GLUED to the price axis through
          // an ANIMATED wheel zoom (the user's worm-wheel glide). Drop the
          // manual frame so the pane autoscales, then wheel-zoom in the DATA
          // region (Vela's animated zoomTo path: barSpacing eases and autoscale
          // re-glides the price scale every frame). Sample the strips mid-flight
          // every ~25ms and require each to equal priceToY at THAT instant — a
          // one-frame lag (the old rAF-only placement read scales BEFORE Vela
          // painted) shows up as a mismatch while the scale is moving.
          pane.manualScale = null; // resume autoscale for the glide
          const scalePre = { min: pane.scale.min, max: pane.scale.max };
          // Vela's wheel handler binds to the DATA CANVAS (input.attach(dataCanvas)),
          // not the container div — dispatch there so the animated zoomTo path runs.
          const dataCanvas = renderer.dataCanvas?.tagName === 'CANVAS' ? renderer.dataCanvas : null;
          const wheelTarget = dataCanvas ?? containerEl ?? null;
          const cRect = dataCanvas ? dataCanvas.getBoundingClientRect() : (containerRect ?? rootRect);
          const wx = cRect.left + Math.max(120, cRect.width * 0.3);
          const wy = cRect.top + cRect.height / 2;
          const wheelAt = (dy) => {
            wheelTarget?.dispatchEvent(new WheelEvent('wheel', {
              deltaY: dy, deltaX: 0, clientX: wx, clientY: wy, bubbles: true, cancelable: true
            }));
          };
          wheelAt(-620);
          await sleep(60);
          wheelAt(-620);
          // Diagnostic: does the native post-paint viewport hook fire at all
          // during the glide? The overlay's glue depends on it.
          let vpFired = 0;
          const vpType = typeof renderer.onViewportChange;
          let vpUnsub = null;
          if (vpType === 'function') {
            try { vpUnsub = renderer.onViewportChange(() => { vpFired++; }) ?? null; } catch { vpUnsub = null; }
          }
          const samples = [];
          const keyPane = renderer.scene?.panes?.get('price');
          const keyPaneSame = keyPane === pane;
          const slCount = qa('[data-testid="order-level-stopLoss"]').length;
          const slPrice = cE.low - 0.002;
          for (let i = 0; i < 16; i++) {
            await sleep(25);
            const vp = renderer.coords.getViewport();
            const kp = renderer.scene?.panes?.get('price');
            const s = [];
            for (const [kind, price] of levelPrices) {
              const el = q('[data-testid="order-level-' + kind + '"]');
              if (!el) { s.push({ kind, miss: true }); continue; }
              const expTop = (renderer.dataCanvas?.getBoundingClientRect().top ?? rootRect.top) - rootRect.top + renderer.coords.priceToY(price, pane.scale, pane.bounds) - STRIP_HALF;
              const actTop = el.getBoundingClientRect().top - rootRect.top;
              s.push({ kind, d: Math.round((actTop - expTop) * 10) / 10 });
            }
            const pY = renderer.coords.priceToY(slPrice, pane.scale, pane.bounds);
            samples.push({
              bs: Math.round(vp.barSpacing * 100) / 100,
              min: pane.scale.min, max: pane.scale.max,
              logg: pane.scale.log ?? null,
              bTop: pane.bounds.top, bH: pane.bounds.height,
              pY, pYf: Number.isFinite(pY),
              kpMin: kp?.scale?.min, kpMax: kp?.scale?.max,
              vpCbsSize0: i === 0 ? (renderer.viewportCbs?.size ?? null) : undefined,
              s
            });
          }
          const s0 = samples[0];
          const sawGlide = samples.some((x, i) => i > 0 && Math.abs(x.bs - s0.bs) > 0.001);
          const sawScaleChange = samples.some((x, i) => i > 0 && (x.min !== s0.min || x.max !== s0.max));
          const glued = samples.every((x) => x.s.every((d) => !d.miss && Math.abs(d.d) <= 1.5));
          const missSamples = samples
            .map((x, i) => ({
              i,
              bs: x.bs,
              pYf: x.pYf,
              pY: Math.round(x.pY * 10) / 10,
              logg: x.logg,
              bTop: x.bTop,
              bH: x.bH,
              kpMin: x.kpMin,
              kpMax: x.kpMax,
              vpCbsSize0: x.vpCbsSize0,
              s: x.s
            }))
            .filter((x) => x.s.some((d) => d.miss || Math.abs(d.d) > 1.5))
            .slice(0, 6);
          vpUnsub?.();
          const vpCbsSize = renderer.viewportCbs?.size ?? null;
          await sleep(450); // let the glide settle fully

          // After the zoom settles the strips must STILL match the axis (no
          // residual drift) and their prices must be unchanged (zooming moves
          // no levels — only their on-screen Y).
          const settledDeltas = [];
          for (const [kind, price] of levelPrices) {
            const el = q('[data-testid="order-level-' + kind + '"]');
            if (!el) return fail('no-strip-settled-' + kind);
            const expTop = (renderer.dataCanvas?.getBoundingClientRect().top ?? rootRect.top) - rootRect.top + renderer.coords.priceToY(price, pane.scale, pane.bounds) - STRIP_HALF;
            const actTop = el.getBoundingClientRect().top - rootRect.top;
            settledDeltas.push({ kind, d: Math.round((actTop - expTop) * 10) / 10 });
          }
          const settledExact = settledDeltas.every((d) => Math.abs(d.d) <= 1.5);
          const priceLabel = (kind) => q('[data-testid="order-level-' + kind + '-price"]')?.textContent?.trim() ?? null;
          const labelsBefore = levelPrices.map(([kind]) => kind + ':' + priceLabel(kind));
          await sleep(30);
          const labelsAfter = levelPrices.map(([kind]) => kind + ':' + priceLabel(kind));
          const pricesStable = labelsAfter.every((lab) => labelsBefore.includes(lab));
          const scaleChanged = Math.abs(pane.scale.min - scalePre.min) > 0 || Math.abs(pane.scale.max - scalePre.max) > 0;

          // --- Drag the SL strip ~30px down; the store must reprice the order.
          const priceEl = q('[data-testid="order-level-stopLoss-price"]');
          const before = priceEl?.textContent?.trim() ?? null;
          const r = slEl.getBoundingClientRect();
          const cx = r.left + r.width / 2;
          const y0 = r.top + r.height / 2;
          slEl.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerId: 1, clientX: cx, clientY: y0, button: 0 }));
          slEl.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, cancelable: true, pointerId: 1, clientX: cx, clientY: y0 + 30, button: 0 }));
          slEl.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, pointerId: 1, clientX: cx, clientY: y0 + 30, button: 0 }));
          await sleep(250);
          const after = q('[data-testid="order-level-stopLoss-price"]')?.textContent?.trim() ?? null;
          const changed = before != null && after != null && before !== after;
          const rawLevels = window.__wanderlustLevels ?? null;
          const rendererSame = !!rawLevels && rawLevels.rendererObj === renderer;
          const finalScaleSame = !!rawLevels && rawLevels.paneScaleMin === pane.scale.min && rawLevels.paneScaleMax === pane.scale.max;
          const dbgLevels = rawLevels ? { ...rawLevels } : null;
          if (dbgLevels) delete dbgLevels.rendererObj;

          return {
            ok: placed && insidePane && stripCount === 3 && exact && glued && settledExact && pricesStable && changed,
            step: 'final',
            cur, stripCount, placed, insidePane, originDelta,
            wheelOn: dataCanvas ? 'canvas' : containerEl ? 'container' : 'none',
            vpType, vpFired, vpCbsSize, dbgLevels, rendererSame, finalScaleSame,
            keyPaneSame, slCount,
            exact, exactDeltas,
            sawGlide, sawScaleChange, scaleChanged, glued, missSamples,
            settledExact, settledDeltas, pricesStable,
            before, after, changed,
            rows: rows.map((r2) => r2.top)
          };
        })()`)
        await shot('/tmp/opencode/wanderlust-9-overlay.png')
        note('ui8', ui8)

        // ---- 4i. Regression for "lines STILL move when zooming / free viewing"
        // and "don't match the positioning tool": ui8 proved the strips are glued
        // through the ANIMATED wheel-zoom glide (post-paint viewport hook), but
        // the scheduler-driven drag gestures (data-area PAN, TIME-axis zoom drag,
        // PRICE-axis scale drag) repaint on their own lazily-registered rAF — the
        // overlay's rAF loop runs BEFORE that flush, so strips were placed with
        // the PRE-paint scale and lagged the canvas one frame DURING the drag
        // (the drawing-tool lines, painted ON the canvas, stayed glued — hence
        // "doesn't match the tool" while the strips float behind it).
        // ui9 replays each drag gesture and samples the strips MID-GESTURE,
        // including a "batch" variant: many moves dispatched with NO frame
        // between then a single rAF — the exact frame where pre-fix strips are
        // stale (loop placed pre-paint; the flush then paints the new scale) and
        // post-fix strips are fresh (same-frame canvas-gesture hook re-places
        // after the flush). Pass = every sample within 1.5px of priceToY.
        const ui9 = await js(`(async () => {
          const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
          const q = (s) => document.querySelector(s);
          const qa = (s) => [...document.querySelectorAll(s)];
          const fail = (step, extra = {}) => ({ ok: false, step, ...extra });
          const wl = window.__wanderlust;
          if (!wl) return fail('no-e2e-handle');
          const shell = wl.chart;
          const renderer = [shell?.rendererControl?.renderer, shell?.renderer, shell?.orchestrator?.renderer]
            .find((rr) => rr && rr.scene && rr.coords);
          if (!renderer) return fail('no-renderer');
          const pane = [...(renderer.scene?.panes?.values() ?? [])].find((p) => p.kind === 'price');
          if (!pane) return fail('no-pane');
          const dataCanvas = renderer.dataCanvas?.tagName === 'CANVAS' ? renderer.dataCanvas : null;
          if (!dataCanvas) return fail('no-canvas');
          const entryEl = q('[data-testid="order-level-entry"]');
          const slEl = q('[data-testid="order-level-stopLoss"]');
          const tpEl = q('[data-testid="order-level-takeProfit"]');
          const root = slEl?.parentElement;
          if (!root) return fail('no-root');
          const label = (kind) => q('[data-testid="order-level-' + kind + '-price"]')?.textContent?.trim() ?? null;
          const labelsBefore = ['entry', 'stopLoss', 'takeProfit'].map((k) => k + ':' + label(k));
          const STRIP_HALF = 6;
          const levelEls = { entry: entryEl, stopLoss: slEl, takeProfit: tpEl };
          const stopTxt = label('stopLoss');
          const entryTxt = label('entry');
          const tpTxt = label('takeProfit');
          // True (full-precision) order prices the overlay places strips at —
          // exposed by the overlay's hash-gated debug handle. The 5dp LABEL
          // rounds the SL price (a yToPrice float with extra decimals), which
          // at the zoom-left ultra-tight scale reads as several px — an
          // artifact of comparing against the rounded label. The strips are
          // glued to the TRUE price; sample against THAT.
          const truePrice = (kind) => {
            const specs = window.__wanderlustLevels?.specs ?? [];
            const s = specs.find((x) => x.level === kind);
            return s ? s.price : NaN;
          };
          if (![truePrice('entry'), truePrice('stopLoss'), truePrice('takeProfit')].every(Number.isFinite)) return fail('no-specs');
          // A single sample: strip DOM Y (through the overlay origin) vs the exact
          // priceToY math Vela's painter AND the drawing tool use, at THIS instant.
          const sample = () => {
            const rootRect = root.getBoundingClientRect();
            const out = [];
            for (const kind of ['entry', 'stopLoss', 'takeProfit']) {
              const el = levelEls[kind];
              if (!el) { out.push({ kind, miss: true }); continue; }
              const price = truePrice(kind);
              const expTop = (renderer.dataCanvas?.getBoundingClientRect().top ?? rootRect.top) - rootRect.top + renderer.coords.priceToY(price, pane.scale, pane.bounds) - STRIP_HALF;
              const actTop = el.getBoundingClientRect().top - rootRect.top;
              out.push({ kind, exp: Math.round(expTop * 10) / 10, act: Math.round(actTop * 10) / 10, d: Math.round((actTop - expTop) * 10) / 10 });
            }
            return out;
          };
          const maxD = (s) => s.every((d) => !d.miss) ? Math.max(...s.map((d) => Math.abs(d.d))) : Infinity;
          const almost = (v) => Math.round(v * 1000) / 1000;
          const cRect = dataCanvas.getBoundingClientRect();
          const W = cRect.width, H = cRect.height;
          const pt = (rx, ry) => ({ clientX: cRect.left + rx, clientY: cRect.top + ry });
          let pid = 101;
          const press = (rx, ry) => {
            const p = pt(rx, ry);
            dataCanvas.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerId: pid, pointerType: 'mouse', clientX: p.clientX, clientY: p.clientY, button: 0, buttons: 1 }));
            return { x: rx, y: ry };
          };
          const moveTo = (state, rx, ry) => {
            const p = pt(rx, ry);
            dataCanvas.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, cancelable: true, pointerId: pid, pointerType: 'mouse', clientX: p.clientX, clientY: p.clientY, button: 0, buttons: 1 }));
            state.x = rx; state.y = ry;
          };
          const release = (state) => {
            const p = pt(state ? state.x : 0, state ? state.y : 0);
            dataCanvas.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, pointerId: pid, pointerType: 'mouse', clientX: p.clientX, clientY: p.clientY, button: 0, buttons: 0 }));
            pid += 1;
          };
          const rafOnce = () => new Promise((r) => requestAnimationFrame(r));
          const viewportChanged = (v0) => {
            const v = renderer.coords.getViewport();
            return v && (v.barSpacing !== v0.barSpacing || v.rightOffset !== v0.rightOffset);
          };
          const results = {};
          const scalePhotograph = () => ({ min: pane.scale.min, max: pane.scale.max, vp: renderer.coords.getViewport() });
          const scaleChangedSince = (p0) => p0 && (pane.scale.min !== p0.min || pane.scale.max !== p0.max);

          // Reset to AUTOSCALE (ui8's wheel zoom left it null) so pan/time drags
          // recompute the scale from the visible bars.
          pane.manualScale = null;
          await sleep(180);

          // ── (1) DATA-AREA DRAG-PAN (applyViewport + autoscale recompute) ──
          {
            const p0 = scalePhotograph();
            const s = press(W * 0.55, H * 0.45);
            // BATCH: 6 moves, zero frames between → one scheduler flush paints a
            // NEW scale while a bare rAF loop would still write the PRE-batch one.
            for (let i = 0; i < 6; i++) moveTo(s, s.x + (i + 1) * 20, s.y);
            await rafOnce(); // exactly one frame after the batch
            const batch = sample();
            const vpAfter = viewportChanged(p0.vp);
            const scaleAfter = scaleChangedSince(p0);
            // INTERLEAVED continuation of the same drag (real-gesture cadence).
            const inter = [];
            for (let i = 0; i < 6; i++) {
              moveTo(s, s.x + 120 + (i + 1) * 14, s.y);
              await rafOnce();
              const sm = sample();
              inter.push({ i, maxD: maxD(sm), d: sm, min: almost(pane.scale.min), max: almost(pane.scale.max) });
            }
            const scaleMid = scaleChangedSince(p0);
            release();
            await sleep(180);
            const settle = sample();
            results.pan = {
              batchD: batch, batchMaxD: maxD(batch), vpChanged: !!vpAfter, scaleChanged: !!scaleAfter,
              interMaxD: inter.length ? Math.max(...inter.map((x) => x.maxD)) : Infinity, inter,
              settleMaxD: maxD(settle), settle, interSawScale: !!scaleMid
            };
          }

          // ── (2) TIME-AXIS ZOOM DRAG (bottom strip → applyViewport) ──
          {
            const p0 = scalePhotograph();
            const s = press(W * 0.55, H - 10); // inside the 22px time-axis strip
            for (let i = 0; i < 6; i++) moveTo(s, s.x - (i + 1) * 18, s.y);
            await rafOnce();
            const batch = sample();
            const vpChanged = viewportChanged(p0.vp);
            const inter = [];
            for (let i = 0; i < 5; i++) {
              moveTo(s, s.x - 108 - (i + 1) * 12, s.y);
              await rafOnce();
              inter.push({ i, maxD: maxD(sample()) });
            }
            release();
            await sleep(180);
            results.time = { batchMaxD: maxD(batch), batch, vpChanged, interMaxD: inter.length ? Math.max(...inter.map((x) => x.maxD)) : Infinity };
          }

          // ── (3) PRICE-AXIS SCALE DRAG (right strip → setManualScale) ──
          {
            const p0 = scalePhotograph();
            const s = press(W - 32, H * 0.45); // inside the 64px price axis
            for (let i = 0; i < 6; i++) moveTo(s, s.x, s.y + (i + 1) * 16);
            await rafOnce();
            const batch = sample();
            const inter = [];
            for (let i = 0; i < 5; i++) {
              moveTo(s, s.x, s.y + 96 + (i + 1) * 12);
              await rafOnce();
              inter.push({ i, maxD: maxD(sample()) });
            }
            release();
            await sleep(180);
            results.price = { batchMaxD: maxD(batch), batch, interMaxD: inter.length ? Math.max(...inter.map((x) => x.maxD)) : Infinity, manual: pane.manualScale != null };
          }

          // ── FINAL: everything settles back to an EXACT position, and the
          // drag gestures must NOT have changed any order prices ──
          const finalSample = sample();
          const finalExact = finalSample.every((d) => !d.miss && Math.abs(d.d) <= 1.5);
          const labelsAfter = ['entry', 'stopLoss', 'takeProfit'].map((k) => k + ':' + label(k));
          const pricesStable = labelsAfter.every((lab) => labelsBefore.includes(lab));
          const rawLevels = window.__wanderlustLevels ?? null;
          const dbgLevels = rawLevels ? { ...rawLevels } : null;
          if (dbgLevels) { delete dbgLevels.rendererObj; delete dbgLevels.ySnap; }
          const T = 1.5;
          const ok = results.pan.batchMaxD <= T && results.pan.interMaxD <= T && results.pan.settleMaxD <= T
            && results.time.batchMaxD <= T && results.time.interMaxD <= T
            && results.price.batchMaxD <= T && results.price.interMaxD <= T
            && finalExact && pricesStable;
          return {
            ok, step: 'final',
            pan: results.pan, time: results.time, price: results.price,
            finalExact, finalSample, pricesStable,
            canvasEv: dbgLevels?.canvasEv ?? null, dbg: dbgLevels
          };
        })()`)
        await shot('/tmp/opencode/wanderlust-10-dragglue.png')
        note('ui9', ui9)

        // ---- 4j. Regression for "the lines deviate from the Order's entry/tp/sl
        // price". A position tool seeds an order, but it must NOT remain linked
        // afterward: changing either one must not mutate the other.
        // ui10 replays the user's exact session — draw tool → New Order →
        // playback fill → edit the tool's anchor → drag a strip — and asserts a
        // static order levels remain pixel-exact through fills, tool edits,
        // strip drags and zooming.
        const ui10 = await js(`(async () => {
          const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
          const q = (s) => document.querySelector(s);
          const qa = (s) => [...document.querySelectorAll(s)];
          const text = (s) => q(s)?.textContent?.trim() ?? null;
          const click = (s) => { const el = q(s); if (!el) return false; const o = { bubbles: true, cancelable: true, pointerId: 1, button: 0 }; el.dispatchEvent(new PointerEvent('pointerdown', { ...o, buttons: 1 })); el.dispatchEvent(new MouseEvent('mousedown', { ...o, buttons: 1 })); el.dispatchEvent(new PointerEvent('pointerup', { ...o, buttons: 0 })); el.dispatchEvent(new MouseEvent('mouseup', { ...o, buttons: 0 })); el.click(); return true; };
          const wl = window.__wanderlust;
          if (!wl) return ({ ok: false, step: 'no-e2e-handle' });
          const renderer = [wl.chart?.rendererControl?.renderer, wl.chart?.renderer, wl.chart?.orchestrator?.renderer]
            .find((rr) => rr && rr.scene && rr.coords);
          if (!renderer) return ({ ok: false, step: 'no-renderer' });
          const pane = [...(renderer.scene?.panes?.values() ?? [])].find((p) => p.kind === 'price');
          if (!pane) return ({ ok: false, step: 'no-pane' });
          const root = q('[data-testid="order-level-stopLoss"]')?.parentElement ?? null;
          if (!root) return ({ ok: false, step: 'no-root' });
          const STRIP_HALF = 6;
          const anchorsOf = (id) => {
            const d = wl.chart.drawings.all().find((dd) => dd.id === id);
            if (!d || !d.anchors || d.anchors.length < 3) return null;
            return { entry: d.anchors[0].price, stop: d.anchors[1].price, target: d.anchors[2].price };
          };
          const specsOf = (orderId) => {
            const lv = window.__wanderlustLevels?.specs ?? [];
            return {
              entry: lv.find((s) => s.orderId === orderId && s.level === 'entry')?.price ?? NaN,
              stop: lv.find((s) => s.orderId === orderId && s.level === 'stopLoss')?.price ?? NaN,
              target: lv.find((s) => s.orderId === orderId && s.level === 'takeProfit')?.price ?? NaN
            };
          };
          const stripEl = (orderId, kind) => qa('[data-testid="order-level-' + kind + '"]').find((el) => el.dataset.orderId === orderId) ?? null;
          const stripGap = (orderId, kind, price) => {
            const el = stripEl(orderId, kind);
            if (!el) return Infinity;
            const expTop = (renderer.dataCanvas?.getBoundingClientRect().top ?? root.getBoundingClientRect().top) - root.getBoundingClientRect().top + renderer.coords.priceToY(price, pane.scale, pane.bounds) - STRIP_HALF;
            const actTop = el.getBoundingClientRect().top - root.getBoundingClientRect().top;
            return Math.round((actTop - expTop) * 10) / 10;
          };
          const labelOf = (orderId, kind) => stripEl(orderId, kind)?.querySelector('[data-testid="order-level-' + kind + '-price"]')?.textContent?.trim() ?? null;
          const orderOf = (drawingId) => (wl.orders() ?? []).find((o) => o.drawingId === drawingId) ?? null;
          const idxText = () => Number((text('[data-testid="playback-index"]') ?? '').trim());
          const cur0 = idxText();
          if (!Number.isFinite(cur0)) return ({ ok: false, step: 'no-index' });
          const res = await window.api.getCachedData({ symbol: 'eurusd', timeframe: 'm1', startDate: '2026-09-01', endDate: '2026-09-02' });
          const candles = res.candles ?? [];
          const stepTo = async (n) => {
            for (let i = 0; i < n * 4 + 10; i++) {
              if (idxText() === n) return true;
              if (!click('[data-testid="playback-step"]')) return false;
              await sleep(60);
            }
            return idxText() === n;
          };
          // Advance so this test draws on a FRESH candle; on the way the ui8
          // market order fills (exercising filled-state pricing too).
          const cur = cur0 + 3;
          if (!(await stepTo(cur))) return ({ ok: false, step: 'step', cur0, cur, now: idxText() });
          const cE = candles[cur];
          if (!cE) return ({ ok: false, step: 'no-candle', cur });
          // Keep ui9's manual frame for phases A–D so every strip sits in view
          // (wide SL/TP buffers below); autoscale is restored only at phase E.

          // ── A. Draw the tool + MARKET New Order (the toolbar flow exactly) ──
          // Wide SL/TP buffers: the order fills on candle cur (the first candle
          // evaluated after submission) and is then watched on cur+1 — the
          // levels must NOT be hit across those two candles or the order closes
          // before we can assert its filled state.
          const entryA = cE.close, stopA = cE.low - 0.02, targetA = cE.high + 0.02;
          const did = wl.addPosition({ entry: entryA, stop: stopA, target: targetA, time: cE.timestamp });
          if (!did) return ({ ok: false, step: 'place' });
          wl.chart.drawings.select(did);
          await sleep(150);
          if (!text('[data-testid="selected-position"]')) return ({ ok: false, step: 'no-chip' });
          click('[data-testid="new-order-btn"]');
          await sleep(300);
          click('[data-testid="confirm-order"]');
          await sleep(250);
          const orderA = orderOf(did);
          if (!orderA) return ({ ok: false, step: 'no-order' });
          // A pending MARKET order is anchored to the latest revealed close for
          // its entry (it will fill on the next evaluated candle), while its
          // SL/TP stay locked to the seeding tool. The overlay draws the strip
          // from the order fields, so assert the strip against THOSE.
          const entryPx = orderA.fillPrice ?? orderA.orderPrice;
          const A = {
            draw: anchorsOf(did), order: orderA, specs: specsOf(orderA.id),
            gaps: { entry: stripGap(orderA.id, 'entry', entryPx), stop: stripGap(orderA.id, 'stopLoss', stopA), target: stripGap(orderA.id, 'takeProfit', targetA) },
            labels: { entry: labelOf(orderA.id, 'entry'), stop: labelOf(orderA.id, 'stopLoss'), target: labelOf(orderA.id, 'takeProfit') }
          };
          const Aok = !!A.draw && orderA.stopLoss === stopA && orderA.takeProfit === targetA
            && A.specs.entry === entryPx && A.specs.stop === stopA && A.specs.target === targetA
            && Math.max(A.gaps.entry, A.gaps.stop, A.gaps.target) <= 1.5;

          // ── B. FILL (2 candles; the market order enters at the open of
          // candle cur — the first one evaluated after submission) ──
          if (!(await stepTo(cur + 2))) return ({ ok: false, step: 'step-fill', now: idxText() });
          await sleep(300);
          const orderB = orderOf(did);
          const targetFillOpen = candles[cur]?.open ?? NaN;
          const B = {
            order: orderB, specs: specsOf(orderB?.id ?? ''), targetFillOpen,
            draw: anchorsOf(did),
            gaps: { entry: stripGap(orderB?.id ?? '', 'entry', targetFillOpen), stop: stripGap(orderB?.id ?? '', 'stopLoss', stopA), target: stripGap(orderB?.id ?? '', 'takeProfit', targetA) },
            labelEntry: labelOf(orderB?.id ?? '', 'entry')
          };
          const Bok = !!orderB && orderB.status === 'filled'
            && orderB.fillPrice === targetFillOpen
            && B.draw?.entry === entryA
            && B.specs.entry === targetFillOpen && B.specs.stop === stopA && B.specs.target === targetA
            && B.gaps.entry <= 1.5 && B.gaps.stop <= 1.5 && B.gaps.target <= 1.5;

          // ── C. Edit the TOOL's stop anchor → order and strip stay unchanged ──
          const stop2 = Math.round((stopA - 0.001) * 1e6) / 1e6;
          const aNow = anchorsOf(did);
          wl.chart.drawings.update(did, { anchors: [
            { time: cE.timestamp, price: aNow.entry },
            { time: cE.timestamp, price: stop2 },
            { time: cE.timestamp, price: aNow.target }
          ] });
          await sleep(350);
          const orderC = orderOf(did);
          const C = {
            draw: anchorsOf(did), order: orderC, specs: specsOf(orderC?.id ?? ''),
            gapStop: stripGap(orderC?.id ?? '', 'stopLoss', stopA),
            gapEntryUnchanged: stripGap(orderC?.id ?? '', 'entry', targetFillOpen),
            labelStop: labelOf(orderC?.id ?? '', 'stopLoss')
          };
          const Cok = !!orderC && !!C.draw && C.draw.stop === stop2 && orderC.stopLoss === stopA
            && C.specs.stop === stopA && C.specs.entry === targetFillOpen
            && C.gapStop <= 1.5 && C.gapEntryUnchanged <= 1.5;

          // ── D. Strip-DRAG the SL line → order moves; tool stays unchanged ──
          const slEl = stripEl(orderC?.id ?? '', 'stopLoss');
          if (!slEl) return ({ ok: false, step: 'no-sl-d' });
          const rD = slEl.getBoundingClientRect();
          const cxD = rD.left + rD.width / 2;
          const y0D = rD.top + rD.height / 2;
          slEl.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerId: 77, clientX: cxD, clientY: y0D, button: 0 }));
          slEl.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, cancelable: true, pointerId: 77, clientX: cxD, clientY: y0D + 24, button: 0 }));
          await sleep(120);
          slEl.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, pointerId: 77, clientX: cxD, clientY: y0D + 24, button: 0 }));
          await sleep(400);
          const orderD = orderOf(did);
          const drawD = anchorsOf(did);
          const rootTop = root.getBoundingClientRect().top;
          const canvasTop = renderer.dataCanvas?.getBoundingClientRect().top ?? rootTop;
          const yD = Math.min(pane.bounds.top + pane.bounds.height, Math.max(pane.bounds.top, y0D + 24 - rootTop - (canvasTop - rootTop)));
          const expectedStopD = renderer.coords.yToPrice(yD, pane.scale, pane.bounds);
          const D = {
            order: orderD, draw: drawD, specs: specsOf(orderD?.id ?? ''), expectedStop: expectedStopD,
            orderVsDraw: Math.abs((orderD?.stopLoss ?? NaN) - (drawD?.stop ?? NaN)) < 1e-9,
            gapStop: stripGap(orderD?.id ?? '', 'stopLoss', orderD?.stopLoss ?? NaN),
            labelStop: labelOf(orderD?.id ?? '', 'stopLoss')
          };
          const Dok = !!orderD && !!drawD && !D.orderVsDraw && drawD.stop === stop2
            && D.gapStop <= 1.5
            && Math.abs((orderD?.stopLoss ?? NaN) - expectedStopD) < 0.0002;

          // ── E. Still pixel-glued through an animated wheel-zoom ──
          pane.manualScale = null;
          await sleep(150);
          const dataCanvas = renderer.dataCanvas?.tagName === 'CANVAS' ? renderer.dataCanvas : null;
          const cRectE = dataCanvas ? dataCanvas.getBoundingClientRect() : null;
          const wheelAt = (dy) => {
            dataCanvas?.dispatchEvent(new WheelEvent('wheel', {
              deltaY: dy, deltaX: 0,
              clientX: (cRectE?.left ?? 0) + Math.max(120, (cRectE?.width ?? 0) * 0.3),
              clientY: (cRectE?.top ?? 0) + (cRectE?.height ?? 0) / 2,
              bubbles: true, cancelable: true
            }));
          };
          wheelAt(-560);
          const Eglues = [];
          for (let i = 0; i < 8; i++) {
            await sleep(25);
            Eglues.push(Math.max(
              stripGap(orderD?.id ?? '', 'entry', targetFillOpen),
              stripGap(orderD?.id ?? '', 'stopLoss', orderD?.stopLoss ?? NaN),
              stripGap(orderD?.id ?? '', 'takeProfit', targetA)
            ));
          }
          await sleep(350);
          const Eok = Eglues.every((g) => g <= 1.5);
          const ok = Aok && Bok && Cok && Dok && Eok;
          const rawLevels = window.__wanderlustLevels ?? null;
          const dbg = rawLevels ? { ...rawLevels } : null;
          if (dbg) { delete dbg.rendererObj; delete dbg.ySnap; delete dbg.specs; }
          return {
            ok, step: 'final', cur, cur0,
            A, Aok, B: { status: B?.order?.status ?? null, fillPrice: B?.order?.fillPrice ?? null, targetFillOpen: B.targetFillOpen, specs: B.specs, gaps: B.gaps, labelEntry: B.labelEntry }, Bok,
            C, Cok, D, Dok,
            E: { ok: Eok, maxGap: Math.max(...Eglues), glues: Eglues.slice(0, 4) },
            dbg
          };
        })()`)
        await shot('/tmp/opencode/wanderlust-11-anchors.png')
        note('ui10', ui10)

        // ---- 4l. Regression for the user's clarified repro: \"when i RESIZE the
        // chart VERTICALLY the lines moves and did NOT stay at the price level\".
        // Zoom/pan/axis-drag glue was covered by ui8/ui9; CONTAINER RESIZE was
        // never exercised. ui12 resizes the chart region (shrinks + restores both
        // height and width — the Vela ResizeObserver path) and asserts the strips
        // stay pixel-glued to their price (specs unchanged, gap <= 1.5px) DURING
        // the transition AND after settle, for BOTH orders' strips.
        const ui12 = await js(`(async () => {
          const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
          const q = (s) => document.querySelector(s);
          const qa = (s) => [...document.querySelectorAll(s)];
          const wl = window.__wanderlust;
          if (!wl) return ({ ok: false, step: 'no-e2e-handle' });
          const renderer = [wl.chart?.rendererControl?.renderer, wl.chart?.renderer, wl.chart?.orchestrator?.renderer]
            .find((rr) => rr && rr.scene && rr.coords);
          if (!renderer) return ({ ok: false, step: 'no-renderer' });
          const pane = [...(renderer.scene?.panes?.values() ?? [])].find((p) => p.kind === 'price');
          if (!pane) return ({ ok: false, step: 'no-pane' });
          const root = q('[data-testid="order-level-stopLoss"]')?.parentElement ?? null;
          if (!root) return ({ ok: false, step: 'no-root' });
          const host = q('[data-testid="vela-container"]')?.parentElement ?? null;
          if (!host) return ({ ok: false, step: 'no-host' });
          const STRIP_HALF = 6;
          // GROUND-TRUTH dump: every strip element in the DOM, every order in the
          // store, every drawing on the chart, and the overlay's last spec list.
          const dumpState = () => ({
            strips: qa('[data-testid^="order-level-"]').map((el) => ({
              testid: el.dataset.testid,
              orderId: el.dataset.orderId,
              label: el.querySelector('[data-testid$="-price"]')?.textContent?.trim() ?? null,
              y: Math.round(el.getBoundingClientRect().top * 10) / 10
            })),
            orders: (wl.orders() ?? []).map((o) => ({
              id: o.id, drawingId: o.drawingId, status: o.status, orderPrice: o.orderPrice,
              stopLoss: o.stopLoss, takeProfit: o.takeProfit, fillPrice: o.fillPrice
            })),
            drawings: wl.chart.drawings.all().map((d) => ({
              id: d.id, type: d.type,
              anchors: d.anchors.map((a) => a.price)
            })),
            specs: window.__wanderlustLevels?.specs ?? null
          });
          const kinds = ['entry', 'stopLoss', 'takeProfit'];
          // Price the overlay DRAWS for a level: the order's own field is the
          // ground truth (a submitted order is independent of the seeding
          // drawing), falling back to the drawing anchor only when the order
          // field is missing. (Never trusts only dbg.specs — the point is to
          // FIND the divergence.)
          const anchorPrice = (a) => {
            // Anchors come back as {time, price} objects (or plain numbers when
            // freshly patched). Normalize to a plain number either way.
            if (a && typeof a === 'object' && 'price' in a) return a.price
            return a
          };
          const priceOf = (o, d, kind) => {
            const field =
              kind === 'entry' ? (o.fillPrice ?? o.orderPrice) : kind === 'stopLoss' ? o.stopLoss : o.takeProfit
            if (Number.isFinite(field) && field > 0) return field
            if (d) {
              if (kind === 'entry') return anchorPrice(d.anchors[0])
              if (kind === 'stopLoss') return anchorPrice(d.anchors[1])
              return anchorPrice(d.anchors[2])
            }
            return field
          };
          const stripEl = (orderId, kind) => qa('[data-testid="order-level-' + kind + '"]').find((el) => el.dataset.orderId === orderId) ?? null;
          const stripGap = (el, price) => {
            if (!el || !Number.isFinite(price) || price <= 0) return null;
            const expTop = (renderer.dataCanvas?.getBoundingClientRect().top ?? root.getBoundingClientRect().top) - root.getBoundingClientRect().top + renderer.coords.priceToY(price, pane.scale, pane.bounds) - STRIP_HALF;
            const actTop = el.getBoundingClientRect().top - root.getBoundingClientRect().top;
            return Math.round((actTop - expTop) * 10) / 10;
          };
          const orders = (wl.orders() ?? []).filter((o) => o.status === 'pending' || o.status === 'filled');
          const sample = () => {
            const out = [];
            for (const o of orders) {
              const d = wl.chart.drawings.all().find((dd) => dd.id === o.drawingId) ?? null;
              for (const k of kinds) {
                const el = stripEl(o.id, k);
                out.push({
                  orderId: o.id, kind: k, hasEl: !!el,
                  price: priceOf(o, d, k),
                  gap: stripGap(el, priceOf(o, d, k))
                });
              }
            }
            return out;
          };
          const numericGaps = (rows) => rows.map((r) => r.gap).filter((g) => g !== null && Number.isFinite(g));
          const maxGap = (rows) => {
            const g = numericGaps(rows);
            return g.length ? Math.max(...g.map((v) => Math.abs(v))) : null;
          };
          const allElsPresent = (rows) => rows.every((r) => r.hasEl);
          const hostRect0 = host.getBoundingClientRect();
          const H0 = hostRect0.height, W0 = hostRect0.width;
          const startDump = dumpState();
          pane.manualScale = null;
          await sleep(220);
          const baseAuto = sample();
          const specBefore = JSON.stringify(sample().map((r) => ({ orderId: r.orderId, k: r.kind, p: r.price })));
          const tries = [];
          const axis = (rows) => ({ max: maxGap(rows), per: rows.map((r) => ({ k: r.kind, g: r.gap })) });
          // ── vertical shrink (resize the chart region down by ~28%) ──
          host.style.height = Math.round(H0 * 0.72) + 'px';
          tries.push(axis(sample()));
          for (let i = 0; i < 9; i++) { tries.push(axis(sample())); await sleep(30); }
          await sleep(350);
          const afterShrink = sample();
          const boundsShrink = { top: pane.bounds.top, height: pane.bounds.height };
          // ── restore height ──
          host.style.height = H0 + 'px';
          tries.push(axis(sample()));
          for (let i = 0; i < 9; i++) { tries.push(axis(sample())); await sleep(30); }
          await sleep(350);
          const afterRestoreH = sample();
          const boundsRestoreH = { top: pane.bounds.top, height: pane.bounds.height };
          // ── horizontal shrink ──
          host.style.width = Math.round(W0 * 0.8) + 'px';
          tries.push(axis(sample()));
          for (let i = 0; i < 9; i++) { tries.push(axis(sample())); await sleep(30); }
          await sleep(350);
          const afterShrinkW = sample();
          host.style.width = W0 + 'px';
          await sleep(350);
          const afterRestoreW = sample();
          const specAfter = JSON.stringify(sample().map((r) => ({ orderId: r.orderId, k: r.kind, p: r.price })));
          const stages = [baseAuto, afterShrink, afterRestoreH, afterShrinkW, afterRestoreW];
          const duringGlitches = tries
            .map((t) => (t.per ?? []).filter((p) => p.g !== null && Math.abs(p.g) > 1.5))
            .flat();
          const ok = stages.every((s) => maxGap(s) !== null && maxGap(s) <= 1.5 && allElsPresent(s))
            && duringGlitches.length === 0
            && specBefore === specAfter;
          return {
            ok, step: 'final', H0, W0,
            start: startDump,
            maxGapBaseAuto: maxGap(baseAuto), allElsBase: allElsPresent(baseAuto),
            duringGlitches,
            tries: tries.map((t) => ({ max: t.max, per: t.per })),
            bounds: [{ when: 'start', top: pane.bounds.top, h: Number.isFinite(pane.bounds.height) ? pane.bounds.height : 0 }, boundsShrink, boundsRestoreH],
            afterShrink: { maxGap: maxGap(afterShrink), allEls: allElsPresent(afterShrink), rows: afterShrink },
            afterRestoreH: { maxGap: maxGap(afterRestoreH), allEls: allElsPresent(afterRestoreH) },
            afterShrinkW: { maxGap: maxGap(afterShrinkW), allEls: allElsPresent(afterShrinkW) },
            afterRestoreW: { maxGap: maxGap(afterRestoreW), allEls: allElsPresent(afterRestoreW) },
            pricesStable: specBefore === specAfter,
            orders: orders.map((o) => o.id)
          };
        })()`)
        await shot('/tmp/opencode/wanderlust-12-resize.png')
        note('ui12', ui12)

        console.log('[e2e] shell      =', JSON.stringify(shellDom))
        console.log('[e2e] download#1 =', JSON.stringify(download1))
        console.log(
          '[e2e] readback   =',
          JSON.stringify({ ok: readback.ok, count: readback.count })
        )
        console.log('[e2e] summary    =', JSON.stringify(summary1))
        console.log('[e2e] download#2 =', JSON.stringify(download2))
        console.log('[e2e] batch      =', JSON.stringify(batch))
        console.log('[e2e] summary2   =', JSON.stringify(summary2))
        console.log('[e2e] ui journey =', JSON.stringify(ui))
        console.log('[e2e] ui2 grace  =', JSON.stringify(ui2))
        console.log('[e2e] ui3 orders =', JSON.stringify(ui3))
        console.log('[e2e] ui4 select =', JSON.stringify(ui4))
        console.log('[e2e] ui5 viewpt =', JSON.stringify(ui5))
        console.log('[e2e] ui6 playv  =', JSON.stringify(ui6))
        console.log('[e2e] ui7 freev =', JSON.stringify(ui7))
        console.log('[e2e] ui8 overlay =', JSON.stringify(ui8))
        console.log('[e2e] ui9 dragglue =', JSON.stringify(ui9))
        console.log('[e2e] ui10 anchors =', JSON.stringify(ui10))
        console.log('[e2e] ui12 resize =', JSON.stringify(ui12))
        console.log('[e2e] console   =', JSON.stringify(consoleLogs.slice(-8)))
        console.log('[e2e] console-ui =', JSON.stringify(consoleLogs.slice(logsBefore).slice(0, 6)))
        console.log(
          '[e2e] screenshots: /tmp/opencode/wanderlust-{1-empty,2-session,3-runup-grace,4-trading,5-selection,6-viewport,7-playback-view,8-freeview,9-overlay,10-dragglue,11-anchors,12-resize}.png'
        )
      } catch (err) {
        console.error('[e2e] FAILED', err)
        trace.push({ phase: 'FAILED', at: Date.now(), detail: String(err) })
      } finally {
        clearTimeout(watchdog)
        await writeTrace()
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
