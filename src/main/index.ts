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
            buttons: [...document.querySelectorAll('button')].map((b) => b.textContent?.trim())
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

              // 4b. Go To: jump to 2024-01-04 → the index must land inside the
              // second day (~1440 of ~2880 m1 candles) and the chart repaint.
              const gd = document.querySelector('[data-testid="playback-goto-date"]');
              if (!gd) return { ok: false, step: 'no-goto-input', diag: diag() };
              setVal(gd, '2024-01-04');
              await sleep(150);
              const gb = document.querySelector('[data-testid="playback-goto-btn"]');
              if (!gb) return { ok: false, step: 'no-goto-btn', diag: diag() };
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
              // advance while playing, then Pause freezes it.
              const spd = document.querySelector('[data-testid="playback-speed"]');
              if (spd) {
                setVal(spd, '120');
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
          const click = (s) => { const el = q(s); if (!el) return false; el.click(); return true; };
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
        console.log('[e2e] console   =', JSON.stringify(consoleLogs.slice(-8)))
        console.log('[e2e] console-ui =', JSON.stringify(consoleLogs.slice(logsBefore).slice(0, 6)))
        console.log(
          '[e2e] screenshots: /tmp/opencode/wanderlust-{1-empty,2-session,3-runup-grace,4-trading}.png'
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
