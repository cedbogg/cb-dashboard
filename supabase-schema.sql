-- ============================================================
-- CB Dashboard — Supabase schema (v1)
-- Project: tfqedzoeikrofydrxfoq
-- Run via Claude Code (Supabase MCP) or the Supabase SQL editor.
-- Single-user app: every row is owned by the authenticated user,
-- enforced by RLS. The Notion/Strava/Calendar sync (service role)
-- must set owner_id to Cedric's auth user id.
-- ============================================================

-- Helper: updated_at auto-touch
create or replace function touch_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;

-- ------------------------------------------------------------
-- 1. PRIORITIES  (mirrors Notion: Priorities)
-- ------------------------------------------------------------
create table if not exists priorities (
  id               uuid primary key default gen_random_uuid(),
  owner_id         uuid not null default auth.uid(),
  project          text not null,
  category         text,          -- Sparta Prospective Deals | Sparta Investments | Sparta AI | Fortior | Personal
  status           text,          -- On track | At risk | Needs attention | Waiting / owed to me | Done
  next_action      text,
  next_action_date date,
  source_link      text,
  notion_id        text unique,   -- for idempotent sync
  updated_at       timestamptz not null default now()
);

-- ------------------------------------------------------------
-- 2. FORTIOR TASKS  (mirrors Notion: Fortior Tasks)
-- ------------------------------------------------------------
create table if not exists fortior_tasks (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null default auth.uid(),
  task        text not null,
  type        text,   -- Companies House | Tax | Invoice | Banking | Legal | Other
  status      text,   -- To do | In progress | Waiting | Done
  due_date    date,
  source      text,   -- Gmail | Fortior inbox | Manual
  link        text,
  notes       text,
  notion_id   text unique,
  updated_at  timestamptz not null default now()
);

-- ------------------------------------------------------------
-- 3. ROCKET TARGETS  (sourcing log + full acquisition funnel)
--    Adds the post-teaser stages the funnel needs.
-- ------------------------------------------------------------
create table if not exists rocket_targets (
  id              uuid primary key default gen_random_uuid(),
  owner_id        uuid not null default auth.uid(),
  urn             text,
  business        text not null,
  lane            text,     -- fire | legionella | asbestos | electrical | ...
  score           int,
  teaser_status   text,     -- Not requested | Requested | Received | Passed
  stage           text,     -- Sourced | Teaser | NDA | Info & mgmt call | Heads of terms | Final offer | Closed | Passed
  ebitda_gbp      numeric,
  location        text,
  status          text,     -- Pursuing | Parked | Dead
  date_first_seen date,
  last_contact    date,     -- powers the "stalled / chase" signal
  source          text,
  notes           text,
  notion_id       text unique,
  updated_at      timestamptz not null default now()
);

-- ------------------------------------------------------------
-- 4. PERSONAL BUDGET  (mirrors Notion: Personal Budget)
-- ------------------------------------------------------------
create table if not exists personal_budget (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null default auth.uid(),
  line_item   text not null,
  type        text,   -- Income | Fixed expense | Variable expense | Savings / Investment
  category    text,
  budgeted    numeric,
  actual      numeric,
  month       date,   -- first of month
  notes       text,
  notion_id   text unique,
  updated_at  timestamptz not null default now()
);
-- variance is derived, not stored:
create or replace view budget_v as
  select *, coalesce(actual,0) - coalesce(budgeted,0) as variance from personal_budget;

-- ------------------------------------------------------------
-- 5. BIOMARKERS  (mirrors Notion: Biomarkers)
-- ------------------------------------------------------------
create table if not exists biomarkers (
  id              uuid primary key default gen_random_uuid(),
  owner_id        uuid not null default auth.uid(),
  marker          text not null,
  panel           text,   -- Blood | Microbiome | Other
  result          text,
  unit            text,
  reference_range text,
  flag            text,   -- In range | Borderline | Out of range
  test_date       date,
  source_file     text,
  notes           text,
  updated_at      timestamptz not null default now()
);

-- ------------------------------------------------------------
-- 6. TRAINING PROGRAMS  (mirrors Notion: Training Programs)
-- ------------------------------------------------------------
create table if not exists training_programs (
  id                uuid primary key default gen_random_uuid(),
  owner_id          uuid not null default auth.uid(),
  program           text not null,
  discipline        text,   -- Gym / Strength | Running | Mobility | Other
  status            text,   -- Active | Planned | Archived
  start_date        date,
  progression_notes text,
  program_link      text,
  program_html      text,   -- the Claude-built programme, rendered on the Fitness screen
  notion_id         text unique,
  updated_at        timestamptz not null default now()
);

-- ------------------------------------------------------------
-- 7. GOALS & HABITS  (mirrors Notion: Goals & Habits)
-- ------------------------------------------------------------
create table if not exists goals_habits (
  id            uuid primary key default gen_random_uuid(),
  owner_id      uuid not null default auth.uid(),
  name          text not null,
  type          text,   -- Goal | Habit
  area          text,   -- Perso | Health | Fitness | Fortior | Finance | Sparta | Other
  cadence       text,   -- Daily | Weekly | Monthly | Quarterly | One-off
  status        text,   -- On track | At risk | Off track | Done
  last_checkin  date,
  target        text,
  notes         text,
  notion_id     text unique,
  updated_at    timestamptz not null default now()
);

-- ------------------------------------------------------------
-- 8. AGENT MEMORY  (the "gets wiser" layer)
--    Durable facts/preferences/observations per domain agent.
-- ------------------------------------------------------------
create table if not exists agent_memory (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null default auth.uid(),
  domain      text not null,   -- home | perso | fortior | finance | health | fitness
  kind        text not null,   -- fact | preference | observation
  content     text not null,   -- e.g. "Passes on owner-dependent firms"
  confidence  text default 'medium',
  source      text,            -- how it was learned (conversation id, sync, manual)
  created_at  timestamptz not null default now(),
  last_seen   timestamptz not null default now()
);
create index if not exists agent_memory_domain_idx on agent_memory(domain);

-- ------------------------------------------------------------
-- 9. AGENT MESSAGES  (conversation history per domain agent)
-- ------------------------------------------------------------
create table if not exists agent_messages (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null default auth.uid(),
  domain      text not null,
  role        text not null,   -- user | assistant
  content     text not null,
  created_at  timestamptz not null default now()
);
create index if not exists agent_messages_domain_idx on agent_messages(domain, created_at);

-- ============================================================
-- updated_at triggers
-- ============================================================
do $$
declare t text;
begin
  foreach t in array array['priorities','fortior_tasks','rocket_targets',
      'personal_budget','biomarkers','training_programs','goals_habits']
  loop
    execute format('drop trigger if exists trg_touch on %I;', t);
    execute format('create trigger trg_touch before update on %I
      for each row execute function touch_updated_at();', t);
  end loop;
end $$;

-- ============================================================
-- Row-level security: owner-only access
-- ============================================================
do $$
declare t text;
begin
  foreach t in array array['priorities','fortior_tasks','rocket_targets',
      'personal_budget','biomarkers','training_programs','goals_habits',
      'agent_memory','agent_messages']
  loop
    execute format('alter table %I enable row level security;', t);
    execute format('drop policy if exists owner_all on %I;', t);
    execute format($f$create policy owner_all on %I
      for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());$f$, t);
  end loop;
end $$;

-- NOTE: the sync job (service role) bypasses RLS; it must set
-- owner_id to Cedric's auth.users id on every upserted row.

-- ------------------------------------------------------------
-- 10. REMINDER ACKS  ("Looking ahead" tick state)
--     The reminder catalogue (school holidays etc.) lives in the
--     frontend; this table only records which reminder instances
--     the owner has ticked, so a nudge stays until ticked.
-- ------------------------------------------------------------
create table if not exists reminder_acks (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null default auth.uid(),
  key         text not null,          -- per-instance id, e.g. 'naima-oct-half-term-2026'
  created_at  timestamptz not null default now(),
  unique (owner_id, key)
);
alter table reminder_acks enable row level security;
drop policy if exists owner_all on reminder_acks;
create policy owner_all on reminder_acks
  for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());

-- ------------------------------------------------------------
-- 11. HABIT CHECK-INS  (completion history — the coach's memory
--     of adherence over time; goals_habits.last_checkin is only
--     the latest tick, this is every tick).
-- ------------------------------------------------------------
create table if not exists habit_checkins (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null default auth.uid(),
  habit_id    uuid not null references goals_habits(id) on delete cascade,
  date        date not null,
  created_at  timestamptz not null default now(),
  unique (owner_id, habit_id, date)
);
create index if not exists habit_checkins_idx on habit_checkins(owner_id, habit_id, date);
alter table habit_checkins enable row level security;
drop policy if exists owner_all on habit_checkins;
create policy owner_all on habit_checkins
  for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());

-- ------------------------------------------------------------
-- 12. MAIL TASKS SEEN  (idempotency for the Gmail→Notion Fortior
--     task extractor — which Gmail messages were already triaged,
--     so a re-run never duplicates a task). Service-role only.
-- ------------------------------------------------------------
create table if not exists mail_tasks_seen (
  id             uuid primary key default gen_random_uuid(),
  owner_id       uuid not null,
  gmail_id       text not null,
  notion_page_id text,
  created_at     timestamptz not null default now(),
  unique (owner_id, gmail_id)
);
create index if not exists mail_tasks_seen_idx on mail_tasks_seen(owner_id, gmail_id);
alter table mail_tasks_seen enable row level security;  -- no policy: anon denied, service-role bypasses

-- ------------------------------------------------------------
-- 13. PENSION  (monthly snapshots pushed by the pension-workbook
--     agent via /api/pension-update; Finance screen reads latest).
--     One row per as-of date, so we also get value-over-time.
-- ------------------------------------------------------------
create table if not exists pension (
  id           uuid primary key default gen_random_uuid(),
  owner_id     uuid not null default auth.uid(),
  as_of        date not null,
  total_value  numeric,
  blended_ocf  numeric,
  mtd_return   numeric,        -- blended total return, month-to-date (%)
  qtd_return   numeric,        -- blended total return, quarter-to-date (%)
  ytd_return   numeric,        -- blended total return, year-to-date (%)
  funds        jsonb,          -- [{name, isin, weight(0-1), value, ocf, qtd}]
  updated_at   timestamptz not null default now(),
  unique (owner_id, as_of)
);
alter table pension enable row level security;
drop policy if exists owner_all on pension;
create policy owner_all on pension
  for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());

-- ------------------------------------------------------------
-- 14. MARATHON WEEKS  (NYC Marathon "Weekly Log — Plan vs Actual"
--     Notion DB → synced; Fitness screen shows plan vs actual).
-- ------------------------------------------------------------
create table if not exists marathon_weeks (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid(),
  notion_id text unique,
  week_num int, week_title text,
  date_start date, date_end date, phase text,
  planned_km numeric, actual_km numeric, planned_runs numeric, actual_runs numeric,
  moving_min numeric, elevation_m numeric, relative_effort numeric,
  avg_hr numeric, cadence_spm numeric, strength_done numeric,
  compliance text, verdict text, red_flags text,
  updated_at timestamptz not null default now()
);
alter table marathon_weeks enable row level security;
drop policy if exists owner_all on marathon_weeks;
create policy owner_all on marathon_weeks for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());

-- ------------------------------------------------------------
-- 15. STRENGTH LOGS  (per-exercise weights for the Fitness ·
--     Strength "Reload & Run" plan; edited on the dashboard).
-- ------------------------------------------------------------
create table if not exists strength_logs (
  owner_id     uuid not null default auth.uid(),
  exercise_key text not null,
  weight       text,
  updated_at   timestamptz not null default now(),
  primary key (owner_id, exercise_key)
);
alter table strength_logs enable row level security;
drop policy if exists owner_all on strength_logs;
create policy owner_all on strength_logs for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());

-- ------------------------------------------------------------
-- 16. STRAVA ACTIVITIES  (synced from Strava; Fitness screen uses
--     them for per-day actual km + per-week run/elliptical time).
-- ------------------------------------------------------------
create table if not exists strava_activities (
  owner_id      uuid not null default auth.uid(),
  activity_id   bigint not null,
  start_date    timestamptz,
  local_date    date,
  sport_type    text,
  distance_m    numeric,
  moving_time_s int,
  name          text,
  updated_at    timestamptz not null default now(),
  primary key (owner_id, activity_id)
);
alter table strava_activities enable row level security;
drop policy if exists owner_all on strava_activities;
create policy owner_all on strava_activities for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());

-- ============================================================
-- v1.1 migration — run this if schema v1 is already applied.
-- training_programs was missing its Notion sync key.
-- ============================================================
alter table training_programs add column if not exists notion_id text unique;

-- ============================================================
-- 16. GUT HEALTH  (Biomesight stool panels)
--     One row per test in gut_tests; metrics / taxa / highlights /
--     protocol / foods / targets hang off it. The Health > Gut Health
--     tab in index.html renders entirely from these tables — "prior"
--     and "latest" are simply the last two gut_tests rows by date, so
--     adding a new test re-points the whole screen.
-- ============================================================
create table if not exists gut_tests (
  id               uuid primary key default gen_random_uuid(),
  owner_id         uuid not null default auth.uid(),
  test_date        date not null,
  label            text,                      -- Baseline | Re-test · 8 months
  provider         text default 'Biomesight',
  species_detected int,
  source_file      text,
  notes            text,
  updated_at       timestamptz not null default now(),
  unique (owner_id, test_date)
);

-- Scores, radar axes, functional markers and structural ratios all share
-- one shape: a named value with an optional target and verdict.
create table if not exists gut_metrics (
  id               uuid primary key default gen_random_uuid(),
  owner_id         uuid not null default auth.uid(),
  test_id          uuid not null references gut_tests(id) on delete cascade,
  category         text not null,   -- score | radar | functional | structure
  key              text not null,
  label            text not null,
  value            numeric,
  unit             text,
  target_value     numeric,
  target_text      text,
  percentile       int,
  status           text,            -- Optimal | Satisfactory | High | Low
  note             text,
  sort             int default 0,
  higher_is_better boolean not null default true,
  updated_at       timestamptz not null default now(),
  unique (owner_id, test_id, category, key)
);

-- Relative abundance per organism, per test. `groups` tags which dashboard
-- list a row belongs to: tracked | butyrate | phylum.
create table if not exists gut_taxa (
  id               uuid primary key default gen_random_uuid(),
  owner_id         uuid not null default auth.uid(),
  test_id          uuid not null references gut_tests(id) on delete cascade,
  name             text not null,
  taxon_rank       text,            -- phylum | genus | species
  abundance_pct    numeric,
  higher_is_better boolean default true,   -- null = no meaningful direction
  status           text,            -- improved | progress | concern | danger
  groups           text[] not null default '{}',
  note             text,
  sort             int default 0,
  updated_at       timestamptz not null default now(),
  unique (owner_id, test_id, name)
);

create table if not exists gut_highlights (
  id         uuid primary key default gen_random_uuid(),
  owner_id   uuid not null default auth.uid(),
  test_id    uuid references gut_tests(id) on delete cascade,
  kind       text not null,   -- win | concern
  headline   text not null,
  detail     text,
  sort       int default 0,
  updated_at timestamptz not null default now()
);

-- The forward plan. Not tied to one test, but records which test it was
-- derived from so a re-test can supersede it.
create table if not exists gut_protocol (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null default auth.uid(),
  test_id     uuid references gut_tests(id) on delete set null,
  phase       text not null,
  phase_order int not null default 0,
  phase_color text,            -- ok | info | warn | bad (maps to CSS tokens)
  name        text not null,
  item_type   text,            -- Probiotic | Prebiotic | Polyphenol | ...
  dose        text,
  target      text,
  why         text,
  status      text default 'active',   -- active | stop | reduce
  sort        int default 0,
  updated_at  timestamptz not null default now()
);

create table if not exists gut_foods (
  id         uuid primary key default gen_random_uuid(),
  owner_id   uuid not null default auth.uid(),
  test_id    uuid references gut_tests(id) on delete set null,
  emoji      text,
  name       text not null,
  frequency  text,
  targets    text[] not null default '{}',
  note       text,
  reduce     boolean not null default false,
  sort       int default 0,
  updated_at timestamptz not null default now()
);

create table if not exists gut_targets (
  id           uuid primary key default gen_random_uuid(),
  owner_id     uuid not null default auth.uid(),
  label        text not null,
  current_text text,
  target_text  text,
  sort         int default 0,
  updated_at   timestamptz not null default now()
);

create index if not exists gut_tests_date_idx      on gut_tests(owner_id, test_date);
create index if not exists gut_metrics_test_idx    on gut_metrics(test_id, category, sort);
create index if not exists gut_taxa_test_idx       on gut_taxa(test_id, sort);
create index if not exists gut_taxa_groups_idx     on gut_taxa using gin(groups);
create index if not exists gut_highlights_test_idx on gut_highlights(test_id, kind, sort);
create index if not exists gut_protocol_phase_idx  on gut_protocol(owner_id, phase_order, sort);
create index if not exists gut_foods_sort_idx      on gut_foods(owner_id, sort);
create index if not exists gut_targets_sort_idx    on gut_targets(owner_id, sort);

do $$
declare t text;
begin
  foreach t in array array['gut_tests','gut_metrics','gut_taxa','gut_highlights',
      'gut_protocol','gut_foods','gut_targets']
  loop
    execute format('drop trigger if exists trg_touch on %I;', t);
    execute format('create trigger trg_touch before update on %I
      for each row execute function touch_updated_at();', t);
    execute format('alter table %I enable row level security;', t);
    execute format('drop policy if exists owner_all on %I;', t);
    execute format($f$create policy owner_all on %I
      for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());$f$, t);
  end loop;
end $$;

-- ============================================================
-- 17. GUT SUPPLEMENT SCHEDULE
--     The daily dosing plan derived from gut_protocol: what to take,
--     when, in which phase. Phases carry real dates, so the Gut Health >
--     Supplement Schedule tab opens on whichever phase today falls in.
-- ============================================================
create table if not exists gut_schedule_phases (
  id         uuid primary key default gen_random_uuid(),
  owner_id   uuid not null default auth.uid(),
  key        text not null,          -- m1 | m2 | m4
  label      text not null,          -- Months 1–2
  date_start date,
  date_end   date,
  subtitle   text,
  color      text,                   -- ok | info | warn | bad (CSS token name)
  sort       int default 0,
  updated_at timestamptz not null default now(),
  unique (owner_id, key)
);

create table if not exists gut_schedule_items (
  id         uuid primary key default gen_random_uuid(),
  owner_id   uuid not null default auth.uid(),
  phase_id   uuid not null references gut_schedule_phases(id) on delete cascade,
  time_slot  text not null,          -- morning | midday | evening
  name       text not null,
  dose       text,
  note       text,
  tag        text,                   -- Probiotic | Prebiotic | Detox | Polyphenol |
                                     -- Antimicrobial | Postbiotic | Rx
  sort       int default 0,
  updated_at timestamptz not null default now()
);

-- Standing instructions that aren't a timed dose (3x/week items, food
-- rules, stop/reassess flags).
create table if not exists gut_schedule_notes (
  id         uuid primary key default gen_random_uuid(),
  owner_id   uuid not null default auth.uid(),
  phase_id   uuid not null references gut_schedule_phases(id) on delete cascade,
  text       text not null,
  tag        text,                   -- 3x/week | Stop | Food | Reassess | New | Rx
  sort       int default 0,
  updated_at timestamptz not null default now()
);

create index if not exists gut_sched_phase_idx on gut_schedule_phases(owner_id, sort);
create index if not exists gut_sched_item_idx  on gut_schedule_items(phase_id, time_slot, sort);
create index if not exists gut_sched_note_idx  on gut_schedule_notes(phase_id, sort);

do $$
declare t text;
begin
  foreach t in array array['gut_schedule_phases','gut_schedule_items','gut_schedule_notes']
  loop
    execute format('drop trigger if exists trg_touch on %I;', t);
    execute format('create trigger trg_touch before update on %I
      for each row execute function touch_updated_at();', t);
    execute format('alter table %I enable row level security;', t);
    execute format('drop policy if exists owner_all on %I;', t);
    execute format($f$create policy owner_all on %I
      for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());$f$, t);
  end loop;
end $$;
