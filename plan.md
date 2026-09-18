# Local Backtesting Application: Architectural Blueprint

## Project Overview

This project is a localized, fully offline, desktop-based backtesting application modeled after FX Replay. It eliminates server costs, subscription paywalls, and feature limitations. Instead of storing massive amounts of data permanently, it features an on-demand data downloader that fetches market data directly from Dukascopy exactly when you need it for a specific backtesting session.

## Tech Stack

* **App Shell:** Electron (Node.js backend for file/DB access and network requests).
* **Frontend Framework:** React + Vite + TypeScript.
* **State Management:** Zustand (for playback time, account balance, active trades).
* **Charting Engine:** `@luxalgo/vela` and `@luxalgo/vela/workspace` (for charts and native drawing tools).
* **Local Database / Cache:** SQLite (using `better-sqlite3` via Electron IPC) to cache downloaded sessions.
* **Data Fetcher:** `dukascopy-node` (runs in the Electron Main Process to scrape data directly from Dukascopy).

## Phase 1: Environment Setup

1. Initialize a new Electron + Vite + React + TypeScript project (e.g., using `electron-vite`).
2. Install frontend dependencies: `zustand`, `@luxalgo/vela`, `lucide-react`, and `shadcn/ui` (for the download menus and date pickers).
3. Install backend dependencies: `better-sqlite3`, `dukascopy-node`.
4. Configure Electron IPC (Inter-Process Communication):
   * Create handlers in the `main` process for triggering Dukascopy downloads and querying the SQLite cache.
   * Expose these to the React frontend via a `preload` script (e.g., `window.api.downloadData()`, `window.api.getCachedData()`).

## Phase 2: On-Demand Dukascopy Fetching & Local Caching

**Goal:** Allow users to download specific assets and timeframes on the fly, caching them locally so they don't have to re-download the same period twice.

1. **The SQLite Cache Schema:**
   ```sql
   CREATE TABLE IF NOT EXISTS cached_candles (
       symbol TEXT NOT NULL,
       timestamp INTEGER NOT NULL,
       open REAL NOT NULL,
       high REAL NOT NULL,
       low REAL NOT NULL,
       close REAL NOT NULL,
       volume REAL NOT NULL,
       PRIMARY KEY (symbol, timestamp)
   );
   ```

2. **The Fetch Handler (Electron Main Process):**
   * Write an IPC handler `handleDownload(symbol, startDate, endDate)`.
   * First, check the SQLite database to see if this exact data already exists in the cache. If yes, return it instantly.
   * If not, use `dukascopy-node` to fetch the data. 
   * *Example implementation:*
     ```javascript
     import { getHistoricalData } from 'dukascopy-node';
     // Fetch 1m data for the requested dates
     const data = await getHistoricalData({
       instrument: symbol,
       dates: { from: startDate, to: endDate },
       timeframe: 'm1',
       format: 'json',
     });
     ```
   * Bulk-insert the returned JSON data into the `cached_candles` SQLite table.
   * Emit IPC events back to the frontend with download progress (e.g., "Downloading...", "Saving to cache...", "Ready").

## Phase 3: The Asset Selector & UI

**Goal:** Build the interface for starting a new backtest.

1. **New Session Menu:** Create a modal or dedicated screen in React where the user selects:
   * **Asset:** Dropdown menu mapping to Dukascopy tickers (e.g., `eurusd`, `gbpusd`, `xauusd`).
   * **Date Range:** Start Date and End Date pickers.
   * **Starting Balance:** (e.g., $100,000).
2. **Loading State:** When the user clicks "Start Session", display a progress bar. This UI will listen to the IPC progress events while the Electron backend runs `dukascopy-node`.
3. **Chart UI:** Once data is ready, initialize the `@luxalgo/vela/workspace` component and render the custom playback control panel (Play, Pause, Step Forward, Go To, Speed Slider).

## Phase 4: The Playback Loop (Core Logic)

**Goal:** Replicate the backtesting playback without server requests.

1. **Data Loading:** Transfer the requested dates from the SQLite cache to the frontend. Load this array into React/Zustand state (`masterCandleArray`).
2. **The Index:** Create a Zustand variable `currentIndex` (default 0).
3. **Rendering:** Feed Vela only a sliced array: `masterCandleArray.slice(0, currentIndex)`.
4. **Playback:**
   * When "Play" is clicked, run a `useRef` or `setInterval` loop that increments `currentIndex` by 1.
   * Update the chart data on each increment.
   * Adjust the interval delay based on the "Speed Slider".
5. **Unlimited Go To:** To jump to a specific date, find the index of that timestamp in `masterCandleArray` and set `currentIndex` to that value.

## Phase 5: Trade Execution & Position Management

**Goal:** Bridge Vela's visual tools with the simulated trading account.

1. **Visual Setup:** User selects the Long/Short Position tool in Vela and places it on the chart.
2. **Extraction:** When the user clicks "Execute Trade" in your UI:
   * Query Vela's object tree API to extract `entryPrice`, `stopLoss`, and `takeProfit`.
   * Calculate position size based on risk % and account balance.
3. **Active Trade State:** Store this trade in Zustand: `activeTrades`.
4. **Tick-by-Tick Evaluation:**
   * Inside the playback loop, check the *new* 1m candle's `high` and `low` against all `activeTrades`.
   * If `low <= stopLoss` (for a long): Close trade, record loss, update balance.
   * If `high >= takeProfit` (for a long): Close trade, record win, update balance.

## Phase 6: Analytics & Journaling

1. Create a `trade_history` table in SQLite to save completed trades.
2. Build an Analytics Dashboard view in React that queries this table to display Win Rate, Profit Factor, and an equity curve chart.

## Implementation Rules for Coding AI

* Use `dukascopy-node` specifically in the Electron Main Process. Browser environments (React) cannot run it directly due to CORS and Node-specific file system dependencies.
* Ensure the SQLite database operates purely as a cache to speed up subsequent loads of the same date ranges.
* Prioritize React performance. Use `useRef` for the playback loop interval to avoid unnecessary re-renders, updating the Zustand state and Vela chart directly.