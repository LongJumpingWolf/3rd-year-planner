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
js/cloud.js           Google sign-in + Supabase sync (lazy-loaded, off until configured)
js/syncLogic.js       pure sync decisions (unit tested)
js/share.js           viewer-link management; js/viewerSnapshot.js builds the numbers-only summary
view.html, js/viewer.js, css/viewer.css   the read-only big-print viewer page
js/utils.js           dates, formatting, CSV
js/data.js            embedded task library (377 lectures)
js/ui/*               one view module per page + dialogs/toasts/helpers (tuner.js = Plan tuner)
server.js             zero-dependency static server
tests/unit, tests/e2e automated tests
legacy/               the original single-file version, kept for reference
```

## Cloud sync (Google sign-in on Supabase)

Sign in with Google to open the same progress on your phone, laptop and tablet. The app still works offline: your browser copy is what you see, and changes upload when you are online. Sync is off until you add a free Supabase project:

1. Create a project at [supabase.com](https://supabase.com). In the **SQL editor**, run [supabase/schema.sql](supabase/schema.sql). It creates the `user_state` table, row-level security (each account can only touch its own row) and live updates.
2. Create Google credentials: in [Google Cloud Console](https://console.cloud.google.com/apis/credentials) make an **OAuth client ID** (type *Web application*). Under *Authorized redirect URIs* add `https://<your-project-ref>.supabase.co/auth/v1/callback`.
3. In Supabase go to **Authentication > Providers > Google**, enable it and paste the Google client ID and secret.
4. In Supabase go to **Authentication > URL Configuration**: set *Site URL* to your Vercel address and add it (and `http://localhost:3000`) under *Redirect URLs*.
5. In **Project settings > API** copy the *Project URL* and the **anon** key into `js/supabase-config.js` (replace `null`), then redeploy. Never use the `service_role` key.

How it behaves: each account stores one row. Edits upload about 1.5 seconds after you stop; a change from another device appears without reloading (and when you switch back to the tab). If both this device and the cloud changed since they last agreed, or a new device already has progress, you are asked which copy to keep; "Decide later" pauses sync and changes nothing. Sign-in leaves the page and returns to it, which also works on phones that block pop-ups. Export backup still works as a manual safety net.

## Viewer link (for a parent or friend)

The Dashboard's **Share progress** button (or Settings > **Viewer link**) creates a secret link to a separate, read-only page (`view.html`) in big print: overall progress, on track / behind, whether you studied today, streak, the last 7 days, lectures per subject, a countdown and your own **Also done** notes (add them in the Daily view, under each day).

- Run [supabase/viewer.sql](supabase/viewer.sql) once in the Supabase SQL editor (after `schema.sql`), then sign in and press **Create viewer link**.
- The viewer sees **numbers only**: no lecture titles, no settings, no plan, no controls, and the page has no link to the planner. The summary is stored in its own table, so the link cannot reach your planner data.
- The link holds 192 random bits after a `#`, which browsers never send to servers or logs. Anyone who has the link can open it, so share it only with people you trust.
- **Make a new link** kills the old one instantly; **Turn off** also deletes the stored summary. The summary refreshes whenever your progress syncs, and the viewer page re-checks every minute.

## Landing page

On screens wide enough for the Daily view's two columns (over 900 px), the app opens on the **Daily view** (Light | Focused side by side). Narrower screens open on the Dashboard. A link with a page in it (for example `#dashboard`) always wins.

## Plan tuner (finish date, daily hours, study order)

On the **Weekly calendar** page, the **Plan tuner** builds a plan that finishes in the time you choose:

- **Two linked sliders.** *Finish by* and *Focused hours per weekday* are tied together. Drag the date earlier and the hours rise to what is needed; drag the hours up and the finish date comes forward. If a date is impossible (even at the most your evening allows) it says so instead of promising it. Nothing changes until you press **Apply and rebuild plan** (Undo is offered).
- **Even pace.** The remaining lectures are spread over the free focused time from today to the finish date in proportion to each day's capacity, so the load is level: not packed into the early days, not a sprint at the end, and the plan reaches the finish date honestly. If everything cannot fit, the plan shows how many lectures spill over and by how much, rather than pretending.
- **Study order (phases).** Give each subject a phase. Subjects in the same phase are studied side by side (interleaved so they advance at the same rate); phases run one after another. Presets: one by one, two at a time, three then one, one then three, all together. Change the order mid-way and the not-yet-done lectures are simply re-planned forward.
- **Asleep subjects.** Set a subject to *Asleep* to keep it in the library but leave it out of the plan, the daily timetable and the hours needed. Wake it later by giving it a phase.
- **Missed days.** Planning always starts from today, so days that are over never receive new work and a change of strategy never turns into "backlog". When lectures planned for earlier days are still open, a banner offers **Re-spread from today**, which moves them forward evenly (Undo is offered).

Notes: weekend focused hours come from the scheduler form below; the weekday slider is capped at what fits between your evening start and bedtime. Automatic splitting of a lecture into sessions uses gaps of at least 20 minutes (15 when the schedule is very tight).

## Viewer link troubleshooting

If **Create viewer link** or **Share progress** says "One-time setup is missing", the viewer table does not exist in your Supabase project yet. Press **Show setup steps** in the message (or in Settings > Viewer link): it shows the SQL ready to copy and opens your project's SQL editor. Paste, press Run, then try again. The SQL in `supabase/` is safe to run more than once.

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

Deep work is never placed in light work because focused work is full; it goes to the next focused slot, is split into sessions (min. 20 min by hand; the scheduler may use 15-minute gaps when time is very tight), or is listed in the backlog with the reason. Putting deep work in light work by hand needs an explicit override and is flagged. Each day offers Move (date + block), Edit (runtime, type, deadline, priority), Split, "Move overflow to next free slot", and Day settings (unavailable / custom capacity). Bulk changes have Undo. Weekends use their own capacities (default 2 h light + 4 h focused), DAMS weekends allow only a 30-minute light recap, and the trip is blocked.

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
- FMT (44 lectures) and ENT (65 lectures) are in the library with every title and duration. ENT adds up to its recorded 47 h 23 min; the FMT list adds up to 34 h 36 min, 40 minutes more than the 33 h 56 min recorded earlier, so one FMT duration may be off. Older saved data that still has the two placeholders is upgraded automatically on load and the plan is rebuilt once (Undo is offered).

## Storage

Local to this browser and device; export a JSON backup before clearing browser data. Backups from the old single-file version import fine.
