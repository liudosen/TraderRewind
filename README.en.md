[简体中文](README.md) | **English**

# TraderRewind

A market replay and trading-practice desktop tool — runs entirely offline, free and open source.

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey.svg)](#quick-start)
[![Electron](https://img.shields.io/badge/Electron-33-47848F.svg)](https://www.electronjs.org/)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

![Data source download](docs/screenshots/data-source-progress.png)

## Quick start

```bash
npm install           # installs deps and rebuilds better-sqlite3 against Electron's ABI
npm run dev           # start in dev mode
npm run package:win   # build a Windows installer
```

> The Electron binary is fetched from a China mirror (see `.npmrc`).
> If `npm install` complains that `@rollup/rollup-win32-x64-msvc` or `@esbuild/win32-x64`
> is missing, install them explicitly:
> `npm i -D @rollup/rollup-win32-x64-msvc @esbuild/win32-x64`

## What's implemented

### Replay training (v0.2)

![Replay training](docs/screenshots/training-replay.png)

- **Bar-by-bar replay**: play / pause, 1x–10x speed, step forward and back, scrub the progress bar
- **Single-row toolbar**: timeframe buttons on the left, then indicators, playback controls,
  speed, report and progress — fixed height, never wraps
- **Multi-timeframe switching**: M1 / M5 / M15 / H1 / H4 / Daily / Monthly / Yearly at any time.
  After switching, the chart stays at the same point in time (all timeframes are aggregated
  live from 1-minute data, so they always agree)
- **Training sessions**: pick a symbol, then a backtest date range constrained by the data you
  actually have; the session aggregates that window from 1-minute bars and auto-saves progress,
  balance, current bar and selected timeframe, so you can resume at any point
- **Session management**: delete from the list (click the trash icon twice to confirm);
  deleting the active session exits replay. The list can be hidden with the `«` button so the
  chart takes the full width, restored with `»`; the state is remembered locally
- **Simulated orders**: buy / sell, lot size in 0.01 steps, manual close
- **Drawing tools**: a fixed toolbar on the left of the chart — trend line, horizontal line,
  vertical line, rectangle, Fibonacci retracement. Drag endpoints or the whole shape, press
  Delete to remove the selection, plus a "clear all" button. Drawings are saved with the session
- **Technical indicators**: overlay MA5 / MA20 / MA60 / EMA12 / EMA26 / BOLL(20,2) on the main
  chart; volume / MACD / RSI(14) in a sub-chart (one at a time). Toggle states are saved
- **Draggable SL / TP**: on entry, an entry line (grey), stop-loss line (red) and take-profit
  line (green) appear. Drag the SL / TP lines up or down to adjust prices; for longs they are
  automatically constrained to the correct side of the entry price
- **Automatic exit detection**: as each bar closes, touching SL or TP fills immediately.
  A single bar cannot tell us the intra-bar path, so we use the conservative rule "stop first"
- **Entry notes**: clicking buy / sell opens a note popup to record your reasoning, with a
  "skip and place order" option. Notes are stored in `closed_trades.notes` and shown in review
- **Training report**: opens automatically at the end of replay (or any time via "report").
  Shows total P&L, return, win rate, profit factor, max drawdown, equity curve, per-trade rows
  and notes. **Clicking any trade jumps the chart back to that moment and draws its entry and
  exit lines**
- **Trades are persisted**: every close is written to `closed_trades` (direction, size, entry
  and exit price, P&L, close reason, R multiple, SL / TP levels). Refreshing or reopening
  restores everything
- **Resizable trade panel**: drag the handle on its top edge to resize, double-click to reset;
  the height is remembered locally
- **Live stats**: equity / balance, floating P&L, trade count, win rate, cumulative P&L
- **Keyboard shortcuts**: `Space` play/pause · `Shift + →` next bar · `B` buy · `S` sell · `C` close
- **No going back**: there is deliberately no "previous bar", and the progress bar only moves
  forward — you cannot undo price action that has already happened

### Data sources (v0.1)

- **Three switchable data sources** at the top of the left panel, each with its own instrument
  catalogue. Switching clears the current selection so FX tickers are never sent to a crypto API
- **Dukascopy free FX history**: 23 instruments (majors / crosses / metals), aggregated from tick data
- **Crypto klines**: OKX and Binance public spot endpoints (USDT-quoted, 12 major coins) that
  return 1-minute candles directly — no local aggregation needed
- **Grouped, collapsible instrument list**: majors / crosses / metals / crypto. Click a header
  to collapse or expand; the state is remembered locally. A button on the right of each header
  selects or clears the whole group
- **Concurrent downloads**: hour files are requested independently, 1–64 in parallel (default 24),
  over a keep-alive connection pool so high concurrency doesn't exhaust local ephemeral ports.
  Too much concurrency gets rate-limited (HTTP 429); when that happens repeatedly the job aborts
  and tells you to lower it. Crypto endpoints throttle harder, so effective concurrency is
  capped around 4–6
- **Live progress and throughput**: progress bar, instantaneous speed, average speed, ETA,
  file count, bar count
- **1-minute granularity only**: only M1 is downloaded; larger timeframes (5/15/30 min, 1/4 hour,
  daily) are aggregated at draw time so every timeframe shares one source and stays comparable
- **Already-downloaded dates are struck through**: dates fully covered by your selection are
  disabled in the calendar and the matching presets are greyed out. If the whole range is
  covered, "Start download" is disabled with an explanation
- **Custom date-range picker**
  - **Two-step selection**: pick the start date, then the end date. The two fields at the top
    show which step you're on; click one to go back and change it
  - **Jump by year / month**: dropdowns take you anywhere from 2003 to today
  - **Month-only is fine**: clicking "March 1" uses the 1st of that month as the endpoint
  - Presets for the last 3 / 7 / 30 / 90 days; hover to preview the range; Esc or click-away closes
  - Future dates are disabled automatically
- **Incremental storage**: the same symbol and timeframe reuse one dataset, merged with
  `INSERT OR REPLACE` and the time range recomputed
- **Proxy support**: HTTP proxy including HTTPS CONNECT tunnelling
- **Cancellable**: interrupt at any time; the completed portion is not written to the database

![Download finished](docs/screenshots/data-source-downloaded.png)

### Chart appearance (Settings → Chart appearance)

![Chart appearance](docs/screenshots/settings-chart-theme.png)

- **Presets**: red-up/green-down, green-up/red-down, light background, dark background —
  switch with one click
- **Custom colors**: up color, down color, background, axis text, grid lines, crosshair.
  Color picker plus hex / rgba text input, applied **immediately**
- **Crosshair**: color, line style (solid / dotted / dashed / long-dash / sparse-dot), width,
  price-label toggle, and a "snap to bar" toggle (off by default, crosshair follows the mouse)
- **Candle details**: toggle grid lines, wicks and borders
- Everything is saved to `settings.json` automatically, with a "restore defaults" button

### Data storage (directories can be set separately)

![Settings](docs/screenshots/settings-storage.png)

Data is split into two independent SQLite databases, each with its own directory
under Settings → Storage:

| Category | Contents | Default location |
|---|---|---|
| **Market data** | groups, datasets, candles, ticks (`market.db`) | `<userData>/data/kline` |
| **Training data** | sessions, positions, trades, journal, accounts (`training.db`) | `<userData>/data/training` |

- When you change a directory, the current database is copied over if the target has none,
  otherwise it switches directly
- The old single-file `traderrewind.db` is split into the two new databases on first launch,
  and the original is renamed to `*.migrated`

## Tech stack

| Layer | Technology |
|---|---|
| Desktop | Electron 33 + electron-vite |
| Main process | TypeScript (Node.js) + better-sqlite3 |
| Renderer | React 18 + Zustand + Tailwind CSS |
| Charts | lightweight-charts v5 (TradingView) |
| Decompression | lzma (pure JS, no native build) |

## Project layout

```
src/
  shared/            Types, constants (IPC channels, instrument catalogue), date helpers
  main/
    index.ts         Main-process entry (window, IPC registration, userData isolation)
    settings.ts      App settings (two data directories, stored in settings.json)
    db/
      connection.ts  Dual-database connections + automatic migration from the old file
      schema.ts      Schemas for the market and training databases
      dataset-repo.ts Persists downloaded market data
    ipc/             Five handler groups: db / file / window / data / settings
    services/        dukascopy.ts (tick download, decompress, aggregate),
                     candle-api.ts (OKX / Binance kline paging)
    utils/           http.ts (proxy + keep-alive pool), lzma.ts (decompression)
  preload/           contextBridge API
  renderer/src/
    components/
      chart/         ReplayChart.tsx — replay chart with draggable SL/TP lines
      panels/        Dashboard / Data / Training / Journal / Settings
    stores/          app-store / download-store / training-store
```

## Data sources in detail

Dukascopy public historical tick data:

```
http://datafeed.dukascopy.com/datafeed/{SYMBOL}/{YYYY}/{MM0}/{DD}/{HH}h_ticks.bi5
```

- `MM0` is a **zero-indexed month** (`00` = January). Treating it as 1-indexed shifts everything
  by a full month
- Files are LZMA(alone) compressed. After decompression each tick is 20 bytes, **all big-endian**:
  `int32 time offset (ms)` + `uint32 ask` + `uint32 bid` + `float32 ask volume` + `float32 bid volume`
- Prices must be divided by `10^digits` (5 digits for EURUSD, 3 for JPY pairs)
- It uses **HTTP** rather than HTTPS: on some networks the HTTPS handshake is interrupted
- Direct connections are unstable from mainland China; configure a local proxy

Crypto klines come from the public OKX and Binance endpoints and are paged; the two exchanges
page in opposite directions (OKX's `after` walks backwards in time, Binance's `startTime` walks
forwards), which is why each adapter owns its own cursor logic.

## Docs

- [Architecture](docs/architecture.md) *(Chinese)*

## Contributing

Issues and pull requests are welcome. Please read [CONTRIBUTING.md](CONTRIBUTING.md) first —
it covers branch naming, commit conventions, code style and what to verify locally.

- Report a bug: [open an issue](https://github.com/liudosen/TraderRewind/issues/new/choose)
- Security: do **not** open a public issue — follow [SECURITY.md](SECURITY.md)

## License

Released under the [Apache License 2.0](LICENSE).

```
Copyright 2026 liudosen

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0
```

### Third-party components and data sources

| Name | Purpose | License |
|---|---|---|
| [Electron](https://www.electronjs.org/) | Desktop runtime | MIT |
| [React](https://react.dev/) | UI framework | MIT |
| [lightweight-charts](https://github.com/tradingview/lightweight-charts) | Candlestick charts (by TradingView) | Apache-2.0 |
| [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) | Local database | MIT |
| [Zustand](https://github.com/pmndrs/zustand) | State management | MIT |
| [Tailwind CSS](https://tailwindcss.com/) | Styling | MIT |
| [Dukascopy](https://www.dukascopy.com/) | Historical FX tick data | public endpoint |
| [OKX](https://www.okx.com/) / [Binance](https://www.binance.com/) | Crypto klines | public endpoint |

> Market data remains the property of the respective providers. This project is intended for
> personal study and research only, and nothing here is investment advice.
