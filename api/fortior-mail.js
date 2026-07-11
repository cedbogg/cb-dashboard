// Gmail → Notion Fortior tasks. Searches Gmail for mail mentioning "Fortior",
// asks Claude to extract genuine action items, and writes them into the Notion
// Fortior Tasks DB (source of truth). The normal Notion→Supabase sync then
// surfaces them in the dashboard's "Things to do". Deduped by Gmail message id
// via mail_tasks_seen so a re-run never creates the same task twice.
//
// Auth: Vercel cron (Bearer CRON_SECRET) OR the authenticated owner (Supabase
// session token) for the manual "Scan Gmail" button.
//
// Env: GOOGLE_CLIENT_ID/SECRET/REFRESH_TOKEN (refresh token MUST include the
// gmail.readonly scope), NOTION_TOKEN, NOTION_TASKS_DB_ID, ANTHROPIC_API_KEY,
// SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, OWNER_USER_ID, CRON_SECRET.

import { Client } from '@notionhq/client';
import { createClient } from '@supabase/supabase-js';

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const OWNER = process.env.OWNER_USER_ID;
const MAX_NEW = 15;         // emails to process per run (bounds cost)

async function authInfo(req) {
  const auth = req.headers.authorization || '';
  const secret = process.env.CRON_SECRET;
  // Cron path: if CRON_SECRET is set, Vercel sends it as a Bearer token; if it's
  // not set, accept Vercel's own cron user-agent (deployment protection already
  // blocks arbitrary external callers).
  if (secret) { if (auth === `Bearer ${secret}`) return { ok: true }; }
  else if ((req.headers['user-agent'] || '').includes('vercel-cron')) return { ok: true };
  // Owner path: manual "Scan Gmail" button sends the Supabase session token.
  const token = auth.replace(/^Bearer\s+/i, '');
  if (!token) return { ok: false, why: 'no session token sent (are you logged into the dashboard?)' };
  if (!OWNER) return { ok: false, why: 'OWNER_USER_ID not set on server' };
  const { data, error } = await sb.auth.getUser(token);
  if (error) return { ok: false, why: 'token rejected: ' + error.message };
  if (data?.user?.id !== OWNER) return { ok: false, why: 'user-id mismatch (token ok, but not the owner)' };
  return { ok: true };
}

async function googleAccessToken() {
  const body = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    client_secret: process.env.GOOGLE_CLIENT_SECRET,
    refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
    grant_type: 'refresh_token'
  });
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body
  });
  const data = await r.json();
  if (!r.ok || !data.access_token) throw new Error(data.error_description || data.error || 'token exchange failed');
  return data.access_token;
}

const header = (msg, name) => (msg.payload?.headers || []).find(h => h.name.toLowerCase() === name.toLowerCase())?.value || '';

async function gmailCandidates(token) {
  const list = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=25&q=' +
    encodeURIComponent('Fortior newer_than:45d -in:chats'), { headers: { Authorization: `Bearer ${token}` } });
  const lj = await list.json();
  if (!list.ok) throw new Error(lj.error?.message || `Gmail list ${list.status}`);
  const ids = (lj.messages || []).map(m => m.id);
  // Drop ones we've already processed.
  const { data: seen } = await sb.from('mail_tasks_seen').select('gmail_id').eq('owner_id', OWNER);
  const seenSet = new Set((seen || []).map(s => s.gmail_id));
  const fresh = ids.filter(id => !seenSet.has(id)).slice(0, MAX_NEW);

  const out = [];
  for (const id of fresh) {
    const r = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`,
      { headers: { Authorization: `Bearer ${token}` } });
    const m = await r.json();
    if (!r.ok) continue;
    out.push({ id, subject: header(m, 'Subject'), from: header(m, 'From'), snippet: m.snippet || '' });
  }
  return out;
}

async function extractTasks(mails) {
  if (!mails.length) return [];
  const list = mails.map((m, i) => `#${i} | id=${m.id}\nSubject: ${m.subject}\nFrom: ${m.from}\nSnippet: ${m.snippet}`).join('\n\n');
  const system = `You triage email for Cedric, who is buying a UK compliance business (project "Fortior"). For each email decide if it implies a concrete action Cedric must take (reply, send/chase a document, book/attend a call, sign, pay, file). Ignore pure newsletters, marketing, FYIs and receipts.
Return ONLY a JSON array, one object per email that IS actionable, no prose:
[{"id":"<gmail id>","task":"<imperative, <=90 chars>","type":"Email","due":"YYYY-MM-DD or null"}]
If none are actionable, return [].`;
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-sonnet-5', max_tokens: 1500, system, messages: [{ role: 'user', content: list }] })
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error?.message || 'anthropic error');
  let text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();
  text = text.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try { const arr = JSON.parse(text); return Array.isArray(arr) ? arr : []; } catch { return []; }
}

// Build a Notion property payload matching each property's actual type, so we
// don't guess (select/status/date/url/rich_text all differ). status options
// can't be created via API, so only set one that already exists.
function propPayload(schema, name, value) {
  const p = schema.properties?.[name];
  if (!p || value == null || value === '') return null;
  const s = String(value).slice(0, 1900);
  switch (p.type) {
    case 'title':       return { title: [{ text: { content: s } }] };
    case 'rich_text':   return { rich_text: [{ text: { content: s } }] };
    case 'url':         return { url: s };
    case 'date':        return { date: { start: s } };
    case 'select':      return { select: { name: s } };
    case 'multi_select':return { multi_select: [{ name: s }] };
    case 'status':      return (p.status?.options || []).some(o => o.name === s) ? { status: { name: s } } : null;
    default:            return null;
  }
}

export default async function handler(req, res) {
  const auth = await authInfo(req);
  if (!auth.ok) return res.status(401).json({ error: 'auth failed — ' + auth.why });
  const dbId = process.env.NOTION_TASKS_DB_ID;
  if (!dbId) return res.status(500).json({ error: 'NOTION_TASKS_DB_ID not set' });

  try {
    const notion = new Client({ auth: process.env.NOTION_TOKEN });
    const token = await googleAccessToken();
    const mails = await gmailCandidates(token);
    const actions = await extractTasks(mails);
    const byId = Object.fromEntries(mails.map(m => [m.id, m]));

    const schema = await notion.databases.retrieve({ database_id: dbId });
    const titleName = Object.keys(schema.properties).find(k => schema.properties[k].type === 'title');

    let created = 0;
    const actedIds = new Set();
    for (const a of actions) {
      const mail = byId[a.id]; if (!mail || !a.task) continue;
      const link = `https://mail.google.com/mail/u/0/#all/${a.id}`;
      const notes = `From ${mail.from} — ${mail.subject}`;
      const props = {};
      const set = (name, val) => { const p = propPayload(schema, name, val); if (p) props[name] = p; };
      set(titleName, a.task);
      set('Type', a.type || 'Email');
      set('Status', 'To do');
      set('Source', 'Gmail');
      set('Link', link);
      set('Notes', notes);
      if (a.due) set('Due date', a.due);
      const page = await notion.pages.create({ parent: { database_id: dbId }, properties: props });
      // Mirror into fortior_tasks now (keyed on the Notion page id) so it shows
      // on the dashboard immediately; the next Notion→Supabase sync upserts the
      // same notion_id, so this never duplicates.
      await sb.from('fortior_tasks').upsert(
        { owner_id: OWNER, notion_id: page.id, task: a.task, type: a.type || 'Email', status: 'To do', due_date: a.due || null, source: 'Gmail', link },
        { onConflict: 'notion_id' });
      await sb.from('mail_tasks_seen').insert({ owner_id: OWNER, gmail_id: a.id, notion_page_id: page.id });
      actedIds.add(a.id); created++;
    }
    // Record the non-actionable ones too, so we don't re-triage them next run.
    const noAction = mails.filter(m => !actedIds.has(m.id)).map(m => ({ owner_id: OWNER, gmail_id: m.id, notion_page_id: null }));
    if (noAction.length) await sb.from('mail_tasks_seen').upsert(noAction, { onConflict: 'owner_id,gmail_id' });

    res.status(200).json({ ok: true, scanned: mails.length, created, note: created ? 'Tasks written to Notion; they appear on the dashboard after the next Notion→Supabase sync.' : 'No new action items found.' });
  } catch (e) {
    const msg = String(e.message || e);
    const hint = /insufficient|scope|ACCESS_TOKEN|forbidden|403/i.test(msg)
      ? ' — the Google token may lack the gmail.readonly scope; re-authorise with Gmail enabled.' : '';
    res.status(502).json({ error: msg + hint });
  }
}
