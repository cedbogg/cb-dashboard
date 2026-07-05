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

-- ============================================================
-- v1.1 migration — run this if schema v1 is already applied.
-- training_programs was missing its Notion sync key.
-- ============================================================
alter table training_programs add column if not exists notion_id text unique;
