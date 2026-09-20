# Local Backtesting Application: Architectural Blueprint

## Project Overview

This project is a localized, fully offline, desktop-based backtesting application modeled after FX Replay. It eliminates server costs, subscription paywalls, and feature limitations. Instead of storing massive amounts of data permanently, it features an on-demand data downloader that fetches market data directly from Dukascopy exactly when you need it for a specific backtesting session.

## Tech Stack

- **App Shell:** Electron (Node.js backend for file/DB access and network requests).
- **Frontend Framework:** React + Vite + TypeScript.
- **State Management:** Zustand (for playback time, account balance, active trades).
- **Charting Engine:** `@luxalgo/vela` and `@luxalgo/vela/workspace` (for charts and native drawing tools).
- **Local Database / Cache:** SQLite (using `better-sqlite3` via Electron IPC) to cache downloaded sessions.
- **Data Fetcher:** Dukascopy native-candle API — one `BID_candles_min_1.bi5` request/day/symbol (LZMA-decoded with `lzma-native` in the Electron Main Process); coarser timeframes derived locally. This replaced `dukascopy-node`, whose tick-based path tripped Dukascopy's rate limiter (HTTP 429).

## Phase 1: Environment Setup

1. Initialize a new Electron + Vite + React + TypeScript project (e.g., using `electron-vite`).
2. Install frontend dependencies: `zustand`, `@luxalgo/vela`, `lucide-react`, and `shadcn/ui` (for the download menus and date pickers).
3. Install backend dependencies: `better-sqlite3`, `lzma-native`.
4. Configure Electron IPC (Inter-Process Communication):
   - Create handlers in the `main` process for triggering Dukascopy downloads and querying the SQLite cache.
   - Expose these to the React frontend via a `preload` script (e.g., `window.api.downloadData()`, `window.api.getCachedData()`).

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
   - Write an IPC handler `handleDownload(symbol, startDate, endDate)`.
   - First, check the SQLite database to see if this exact data already exists in the cache. If yes, return it instantly.
   - If not, use the Dukascopy native candle feed (`src/main/dukascopy.ts` + `src/main/bi5.ts`).
   - _Example implementation:_
     ```typescript
     import { fetchFromDukascopy } from './main/dukascopy'
     // Fetchs a timeframe, caching per-day; native M1 files + local aggregation.
     const { candles } = await fetchFromDukascopy(
       { symbol, timeframe, startDate, endDate },
       (message, percent) => { /* stream progress to renderer */ }
     )
     ```
   - Bulk-insert the returned candles into the `cached_candles` SQLite table.
   - Emit IPC events back to the frontend with download progress (e.g., "Downloading...", "Saving to cache...", "Ready").

## Phase 3: The Asset Selector & UI

**Goal:** Build the interface for starting a new backtest.

1. **New Session Menu:** Create a modal or dedicated screen in React where the user selects:
   - **Asset:** Dropdown menu mapping to Dukascopy tickers (e.g., `eurusd`, `gbpusd`, `xauusd`).
   - **Date Range:** Start Date and End Date pickers.
   - **Starting Balance:** (e.g., $100,000).
2. **Loading State:** When the user clicks "Start Session", display a progress bar. This UI will listen to the IPC progress events while the Electron backend runs the Dukascopy fetcher (`src/main/dukascopy.ts`).
3. **Chart UI:** Once data is ready, initialize the `@luxalgo/vela/workspace` component and render the custom playback control panel (Play, Pause, Step Forward, Go To, Speed Slider).

## Phase 4: The Playback Loop (Core Logic)

**Goal:** Replicate the backtesting playback without server requests.

1. **Data Loading:** Transfer the requested dates from the SQLite cache to the frontend. Load this array into React/Zustand state (`masterCandleArray`).
2. **The Index:** Create a Zustand variable `currentIndex` (default 0).
3. **Rendering:** Feed Vela only a sliced array: `masterCandleArray.slice(0, currentIndex)`.
4. **Playback:**
   - When "Play" is clicked, run a `useRef` or `setInterval` loop that increments `currentIndex` by 1.
   - Update the chart data on each increment.
   - Adjust the interval delay based on the "Speed Slider".
5. **Unlimited Go To:** To jump to a specific date, find the index of that timestamp in `masterCandleArray` and set `currentIndex` to that value.

## Phase 5: Trade Execution & Position Management

**Goal:** Bridge Vela's visual tools with the simulated trading account.

1. **Visual Setup:** User selects the Long/Short Position tool in Vela and places it on the chart.
2. **Extraction:** When the user clicks "Execute Trade" in your UI:
   - Query Vela's object tree API to extract `entryPrice`, `stopLoss`, and `takeProfit`.
   - Calculate position size based on risk % and account balance.
3. **Active Trade State:** Store this trade in Zustand: `activeTrades`.
4. **Tick-by-Tick Evaluation:**
   - Inside the playback loop, check the _new_ 1m candle's `high` and `low` against all `activeTrades`.
   - If `low <= stopLoss` (for a long): Close trade, record loss, update balance.
   - If `high >= takeProfit` (for a long): Close trade, record win, update balance.

## Phase 6: Advanced Analytics & Journaling

### Core Analytical Features

- **Profit Factor:** The ratio of gross profit to gross loss. This provides a quick snapshot of system sustainability (a value greater than 1.0 indicates a profitable system).
- **Expectancy:** The mathematical expectation of average dollar return per trade. It is calculated by subtracting the expected loss (Loss Rate × Average Loss) from the expected win (Win Rate × Average Win).
- **Average RR (Risk:Reward):** The average ratio of risk taken to reward gained across all trades. This is calculated by dividing the average dollar amount of winning trades by the average dollar amount of losing trades (Realized RR).
- **Maximum Drawdown (Max DD):** The largest percentage drop in account equity from a peak to a subsequent trough during the backtested session, indicating the strategy's worst-case historical risk.
- **Consecutive Wins & Losses:** A counter tracking the longest unbroken streaks of winning and losing trades, essential for understanding potential psychological strain during live execution.
- **Average Holding Time:** The average duration trades are kept open, calculated from the time delta between order entry and execution of the exit (stop loss or take profit).
- **Most Gain by Day of the Week:** An aggregate metric that filters and sums total PnL based on the specific day (Monday through Friday) the trade was entered, helping identify optimal trading windows.
- **Breakeven Trades:** A count of trades closed at or near exactly $0.00 PnL (or within a tight threshold covering only spread/commission), separated from standard wins and losses.
- **Best Win & Worst Loss:** The single highest-grossing profitable trade and the single largest negative hit to the account balance throughout the session.

### Dashboard Implementation (React + shadcn/ui)

- **Top-Level Metric Grid (`Card`):**
  Use a grid layout of shadcn `Card` components (`CardHeader`, `CardTitle`, `CardContent`) for the primary KPIs. Display the Expectancy, Profit Factor, Average RR, Win Rate, and Max Drawdown at the top of the dashboard for immediate visibility.
- **Equity Curve Visualization:**
  Integrate a charting library like Recharts (which pairs natively with shadcn's charting blocks) inside a `Card` to plot the account balance over time. Plot a faint secondary "High Water Mark" line above the main equity line to visually illustrate drawdown periods.
- **Segmented Views (`Tabs`):**
  Use the shadcn `Tabs` component (`TabsList`, `TabsTrigger`, `TabsContent`) to separate the UI into logical sections. Keep the "Overview" (equity curve and main KPIs) clean, and move edge-case metrics (Most Gain by Day, Average Holding Time, Streak Data) into a dedicated "Deep Insights" tab.
- **Calendar PnL View (`Calendar` & `HoverCard`):**
  Aggregate your trade history by date to build a monthly Calendar PnL.
- Utilize the shadcn `Calendar` component (built on `react-day-picker`) and customize the day cell rendering.
- Apply dynamic utility classes to the calendar cells based on daily net performance (e.g., a green background for profitable days, red for losing days, and neutral for breakeven/no-trade days).
- Wrap each active calendar date in a shadcn `HoverCard` or `Tooltip`. When the user hovers over a specific day, display a quick summary card showing that day's exact Net PnL, total number of trades executed, and daily win rate.

- **Status Indicators (`Badge`):**
  Use shadcn `Badge` components within the Calendar hover cards or any supplementary logs to visually differentiate trade outcomes (green variant for `WIN`, destructive/red variant for `LOSS`, and neutral outline for `BREAKEVEN`).

## Implementation Rules for Coding AI

- Use the Dukascopy fetch (`src/main/dukascopy.ts`) specifically in the Electron Main Process. Browser environments (React) cannot reach Dukascopy directly due to CORS and Node-specific dependencies (`lzma-native`, SQLite).
- Ensure the SQLite database operates purely as a cache to speed up subsequent loads of the same date ranges.
- Prioritize React performance. Use `useRef` for the playback loop interval to avoid unnecessary re-renders, updating the Zustand state and Vela chart directly.
