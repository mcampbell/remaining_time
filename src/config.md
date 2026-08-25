# Remaining Time 2.1 - Configuration

## debug (default: false)

Enable debug mode.

## showAtBottom (default: false)

When this is true, the progress bar will show at the bottom.

## runOnMobile (default: false)

Set plugin to run also on mobile. *Note) only compatible w/ AnkiDroid.*

## fixedSegmentWidth (default: false)

Set all segment's width to same. [This has been requested](https://github.com/trgkanki/remaining_time/issues/25), so FYI.

## autoResetIdleSeconds (default: 18000)

If more than this many seconds have passed since the last review (e.g. resuming reviews the next day), the progress bar automatically resets instead of showing a stale/huge elapsed time. Set to `0` to disable.

## reviewTimeCutoff (default: 300)

Every review taking too much time will be clampped to `reviewTimeCutoff` (seconds). Some outliers may influence the ETA too much.
Use this option to filter out the outliers.

## emaWindowSamples (default: 60)

Number of recent card answers the "time per card" estimate is smoothed over. A bigger number reacts more slowly to a change in your pace but is less twitchy/noisy; a smaller number reacts faster but is jumpier. Accepts any positive number (need not be an integer, though in practice it will be).

## resetHotkey (default: "")

Hotkey for reset button.

## messageFormat (default: `"Elapsed %(elapsedTime),  Remaining %(remainingTime), ETA %(ETA)"`)

Format the messages. `%(variableName)` gets replaced to values below

- `%(elapsedTime)`: Elapse time since the start of the reviews.
- `%(remainingTime)`: Estimated remaining time.
- `%(totalTime)`: `elapsedTime + remainingTime`
- `%(CPM)`: Cards per minute.
- `%(ETA)`: Estimated time arrival. Expected review finish time
- `%(ETA12)`: Same as `ETA`, except that it's in 12-hour format (ex: `12:00 PM`)
- `%(RR)`: Retention rate for reviewed cards only. (ex: `80.0%`)

## barCSS (Default: `""`) - *Experimental*

CSS stylesheet that only gets applied inside the progress bar. What selector to use is intentionally undocumented, so that we could change our implementation details as much as we want. Be careful as your code *may* break every time the addon is updated.

To see what selectors to use, try using [AnkiWebView Inspector](https://ankiweb.net/shared/info/31746032) addon.
