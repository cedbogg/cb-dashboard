// Notion → Supabase sync (cron). Pulls each configured Notion database and
// upserts into its matching table (rocket_targets, fortior_tasks, goals_habits,
// priorities, training_programs). Runs on the schedule in vercel.json, and can
// be triggered manually by hitting /api/sync-notion.
//
// Env required (server only):
//   NOTION_TOKEN            internal integration token (share the DBs with it)
//   NOTION_ROCKET_DB_ID     Notion database id for "Rocket Sourcing Log"
//   NOTION_TASKS_DB_ID      Notion database id for "Fortior Tasks"
//   NOTION_GOALS_DB_ID      Notion database id for "Goals & Habits" (optional)
//   NOTION_PRIORITIES_DB_ID Notion database id for "Priorities" (optional)
//   NOTION_TRAINING_DB_ID   Notion database id for "Training Programs" (optional)
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//   OWNER_USER_ID           Cedric's auth.users id, stamped on every row
//
// The three "optional" tables no-op (skipped) until their env var is set, so
// adding them is safe at any time — see syncTable's `!dbId` guard below.

import { Client } from '@notionhq/client';
import { createClient } from '@supabase/supabase-js';

const notion = new Client({ auth: process.env.NOTION_TOKEN });
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const OWNER = process.env.OWNER_USER_ID;

// --- Notion property readers -------------------------------------------------
function readProp(props, name) {
  const key = Object.keys(props).find(
    k => k.toLowerCase().trim() === name.toLowerCase().trim()
  );
  if (!key) return null;
  const p = props[key];
  switch (p.type) {
    case 'title':       return p.title.map(t => t.plain_text).join('').trim() || null;
    case 'rich_text':   return p.rich_text.map(t => t.plain_text).join('').trim() || null;
    case 'number':      return p.number;
    case 'select':      return p.select?.name ?? null;
    case 'status':      return p.status?.name ?? null;
    case 'multi_select':return p.multi_select.map(s => s.name).join(', ') || null;
    case 'date':        return p.date?.start ?? null;
    case 'url':         return p.url ?? null;
    case 'checkbox':    return p.checkbox;
    case 'formula':     return p.formula?.[p.formula.type] ?? null;
    default:            return null;
  }
}

const toNum = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : null;
};
const toDate = (v) => (v ? String(v).slice(0, 10) : null);

async function fetchAllPages(database_id) {
  const pages = [];
  let cursor;
  do {
    const resp = await notion.databases.query({
      database_id,
      start_cursor: cursor,
      page_size: 100
    });
    pages.push(...resp.results);
    cursor = resp.has_more ? resp.next_cursor : undefined;
  } while (cursor);
  return pages;
}

// --- Mappers -----------------------------------------------------------------
function mapRocket(page) {
  const p = page.properties;
  return {
    owner_id: OWNER,
    notion_id: page.id,
    business: readProp(p, 'Business'),
    lane: readProp(p, 'Lane'),
    score: toNum(readProp(p, 'Score')),
    teaser_status: readProp(p, 'Teaser'),
    stage: readProp(p, 'Stage'),
    ebitda_gbp: toNum(readProp(p, 'EBITDA')),
    location: readProp(p, 'Location'),
    status: readProp(p, 'Status'),
    date_first_seen: toDate(readProp(p, 'Date First Seen')),
    last_contact: toDate(readProp(p, 'last contact')),
    source: readProp(p, 'Source')
  };
}

function mapTask(page) {
  const p = page.properties;
  return {
    owner_id: OWNER,
    notion_id: page.id,
    task: readProp(p, 'Task'),
    type: readProp(p, 'Type'),
    status: readProp(p, 'Status'),
    due_date: toDate(readProp(p, 'Due date')),
    source: readProp(p, 'Source'),
    link: readProp(p, 'Link'),
    notes: readProp(p, 'Notes')
  };
}

function mapGoal(page) {
  const p = page.properties;
  return {
    owner_id: OWNER,
    notion_id: page.id,
    name: readProp(p, 'Name'),
    type: readProp(p, 'Type'),
    area: readProp(p, 'Area'),
    cadence: readProp(p, 'Cadence'),
    status: readProp(p, 'Status'),
    last_checkin: toDate(readProp(p, 'Last check-in')),
    target: readProp(p, 'Target'),
    notes: readProp(p, 'Notes')
  };
}

function mapPriority(page) {
  const p = page.properties;
  return {
    owner_id: OWNER,
    notion_id: page.id,
    project: readProp(p, 'Project'),
    category: readProp(p, 'Category'),
    status: readProp(p, 'Status'),
    next_action: readProp(p, 'Next action'),
    next_action_date: toDate(readProp(p, 'Next action date')),
    source_link: readProp(p, 'Source link') || readProp(p, 'Link')
  };
}

function mapTraining(page) {
  const p = page.properties;
  return {
    owner_id: OWNER,
    notion_id: page.id,
    program: readProp(p, 'Program'),
    discipline: readProp(p, 'Discipline'),
    status: readProp(p, 'Status'),
    start_date: toDate(readProp(p, 'Start date')),
    progression_notes: readProp(p, 'Progression notes'),
    program_link: readProp(p, 'Program link') || readProp(p, 'Link')
  };
}

async function syncTable(dbId, table, mapper, onMissing) {
  if (!dbId) return { table, skipped: 'no database id configured' };
  const pages = await fetchAllPages(dbId);
  const rows = pages.map(mapper).filter(r => r.notion_id);
  if (rows.length) {
    const { error } = await sb.from(table).upsert(rows, { onConflict: 'notion_id' });
    if (error) throw new Error(`${table}: ${error.message}`);
  }
  // Reconcile: rows that vanished from Notion (deleted/archived) shouldn't
  // haunt the dashboard. `onMissing` decides what to do with them.
  let reconciled = 0;
  const seen = new Set(rows.map(r => r.notion_id));
  const { data: existing, error: exErr } = await sb.from(table)
    .select('notion_id').eq('owner_id', OWNER).not('notion_id', 'is', null);
  if (exErr) throw new Error(`${table} reconcile: ${exErr.message}`);
  const missing = (existing || []).map(r => r.notion_id).filter(id => !seen.has(id));
  if (missing.length) {
    const { error } = await onMissing(missing);
    if (error) throw new Error(`${table} reconcile: ${error.message}`);
    reconciled = missing.length;
  }
  return { table, upserted: rows.length, reconciled };
}

export default async function handler(req, res) {
  // Vercel cron sends `Authorization: Bearer ${CRON_SECRET}` automatically when
  // the env var is set; manual triggers must supply the same header.
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.authorization !== `Bearer ${secret}`) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  try {
    if (!OWNER) throw new Error('OWNER_USER_ID not set');
    const results = await Promise.all([
      // targets removed from Notion -> soft-kill (keep the record, mark Dead)
      syncTable(process.env.NOTION_ROCKET_DB_ID, 'rocket_targets', mapRocket,
        (ids) => sb.from('rocket_targets').update({ status: 'Dead' })
          .eq('owner_id', OWNER).in('notion_id', ids).neq('status', 'Dead')),
      // tasks removed from Notion -> delete outright
      syncTable(process.env.NOTION_TASKS_DB_ID, 'fortior_tasks', mapTask,
        (ids) => sb.from('fortior_tasks').delete()
          .eq('owner_id', OWNER).in('notion_id', ids)),
      // goals/habits, priorities, training programs removed from Notion -> delete outright
      syncTable(process.env.NOTION_GOALS_DB_ID, 'goals_habits', mapGoal,
        (ids) => sb.from('goals_habits').delete()
          .eq('owner_id', OWNER).in('notion_id', ids)),
      syncTable(process.env.NOTION_PRIORITIES_DB_ID, 'priorities', mapPriority,
        (ids) => sb.from('priorities').delete()
          .eq('owner_id', OWNER).in('notion_id', ids)),
      syncTable(process.env.NOTION_TRAINING_DB_ID, 'training_programs', mapTraining,
        (ids) => sb.from('training_programs').delete()
          .eq('owner_id', OWNER).in('notion_id', ids))
    ]);
    res.status(200).json({ ok: true, results });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err.message || err) });
  }
}
