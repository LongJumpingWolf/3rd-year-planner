# MBBS Study Command Center

Offline-first study planner: dashboard, weekly calendar, automatic scheduler, task library, what-if simulator and data audit. Progress is saved in your browser's local storage.

## Run it

```
npm start
```

Then open **http://localhost:3000** (set `PORT` to change it). No dependencies are needed to run the app. Opening `index.html` straight from disk will not work because the app uses ES modules, so use the server.

## Test it

```
npm install        # one-time: Playwright + axe-core for the browser tests
npm test           # 71 unit tests (two-block scheduler, splitting, overrides, day exceptions, migration, CSV)
npm run test:e2e   # 57 browser tests in real Chrome/Edge: Daily/Weekly views, keyboard, dialogs, a11y (axe), mobile, reload, security
npm run test:all
```

## Project layout

```
index.html            page shell (landmarks, forms, dialogs mount)
css/styles.css        design tokens, light/dark theme, responsive layout
js/app.js             router, event wiring, keyboard shortcuts
js/actions.js         every user action (validated, with toasts)
js/planner.js         pure scheduling engine (light + focused capacities)
js/taskOps.js         move / split / reclassify / auto-place / day exceptions (pure)
js/store.js           state, persistence, backup sanitising
js/utils.js           dates, formatting, CSV
js/data.js            embedded task library (270 entries)
js/ui/*               one view module per page + dialogs/toasts/helpers
server.js             zero-dependency static server
tests/unit, tests/e2e automated tests
legacy/               the original single-file version, kept for reference
```

## Dashboard extras

- **Progress by subject**, **study streak** (days in a row with a completed lecture), **countdowns** to the target finish and hard backstop, the **pace** needed to finish on time, and a 7-day activity chart.
- **Focus timer** (25/45/50/90 min) that stays accurate in background tabs and counts finished sessions per day.
- **Theme** button in the header cycles Auto / Light / Dark and remembers the choice.
- **Installable and offline**: a service worker caches the app shell, so it opens without a connection after the first visit (serve over `npm start`; install from the browser menu).
- Printing hides the controls for a clean paper copy of the plan.

## Light work vs focused work

Every day has two separate capacities, shown in the Daily view, the Weekly cards and the Dashboard:

- **Light work — College gaps** (default 1 h 30 min per weekday): recall, MCQs, lecture previews, indexing. No clock times, since college gaps vary.
- **Focused work — Home / evening** (default 2 h 30 min per weekday): lectures and deep study, from 6:30 PM with 10-minute breaks, finishing 15 minutes before bedtime (10:30 PM).

Deep work is never placed in light work because focused work is full; it goes to the next focused slot, is split into sessions (min. 20 min), or is listed in the backlog with the reason. Putting deep work in light work by hand needs an explicit override and is flagged. Each day offers Move (date + block), Edit (runtime, type, deadline, priority), Split, "Move overflow to next free slot", and Day settings (unavailable / custom capacity). Bulk changes have Undo. Weekends use their own capacities (default 2 h light + 4 h focused), DAMS weekends allow only a 30-minute light recap, and the trip is blocked.

Data saved by the older single-capacity version is migrated automatically on first load (progress, completions and IDs kept; an untouched copy is stored under `mbbsStudyCommandCenter.v1.pre-blocks-backup`).

## Keyboard

`Alt+1`–`Alt+7` switch pages · `/` search the library · `[` `]` previous/next week (calendar) or day (daily view) · `T` today · `?` shortcut list · `Esc` closes dialogs. Everything is reachable with Tab, there is a skip link, focus is kept after updates, and dialogs trap focus and return it.

## Scheduling rules

- Weekday capacities come from Settings (light 1.5 h, focused 2.5 h). Free weekends and the 1–13 Nov college break use the weekend capacities (2 h light, 4 h focused).
- Trip (default 1–15 Dec 2026) has zero capacity; weekday posting catch-up (3 h) follows it until the target finish, then post-end prep until the backstop.
- DAMS weekends from 13 Nov have a 0.5 h light recap and no focused time; non-DAMS Sundays get a 1 h weekly review (light).
- Video time = runtime ÷ speed × (1 + annotation% + recall%). Missing durations default to 20 min and are flagged.
- Lectures that do not fit before the hard backstop go to the backlog, never silently dropped.
- Lectures you move by hand are pinned and survive regeneration. Completed items are never moved.

## Data notes

- PSM 117 entries (49 and 50 kept as a possible duplicate); Ophthalmology 151 entries including estimated durations.
- FMT (44 videos, 33 h 56 min) and ENT (65 videos, 47 h 23 min) are verified totals only; their title lists were not recoverable, so they are shown as placeholders, not invented. Add them via Data audit → Import task CSV (`title`, `subject`, `category`, `durationSec` required).

## Storage

Local to this browser and device; export a JSON backup before clearing browser data. Backups from the old single-file version import fine.
