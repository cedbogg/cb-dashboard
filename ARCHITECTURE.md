# CB Dashboard — Architecture & Handover

A single-user private dashboard for Cedric spanning Perso, Fortior (acquisition),
Finance, Health, Fitness — with memory-aware "agents" per domain. This doc is the
handover: how it's built, where data comes from, how to operate and extend it.

---

## 1. Stack at a glance

```
Browser (index.html, one file)
   │  reads Supabase directly (anon key, RLS-scoped)  ── auth gate = Supabase Auth
   │  calls /api/* for anything needing a secret
   ▼
Vercel serverless functions (/api/*)
   │
   ├── Supabase (Postgres + Auth)         ← single source of truth the UI reads
   ├── Notion (Cedric's editing surface)  ← synced into Supabase on a cron
   ├── Google APIs (Calendar iCal, People/Contacts, Gmail)
   ├── Anthropic API (the domain agents + email triage)
   └── Pension workbook (via a local publisher → /api/pension-update)
```

- **Repo:** `github.com/cedbogg/cb-dashboard` (private). Actual app lives in the nested
  `cb-dashboard/cb-dashboard/` directory. Pushing to `main` auto-deploys to Vercel.
- **Live URL (production alias):**
  `https://cb-dashboard-cedricboghanim-5270s-projects.vercel.app/`
  ⚠️ Use this, **not** the per-deployment `…-<hash>-…vercel.app` URLs — those are frozen
  snapshots that never update.
- **Supabase project ref:** `tfqedzoeikrofydrxfoq`. **Owner user id:**
  `ec438cfe-c01b-42fb-9b23-6ed01637ef30` (stamped on every synced/ingested row).

---

## 2. Data-flow model

Three ways data reaches the dashboard:

1. **Notion → Supabase (scheduled).** Notion is Cedric's editing surface. `/api/sync-notion`
   (cron, 07:00 daily) upserts Notion DBs into Supabase tables on `notion_id`. Rows removed
   from Notion are reconciled (targets → `Dead`, tasks/goals → deleted). The UI reads Supabase.
2. **External APIs at request/cron time.** Calendar events, contact birthdays, and Gmail-derived
   tasks are fetched live from Google/Anthropic by serverless functions.
3. **Push ingests.** The pension workbook is pushed in by a local publisher; Gmail tasks are
   written back into Notion (and mirrored to Supabase for instant display).

**Golden rule:** the browser only ever reads Supabase + calls `/api/*`. It never holds a
service key. Anything privileged happens server-side.

---

## 3. Frontend (`index.html`)

One self-contained file: HTML + CSS + an ES-module `<script>`. Key pieces:

- **Auth gate** (`lib/supabase.js`): on load, `getSession()`; if none, render an email+password
  overlay (`signInWithPassword`). Config (`SUPABASE_URL`, `SUPABASE_ANON_KEY`) comes from
  `/api/config` so no keys are committed. The anon key is RLS-protected.
- **Screens:** Home, Perso, Fortior, Finance, Health, Fitness. `setDomain(s)` swaps screens and
  calls that screen's `load*()` on every visit.
- **Header:** greeting is time-of-day aware; date/clock is live (refreshes every 30s).
- **Agent dock:** per-domain chat calling `/api/agent`; "what I've learned" chips come from
  `agent_memory`.

### Screen → data source

| Screen | Panels & sources |
|---|---|
| **Home** | "This week" ribbon + Perso card (shared `fetchWeek()` → `/api/calendar`); **Coach · your week** (live habit adherence read); Priorities (`priorities`, live); summary cards (Perso/Fortior live, others still mock). |
| **Perso** | This week calendar (`/api/calendar`); **Looking ahead** = school holidays + birthday-gift + bar/bat-mitzvah reminders (tick state in `reminder_acks`); **Habits** tick-to-complete w/ per-cadence reset (`goals_habits` + `habit_checkins`); **Big Goals** with Achieved / Not-this-time (`goals_habits.status`). |
| **Fortior** | Funnel from the Rocket-Log **teaser column** (`rocket_targets`, active = Surfaced+Pursuing); In-dialogue / Stalled / New-targets; **Things to do** (`fortior_tasks` + Gmail extractor); sprint "month X of 6" computed from 1 Jul 2026 start. |
| **Finance** | **Pension (Aegon)** tile + blended OCF + allocation table (`pension` table via `/api/pension-update`). Fortior Holdings (IBKR) + personal budget still **mock**. |
| **Fitness** | Programmes from `training_programs` (live). Session logs still mock. |
| **Health** | Biomarkers — **mock** (schema exists, not wired). |

---

## 4. Serverless endpoints (`/api/*`)

| Endpoint | Purpose | Auth |
|---|---|---|
| `config.js` | Serves public Supabase url + anon key to the browser. | none (public values) |
| `agent.js` | Memory-aware domain agent. Loads `agent_memory`+`agent_messages`, calls Claude, persists the turn, captures one durable memory. Perso context includes **habit adherence + goal hit-rate**. | Supabase session token (owner) |
| `calendar.js` | Google Calendar secret **iCal** feed(s) in `GCAL_ICS_URL` (comma-sep) + contact **birthdays** via People API. Returns the week's events + a `lookAhead` payload (gift birthdays ≤60d, bar/bat-mitzvah events ≤130d). | Supabase session token (owner) |
| `fortior-mail.js` | Gmail → Notion Fortior tasks. Searches "Fortior", Claude classifies each **thread** todo/done/skip (reads SENT replies), writes new tasks to Notion + mirrors to `fortior_tasks`, marks handled ones Done, de-dupes by text. | `CRON_SECRET` (cron) **or** owner token (button) |
| `sync-notion.js` | Notion → Supabase upsert for the configured DBs. | `CRON_SECRET` if set |
| `pension-update.js` | Ingest pension snapshot (total, blended OCF, funds[]) into `pension`. | `Bearer PENSION_INGEST_SECRET` |

**Crons (`vercel.json`):** `fortior-mail` 06:00, `sync-notion` 07:00 (both daily, UTC).

---

## 5. Supabase schema (`supabase-schema.sql`)

All tables are RLS owner-only (`owner_id = auth.uid()`); the service-role sync/ingest bypass RLS
and stamp `owner_id = OWNER_USER_ID`.

| Table | Fed by | Notes |
|---|---|---|
| `priorities` | Notion sync | Home priorities rollup. |
| `fortior_tasks` | Notion sync + Gmail extractor | "Things to do". `source='Gmail'` rows link to the email. |
| `rocket_targets` | Notion sync (Rocket Sourcing Log) | Funnel/dialogue/new-targets. `stage` is empty → funnel uses `teaser_status`. |
| `personal_budget` | Notion sync | Not yet on screen. |
| `biomarkers` | (unused yet) | Health screen mock. |
| `training_programs` | Notion sync | Fitness programmes. |
| `goals_habits` | seeded direct + Notion | Habits + Big Goals. `last_checkin` = latest tick. |
| `agent_memory` / `agent_messages` | agent.js | Durable memory + chat history per domain. |
| `reminder_acks` | frontend | Tick state for "Looking ahead". |
| `habit_checkins` | frontend | One row per habit tick — the coach's adherence history. |
| `mail_tasks_seen` | fortior-mail | Gmail-message idempotency for the task extractor. |
| `pension` | pension-update | One snapshot per `as_of` (also gives value-over-time). |

Seeded-direct rows (e.g. habits/goals) use `notion_id = NULL` so the Notion sync's reconcile
(which only deletes rows *with* a `notion_id`) never wipes them.

---

## 6. Environment variables (set in Vercel — never in the repo)

| Var | Used by |
|---|---|
| `SUPABASE_URL`, `SUPABASE_ANON_KEY` | frontend (via `/api/config`) |
| `SUPABASE_SERVICE_ROLE_KEY` | all server writes |
| `OWNER_USER_ID` | stamped on synced/ingested rows; owner auth checks |
| `ANTHROPIC_API_KEY` | `agent.js`, `fortior-mail.js` |
| `NOTION_TOKEN`, `NOTION_ROCKET_DB_ID`, `NOTION_TASKS_DB_ID` (+ optional `NOTION_PRIORITIES_DB_ID`, `NOTION_GOALS_DB_ID`, `NOTION_TRAINING_DB_ID`) | `sync-notion.js`, `fortior-mail.js` |
| `GCAL_ICS_URL` | `calendar.js` — one or more Google secret iCal addresses, comma-separated |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN` | `calendar.js`, `fortior-mail.js` |
| `PENSION_INGEST_SECRET` | `pension-update.js` |
| `CRON_SECRET` | optional; secures the cron endpoints |

### Google OAuth notes (important)
- One OAuth client (id begins `639943537887-…`). The **refresh token must carry both scopes**:
  `contacts.readonly` **and** `gmail.readonly` (mint via the OAuth Playground with "Use your own
  OAuth credentials" ticked and this client's id/secret, or exchange the code manually).
- The OAuth **consent screen must be "In production"** — in "Testing" mode Google expires refresh
  tokens after 7 days (this bit us; symptom = `invalid_grant: Token has been expired or revoked`).
- `invalid_client` (`error_description: "Unauthorized"`) = the client id/secret pair is wrong.
  `invalid_grant` = the refresh token doesn't match the client. `403 insufficient scope` = missing
  gmail/contacts scope.

---

## 7. ⚠️ Vercel Deployment Protection (external automation gotcha)

The whole app is behind **Vercel Deployment Protection (SSO)** — good, it keeps private data
private. Consequence: **any external POST is 401'd** ("Protected deployment") unless it includes:

```
x-vercel-protection-bypass: <token>
```

The token comes from **Vercel → Settings → Deployment Protection → Protection Bypass for
Automation**. In-browser use (you're logged into Vercel) and Vercel-internal crons are unaffected —
only external callers (curl, the pension publisher) need the header. Do **not** disable protection
to work around this; it would make the whole dashboard public.

---

## 8. Pension pipeline (workbook → dashboard)

The monthly pension workbook is maintained by a separate Claude agent on a Bloomberg "Cowork"
machine. That agent **has no network egress**, so it cannot POST — it only updates and saves the
`.xlsx`. A **local publisher** on Cedric's own machine does the posting:

- **Workbook:** newest `pension_workbook_*.xlsx` in `C:\Users\cedri\OneDrive\Personal Finance\Pension\`.
- **Publisher:** `C:\Users\cedri\PensionPublisher\publish_pension.ps1` — reads the workbook via
  Excel COM and POSTs to `/api/pension-update`. Secrets in `config.json` beside it
  (`ingest_secret`, `bypass`) — a **file, not env vars**, because Task Scheduler caches env.
  Logs to `publish.log`.
- **Schedule:** Task Scheduler task **"CB Dashboard - Publish Pension"**, daily 08:00, runs when
  logged on, `StartWhenAvailable`. Idempotent (one `pension` row per `as_of`).
- **Cell mapping (agent-verified):** total = `Allocation!F4`; blended OCF = the F cell on the
  Allocation TOTAL row; as-of = `Portfolio!B5`; funds from Allocation row 8 down to TOTAL
  (A=name, B=isin, E=weight 0–1, F=ocf, G=value). **Weights are not normalised** (they sum to
  ~0.9975 — the rest is uninvested cash). QTD returns are `null` for now (Bloomberg cells only
  reliable on the terminal).

---

## 9. Operating notes

- **Deploy:** push to `main` → Vercel auto-deploys. Env-var changes require a redeploy.
- **Notion sync now:** hit `/api/sync-notion` (or wait for 07:00).
- **Fortior email scan:** runs 06:00 daily; the "Scan Gmail" button on the Fortior screen runs it
  on demand and shows the result/error inline.
- **Pension:** automatic daily; check `publish.log` to confirm. Manual re-post = run the publisher
  script.
- **First-login:** create Cedric's user in Supabase Auth (that password is the app lock).

---

## 10. Still mock / not yet built

- Finance: **Fortior Holdings (IBKR)** tile and **personal budget** table (IBKR is easily made live
  — listed ETFs price via any market API).
- **Health** biomarkers screen; **Fitness** session logs (Strava / lift PRs).
- Pension **QTD returns** (once Bloomberg populates reliably).
- Fortior **"New targets · agent"** auto-sourcing and **Sector news** (web + Gmail newsletters).

---

*Maintained alongside the code. Update this file when architecture changes.*
