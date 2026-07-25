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
  if (!token) return { ok: false, why: 'no session token — sign out and back in on the dashboard, then retry' };
  if (!OWNER) return { ok: false, why: 'OWNER_USER_ID not set on server' };
  const { data, error } = await sb.auth.getUser(token);
  if (error) return { ok: false, why: 'dashboard session expired — sign out (lock icon, top-right) and back in, then retry [' + error.message + ']' };
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
  if (!r.ok || !data.access_token) {
    // Surface the error CODE too — invalid_client vs invalid_grant need different fixes.
    throw new Error(`${data.error || 'token_error'}: ${data.error_description || 'token exchange failed'}`);
  }
  return data.access_token;
}

const header = (msg, name) => (msg.payload?.headers || []).find(h => h.name.toLowerCase() === name.toLowerCase())?.value || '';

async function gmailFetch(token, path) {
  const r = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/' + path, { headers: { Authorization: `Bearer ${token}` } });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error?.message || `Gmail ${r.status}`);
  return j;
}

// Full thread context, including Cedric's own SENT replies, so Claude can judge
// what has already been handled.
async function threadContext(token, threadId, ref) {
  const t = await gmailFetch(token, `threads/${threadId}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`);
  const messages = (t.messages || []).map(m => ({
    from: header(m, 'From'),
    sent: (m.labelIds || []).includes('SENT'),
    snippet: (m.snippet || '').slice(0, 300)
  }));
  return { ref, threadId, subject: header((t.messages || [])[0] || {}, 'Subject'), messages, msgIds: (t.messages || []).map(m => m.id) };
}

// Classify each thread: todo (outstanding), done (already handled — e.g. Cedric
// replied/paid/sent the info), or skip (no action). SENT messages are the
// evidence of completion.
async function judgeThreads(threads) {
  if (!threads.length) return [];
  const body = threads.map(t => {
    const conv = t.messages.map(m => `  - [${m.sent ? 'CEDRIC (SENT)' : 'FROM ' + m.from}] ${m.snippet}`).join('\n');
    return `ref=${t.ref}\nSubject: ${t.subject}\n${conv}`;
  }).join('\n\n');
  const system = `You triage email threads for Cedric. "Fortior" is both his UK compliance-business buyout project AND his holding-company admin (banking, tax, Companies House, invoices). For each thread output one status:
- "todo": Cedric still needs to act (pay, reply, chase/send a document, provide info, book/attend, sign, file).
- "done": it has ALREADY been handled — e.g. a CEDRIC (SENT) message confirms payment, provides the requested info, or otherwise resolves it.
- "skip": no action needed (newsletter, marketing, FYI, plain receipt/confirmation).
Treat CEDRIC (SENT) messages as strong evidence of what is already done. Only include a due date if one is explicitly stated in the thread.
Return ONLY a JSON array, no prose:
[{"ref":"<ref>","status":"todo|done|skip","task":"<imperative, <=90 chars, only when todo>","due":"YYYY-MM-DD or null"}]`;
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-sonnet-5', max_tokens: 2000, system, messages: [{ role: 'user', content: body }] })
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error?.message || 'anthropic error');
  let text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();
  text = text.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try { const arr = JSON.parse(text); return Array.isArray(arr) ? arr : []; } catch { return []; }
}

const norm = s => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();

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

  let stage = 'init';
  try {
    const notion = new Client({ auth: process.env.NOTION_TOKEN });
    stage = 'google-token'; const token = await googleAccessToken();
    stage = 'notion-retrieve';
    const schema = await notion.databases.retrieve({ database_id: dbId });
    const titleName = Object.keys(schema.properties).find(k => schema.properties[k].type === 'title');

    const markDone = async (pageId) => {
      await sb.from('fortior_tasks').update({ status: 'Done' }).eq('owner_id', OWNER).eq('notion_id', pageId);
      try { const p = propPayload(schema, 'Status', 'Done'); if (p) await notion.pages.update({ page_id: pageId, properties: { Status: p } }); } catch {}
    };
    let closed = 0;

    // 1. Collapse duplicate open Gmail tasks (same text) — keep the first.
    stage = 'dedupe';
    const { data: openTasks } = await sb.from('fortior_tasks')
      .select('notion_id,task').eq('owner_id', OWNER).eq('source', 'Gmail').neq('status', 'Done');
    const survivors = new Map();       // norm(text) -> notion_id kept
    for (const t of (openTasks || [])) {
      const key = norm(t.task);
      if (survivors.has(key)) { await markDone(t.notion_id); closed++; }
      else survivors.set(key, t.notion_id);
    }
    const openNorms = new Set(survivors.keys());
    const openIds = new Set(survivors.values());

    // 2. Reconcile still-open tasks: mark done if their thread is now handled
    //    (e.g. Cedric has since replied confirming payment / sent the info).
    const { data: createdSeen } = await sb.from('mail_tasks_seen')
      .select('gmail_id,notion_page_id').eq('owner_id', OWNER).not('notion_page_id', 'is', null);
    const reconThreads = [];
    for (const row of (createdSeen || [])) {
      if (!openIds.has(row.notion_page_id)) continue;   // task already closed
      stage = 'gmail';
      let msg; try { msg = await gmailFetch(token, `messages/${row.gmail_id}?format=minimal`); } catch { continue; }
      try { reconThreads.push(await threadContext(token, msg.threadId, 'DONE:' + row.notion_page_id)); } catch {}
    }
    stage = 'claude';
    for (const j of await judgeThreads(reconThreads)) {
      if (j.status === 'done' && String(j.ref).startsWith('DONE:')) { await markDone(String(j.ref).slice(5)); closed++; }
    }

    // 3. New candidates: search Fortior mail, one per thread, judge, create.
    stage = 'gmail';
    const list = await gmailFetch(token, 'messages?maxResults=30&q=' + encodeURIComponent('Fortior newer_than:45d -in:chats'));
    const { data: seen } = await sb.from('mail_tasks_seen').select('gmail_id').eq('owner_id', OWNER);
    const seenSet = new Set((seen || []).map(s => s.gmail_id));
    const freshByThread = new Map();   // threadId -> representative msgId
    for (const m of (list.messages || [])) {
      if (seenSet.has(m.id)) continue;
      if (!freshByThread.has(m.threadId)) freshByThread.set(m.threadId, m.id);
      if (freshByThread.size >= MAX_NEW) break;
    }
    const newThreads = [];
    for (const [threadId, repId] of freshByThread) {
      try { newThreads.push(await threadContext(token, threadId, 'NEW:' + repId)); } catch {}
    }
    stage = 'claude';
    const newJudged = await judgeThreads(newThreads);

    stage = 'notion-create';
    let created = 0;
    const taskMsgIds = new Set();
    for (const j of newJudged) {
      const repId = String(j.ref).startsWith('NEW:') ? String(j.ref).slice(4) : null;
      if (!repId || j.status !== 'todo' || !j.task) continue;
      const key = norm(j.task);
      if (openNorms.has(key)) continue;               // already on the board
      openNorms.add(key);
      const link = `https://mail.google.com/mail/u/0/#all/${repId}`;
      const props = {};
      const set = (name, val) => { const p = propPayload(schema, name, val); if (p) props[name] = p; };
      set(titleName, j.task); set('Type', 'Email'); set('Status', 'To do');
      set('Source', 'Gmail'); set('Link', link); if (j.due) set('Due date', j.due);
      const page = await notion.pages.create({ parent: { database_id: dbId }, properties: props });
      await sb.from('fortior_tasks').upsert(
        { owner_id: OWNER, notion_id: page.id, task: j.task, type: 'Email', status: 'To do', due_date: j.due || null, source: 'Gmail', link },
        { onConflict: 'notion_id' });
      await sb.from('mail_tasks_seen').insert({ owner_id: OWNER, gmail_id: repId, notion_page_id: page.id });
      taskMsgIds.add(repId); created++;
    }
    // Mark every other message in the scanned threads as seen (null) so we don't
    // re-triage them — but never overwrite an existing row.
    const allIds = new Set();
    newThreads.forEach(nt => (nt.msgIds || []).forEach(id => allIds.add(id)));
    const toRecord = [...allIds].filter(id => !taskMsgIds.has(id) && !seenSet.has(id))
      .map(id => ({ owner_id: OWNER, gmail_id: id, notion_page_id: null }));
    if (toRecord.length) await sb.from('mail_tasks_seen').upsert(toRecord, { onConflict: 'owner_id,gmail_id' });

    res.status(200).json({ ok: true, scanned: newThreads.length, created, closed });
  } catch (e) {
    const msg = String(e.message || e);
    const cid = (process.env.GOOGLE_CLIENT_ID || '').split('.')[0] || '(GOOGLE_CLIENT_ID unset)';
    let hint = '';
    if (/expired or revoked|invalid_grant/i.test(msg)) {
      const rt = process.env.GOOGLE_REFRESH_TOKEN || '';
      hint = ` — the GOOGLE_REFRESH_TOKEN in Vercel is wrong/stale. It currently ends "${rt.slice(-6) || '(empty)'}" and is ${rt.length} chars long. It should end "S95HoI" and be 103 chars. If it doesn't match, re-paste it and redeploy.`;
    }
    else if (/invalid_client/i.test(msg))
      hint = ` — GOOGLE_CLIENT_ID/SECRET in Vercel are wrong (app expects client [${cid}]).`;
    else if (/insufficient|scope|ACCESS_TOKEN|forbidden|403/i.test(msg))
      hint = ' — token may lack gmail.readonly; re-authorise with Gmail enabled.';
    else if (stage === 'gmail')
      hint = ' — Gmail API rejected the token (missing gmail.readonly scope, or Gmail API not enabled in the Cloud project).';
    else if (stage === 'claude')
      hint = ' — Claude API rejected the request (check ANTHROPIC_API_KEY in Vercel).';
    else if (stage.startsWith('notion'))
      hint = ' — Notion rejected it (share the Fortior Tasks DB with the integration, or check NOTION_TOKEN / NOTION_TASKS_DB_ID).';
    res.status(502).json({ error: `[${stage}] ${msg}${hint}` });
  }
}
