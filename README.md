# Wanderlust

Wanderlust is an open-source, desktop-based backtesting application for trading. It allows traders to test their trading strategies on historical market data and analyze their performance. It is modeled after FX Replay but runs fully offline: market data is downloaded on-demand from Dukascopy and cached locally, so there are no server costs and no subscription paywalls.

> **Status: Phase 1 complete** — environment scaffold + IPC plumbing. See [Work in progress](#work-in-progress).

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
│   ├── dukascopy.ts       # Dukascopy fetcher (stub — Phase 2)
│   └── smoke.ts           # Dev-only SQLite smoke test
├── preload/
│   ├── index.ts           # contextBridge exposing window.api.*
│   └── index.d.ts         # Typed contract for window.api
└── renderer/
    └── src/
        ├── App.tsx        # Phase 1 IPC smoke-test panel (temporary UI)
        ├── components/ui/ # shadcn/ui components
        └── assets/main.css# Tailwind v4 + shadcn theme tokens
```

## IPC Contract (Phase 1)

Exposed to the renderer as `window.api` via the preload bridge:

| Channel | Direction | Purpose |
| --- | --- | --- |
| `data:download` | renderer → main | Cache-first download of a range (`window.api.downloadData`) |
| `data:get-cached` | renderer → main | Query candles already cached (`window.api.getCachedData`) |
| `data:cache-summary` | renderer → main | List cached (symbol, timeframe) ranges (`window.api.getCacheSummary`) |
| `data:download-progress` | main → renderer | Progress events streamed while downloading (`window.api.onDownloadProgress`) |

The SQLite cache lives at `app.getPath('userData')/wanderlust-cache.db` with a `cached_candles`
table keyed on `(symbol, timeframe, timestamp)`.

## Dev Verification

These env-guarded hooks exercise the real stack on the built app:

```bash
# SQLite layer only (insert → query → summarize → cleanup) against real Electron runtime
WANDERLUST_SMOKE=1 ./node_modules/electron/dist/electron .

# Full round trip: real renderer → preload → IPC → SQLite (+ DOM assertions + screenshot)
WANDERLUST_E2E=1 ./node_modules/electron/dist/electron .
```

## Notes & Gotchas

- **`dukascopy-node` runs only in the Electron main process.** The renderer cannot call Dukascopy directly (CORS + Node-only filesystem/network deps); everything goes through the IPC handlers above.
- **Native module rebuilds.** `better-sqlite3` is compiled against Electron's ABI. `npm install` already runs `electron-builder install-app-deps` as a postinstall; run `npm run rebuild` manually after upgrading Electron or Node.
- **npm 12 script blocking.** npm 12+ may block `electron`'s postinstall (it downloads the Electron binary). If `npm run dev` fails with "Electron failed to install correctly" or a `dist/electron` spawn error, run `npm install-scripts approve electron` (plus `npx electron --version` to confirm) and reinstall.
- **shadcn/ui layout.** The shadcn CLI can't auto-detect electron-vite's folder layout, so `components.json` is maintained manually (source of truth for the `@/*` → `src/renderer/src/*` alias). Adding new components with `npx shadcn add <name>` works, but the CLI writes files under a literal `@/` folder — move them to `src/renderer/src/components/` afterwards.

## Work in Progress

- **Phase 1 (done):** electron-vite scaffold, dependencies (Zustand, Vela, lucide-react, shadcn/ui, better-sqlite3, dukascopy-node), IPC handlers + preload bridge, SQLite cache schema.
- **Phase 2 (next):** on-demand Dukascopy fetching (`getHistoricalRates` in `src/main/dukascopy.ts`) with progress events and cache-first dedupe.
- **Phase 3:** asset selector UI + Vela chart workspace.
- **Phase 4:** playback loop.
- **Phase 5:** trade execution & position management.
- **Phase 6:** analytics & journaling.