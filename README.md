# Remaining time

[![Donate via patreon](https://img.shields.io/badge/patreon-donate-green.svg)](https://www.patreon.com/trgk)
[![AnkiWeb page](https://img.shields.io/badge/AnkiWeb-addon-blue.svg)](https://ankiweb.net/shared/info/1508357010)

This addon shows you how much time it takes to complete a deck. Essential addon.

![Remaining Time Example](remaining_time.png)

## Changes in this fork

This fork replaces the original addon's remaining-time math with an exponential moving average (EMA), and adds config options and output values around it.

**ETA/remaining-time calc:**

- Time-per-card estimate is an EMA over your recent answers (`emaSeconds`), not a simple running average. Recent pace matters more than old pace.
- Smoothing window is configurable (`emaWindowSamples`).
- A single slow outlier answer no longer skews the estimate. Each answer's duration is clamped to `reviewTimeCutoff` seconds before it enters the average.
- Rate tracking is session-wide, not per-deck. Per-deck rate storage was removed.

**Config additions (`src/config.json`):**

- `reviewTimeCutoff` — clamp per-answer duration before it feeds the EMA (default 300s).
- `emaWindowSamples` — smoothing window size for the EMA (default 60).
- `confirmReset` — ask for confirmation before the reset button clears progress (default true).
- `autoResetIdleSeconds` — auto-reset the bar after a long idle gap, e.g. resuming the next day (default 18000).
- `fixedSegmentWidth` — give every message segment the same width.
- `resetHotkey` — keyboard shortcut for the reset button.
- `runOnMobile` — enable on AnkiDroid.
- `barCSS` — inject custom CSS into the bar (experimental).
- `messageFormat` — customize the bar text via the tokens below.

**Additional output values (via `messageFormat` tokens):**

- `%(timePerCard)` — estimated seconds per card, from the same EMA that drives the ETA.
- `%(CPM)` — cards per minute, session average.
- `%(ETA)` / `%(ETA12)` — clock time you'll finish, in 24h or 12h format.
- `%(RR)` — retention rate (% of reviews marked correct) for the session.

See `src/config.md` for full details on every option.

## Developing

1. `git clone` this repo
2. `npm i` to install dependencies & linters
3. For TS changes, `npm run dev:js` to compile your changes continuously
4. `npm run build` to create `.ankiaddon` file.
5. `npm run dist` to build and tag your release. **Note that this script automatically tags your release!**
