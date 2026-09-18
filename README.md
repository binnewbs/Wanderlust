# Wanderlust

Wanderlust is an open-source, desktop-based backtesting application for trading. It allows traders to test their trading strategies on historical market data and analyze their performance. It is modeled after FX Replay but runs fully offline: market data is downloaded on-demand from Dukascopy and cached locally, so there are no server costs and no subscription paywalls.

> **Status: Phase 2 complete** — on-demand Dukascopy downloads with day-level caching and progress events. See [Work in progress](#work-in-progress).

## Tech Stack

- **App shell:** Electron (Node.js backend for file/DB access and network requests)
- **Frontend:** React + Vite + TypeScript (`electron-vite`)
- **State management:** Zustand
- **Charting:** `@luxalgo/vela` + `@luxalgo/vela/workspace`
- **Local cache:** SQLite (`better-sqlite3`, via Electron IPC)
- **Data fetching:** `dukascopy-node` (main process only)
- **UI kit:** Tailwind CSS v4 + shadcn/ui

## Getting Started

```bash
npm install
npm run dev
```

Other scripts:

| Script | Purpose |
| --- | --- |
| `npm run dev` | Start the Electron app in development (HMR enabled) |
| `npm run build` | Typecheck + build main / preload / renderer into `out/` |
| `npm run typecheck` | Typecheck main (`tsconfig.node.json`) + renderer (`tsconfig.web.json`) |
| `npm run lint` / `npm run format` | ESLint / Prettier |
| `npm run rebuild` | Rebuild `better-sqlite3` against Electron's ABI (only needed after Node/Electron upgrades) |
| `npm run build:linux` / `build:win` / `build:mac` | Package with electron-builder |

## Project Layout

```
src/
├── shared/ipc.ts          # IPC channel names + payload types (the contract)
├── main/
│   ├── index.ts           # App entry: window creation, lifecycle
│   ├── ipc.ts             # ipcMain.handle() registration (download / cache query / summary)
│   ├── db.ts              # SQLite cache (schema, query, upsert, summary)
│   ├── dukascopy.ts       # Dukascopy fetcher: per-day loop, cache skip, progress
│   └── smoke.ts           # Dev-only SQLite smoke test
├── preload/
│   ├── index.ts           # contextBridge exposing window.api.*
│   └── index.d.ts         # Typed contract for window.api
└── renderer/
    └── src/
        ├── App.tsx        # Phase 1/2 IPC smoke-test panel (temporary UI)
        ├── components/ui/ # shadcn/ui components
        └── assets/main.css# Tailwind v4 + shadcn theme tokens
```

## IPC Contract (Phase 2)

Exposed to the renderer as `window.api` via the preload bridge:

| Channel | Direction | Purpose |
| --- | --- | --- |
| `data:download` | renderer → main | Cache-first download of a range (`window.api.downloadData`) |
| `data:get-cached` | renderer → main | Query candles already cached (`window.api.getCachedData`) |
| `data:cache-summary` | renderer → main | List cached (symbol, timeframe) ranges (`window.api.getCacheSummary`) |
| `data:download-progress` | main → renderer | Progress events streamed while downloading (`window.api.onDownloadProgress`) |

`window.api.downloadData({ symbol, timeframe, startDate, endDate })` returns
`{ ok, candles, source, ... }` where `source` is `'cache'` (entire range already
stored), `'dukascopy'` (all fetched this call), or `'mixed'` (cached days reused
and missing days fetched).

The SQLite cache lives at `app.getPath('userData')/wanderlust-cache.db` with a
`cached_candles` table keyed on `(symbol, timeframe, timestamp)`.

## Dev Verification

These env-guarded hooks exercise the real stack on the built app:

```bash
# SQLite layer only (insert → query → summarize → cleanup) against real Electron runtime
WANDERLUST_SMOKE=1 ./node_modules/electron/dist/electron .

# Full round trip through the real renderer — needs a build (`npm run build`) and
# network access to Dukascopy for the first download:
#   1. downloadData     → 'dukascopy' (fresh) or 'mixed'/'cache' (partially cached)
#   2. getCachedData    → read what was persisted
#   3. getCacheSummary  → cached range shown
#   4. downloadData     → 'cache' (instant cache hit)
# Then asserts DOM + writes a screenshot to /tmp/opencode/wanderlust-ui.png
WANDERLUST_E2E=1 ./node_modules/electron/dist/electron .
```

## Notes & Gotchas

- **`dukascopy-node` runs only in the Electron main process.** The renderer cannot call Dukascopy directly (CORS + Node-only filesystem/network deps); everything goes through the IPC handlers above.
- **Downloads are fetched day-by-day** (`fetchFromDukascopy` in `src/main/dukascopy.ts`). Each day is served from SQLite when already cached, otherwise fetched from Dukascopy (UTC day boundaries, `to` is exclusive in dukascopy-node), with a short pause between network calls. This yields per-day progress events and lets partially-cached ranges fill only their gaps.
- **Rate limits.** Dukascopy may return HTTP 429 for bursts. The fetcher retries (3×, 750 ms apart) and pauses between days; very large ranges may still take a while. Empty trading days (weekends/holidays) return zero candles rather than errors (`retryOnEmpty: false`).
- **Native module rebuilds.** `better-sqlite3` is compiled against Electron's ABI. `npm install` already runs `electron-builder install-app-deps` as a postinstall; run `npm run rebuild` manually after upgrading Electron or Node.
- **npm 12 script blocking.** npm 12+ may block `electron`'s postinstall (it downloads the Electron binary). If `npm run dev` fails with "Electron failed to install correctly" or a `dist/electron` spawn error, run `npm install-scripts approve electron` (plus `npx electron --version` to confirm) and reinstall.
- **shadcn/ui layout.** The shadcn CLI can't auto-detect electron-vite's folder layout, so `components.json` is maintained manually (source of truth for the `@/*` → `src/renderer/src/*` alias). Adding new components with `npx shadcn add <name>` works, but the CLI writes files under a literal `@/` folder — move them to `src/renderer/src/components/` afterwards.

## Work in Progress

- **Phase 1 (done):** electron-vite scaffold, dependencies (Zustand, Vela, lucide-react, shadcn/ui, better-sqlite3, dukascopy-node), IPC handlers + preload bridge, SQLite cache schema.
- **Phase 2 (done):** on-demand Dukascopy fetching (`getHistoricalRates` in `src/main/dukascopy.ts`) — day-by-day loop with per-day cache skip, progress events, gap-fill merging (`source: cache | dukascopy | mixed`), and unknown-symbol/timeframe validation.
- **Phase 3 (next):** asset selector UI + Vela chart workspace.
- **Phase 4:** playback loop.
- **Phase 5:** trade execution & position management.
- **Phase 6:** analytics & journaling.