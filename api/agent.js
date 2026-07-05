import { createClient } from '@supabase/supabase-js';
import { DOMAINS } from '../lib/domains.js';

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const OWNER = process.env.OWNER_USER_ID;

// Only the authenticated owner may talk to the agents. The frontend sends the
// Supabase session token; we verify it and match it against OWNER_USER_ID.
async function authorized(req) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) return false;
  const { data, error } = await sb.auth.getUser(token);
  return !error && data?.user?.id === OWNER;
}

const gbp = (v) => (v == null ? '?' : v >= 1000 ? `£${Math.round(v / 1e5) / 10}m` : `£${v}m`);
const days = (d) => (d ? Math.max(0, Math.round((Date.now() - new Date(d)) / 86400000)) : null);

// Live data snapshot injected into the system prompt at request time, so the
// agent sees what the dashboard sees (personas in lib/domains.js stay stable).
async function liveContext(domain) {
  if (domain === 'perso') {
    const since90 = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);
    const [{ data: gh }, { data: chk }] = await Promise.all([
      sb.from('goals_habits').select('id,name,type,area,cadence,status,last_checkin,target').eq('owner_id', OWNER),
      sb.from('habit_checkins').select('habit_id,date').eq('owner_id', OWNER).gte('date', since90)
    ]);
    const rows = gh || [];
    const checks = chk || [];
    const PERIOD = { daily: 1, weekly: 7, 'bi-weekly': 14, fortnightly: 14, monthly: 30, quarterly: 90 };
    const per = c => PERIOD[String(c || '').toLowerCase()] || 7;
    const now = Date.now();
    const daysAgo = d => Math.floor((now - new Date(d).getTime()) / 86400000);

    // Habit adherence — the coach's window into what actually gets done.
    const habits = rows.filter(x => x.type === 'Habit' && x.status !== 'Done').map(x => {
      const mine = checks.filter(c => c.habit_id === x.id).map(c => c.date).sort();
      const last = mine.length ? mine[mine.length - 1] : null;
      const d30 = mine.filter(dt => daysAgo(dt) < 30).length;
      const d90 = mine.length;
      const e30 = Math.max(1, Math.round(30 / per(x.cadence)));
      const e90 = Math.max(1, Math.round(90 / per(x.cadence)));
      const lastTxt = last ? `last done ${daysAgo(last)}d ago` : 'never logged';
      return `${x.name} (${x.cadence || '?'}): ${lastTxt}, ${d30}/${e30} in 30d, ${d90}/${e90} in 90d`;
    });

    // Goals — open ones plus the resolved track record (achieved vs not).
    const goalRows = rows.filter(x => x.type === 'Goal');
    const open = goalRows.filter(g => !['Achieved', 'Missed', 'Done'].includes(g.status))
      .map(g => `${g.name}${g.area ? ` [${g.area}]` : ''} (${g.status || 'open'})`);
    const achieved = goalRows.filter(g => ['Achieved', 'Done'].includes(g.status)).map(g => g.name);
    const missed = goalRows.filter(g => g.status === 'Missed').map(g => g.name);
    const resolved = achieved.length + missed.length;
    const hit = resolved ? Math.round((achieved.length / resolved) * 100) : null;

    return `LIVE PERSO DATA (trust this over memory — habit ticks and goal outcomes are logged over time):
- Habit adherence (last 90d): ${habits.join(' | ') || 'none tracked'}.
- Open big goals: ${open.join('; ') || 'none'}.
- Goal track record: achieved [${achieved.join(', ') || 'none'}]; not this time [${missed.join(', ') || 'none'}]${hit != null ? ` — hit-rate ${hit}%` : ''}.
Use adherence + hit-rate to spot patterns (which habits/goal-areas he sustains vs drops), but ask before assuming why. Calendar events, birthdays and holiday reminders are live on the dashboard but not in this snapshot.`;
  }
  if (domain === 'fitness') {
    const { data } = await sb.from('training_programs').select('program,discipline,status,start_date,progression_notes')
      .eq('owner_id', OWNER).neq('status', 'Archived');
    const rows = data || [];
    const list = rows.map(x => `${x.program} (${x.discipline || '?'}, ${x.status || '?'}${x.start_date ? ', started ' + x.start_date : ''}${x.progression_notes ? ' — ' + x.progression_notes : ''})`);
    return `LIVE FITNESS DATA (synced from Notion — trust this over anything else, including memory):
- Programmes: ${list.join('; ') || 'none logged'}.
Note: running/strength session logs (Strava, lift PRs) are not synced yet — don't invent specifics for those.`;
  }
  if (domain === 'fortior' || domain === 'home') {
    const [{ data: targets }, { data: tasks }, { data: pri }] = await Promise.all([
      sb.from('rocket_targets')
        .select('business,location,ebitda_gbp,lane,score,stage,teaser_status,status,last_contact,date_first_seen')
        .eq('owner_id', OWNER),
      sb.from('fortior_tasks')
        .select('task,type,due_date,status').eq('owner_id', OWNER).neq('status', 'Done'),
      domain === 'home'
        ? sb.from('priorities').select('project,category,status,next_action,next_action_date')
            .eq('owner_id', OWNER).neq('status', 'Done')
            .order('next_action_date', { ascending: true, nullsFirst: false })
        : Promise.resolve({ data: null })
    ]);
    const t = targets || [];
    const pursuing = t.filter(x => x.status === 'Pursuing');
    const count = (f) => pursuing.filter(f).length;
    const funnel =
      `teaser requested ${count(x => ['Requested', 'Received'].includes(x.teaser_status))}, ` +
      `received ${count(x => x.teaser_status === 'Received')}, ` +
      `NDA ${count(x => x.stage === 'NDA')}, ` +
      `info/mgmt ${count(x => x.stage === 'Info & mgmt call')}, ` +
      `heads of terms ${count(x => x.stage === 'Heads of terms')}, ` +
      `final offer ${count(x => x.stage === 'Final offer')}, ` +
      `closed ${count(x => x.stage === 'Closed')}`;
    const dialogue = t
      .filter(x => ['NDA', 'Info & mgmt call', 'Heads of terms', 'Final offer'].includes(x.stage))
      .map(x => `${x.business} (${x.location || '?'}, ${gbp(x.ebitda_gbp)} EBITDA, ${x.stage}, last contact ${days(x.last_contact) ?? '?'}d ago)`);
    const stalled = t
      .filter(x => x.teaser_status === 'Requested' && (days(x.last_contact) == null || days(x.last_contact) >= 14))
      .map(x => `${x.business} (${days(x.last_contact) ?? 'never contacted, first seen ' + (days(x.date_first_seen) ?? '?')}d)`);
    const fresh = t
      .slice().sort((a, b) => (b.date_first_seen || '').localeCompare(a.date_first_seen || '')).slice(0, 5)
      .map(x => `${x.business} (${x.lane || '?'}, score ${x.score ?? '—'})`);
    const todo = (tasks || []).map(x => `${x.task} (${x.type || '—'}, due ${x.due_date || 'no date'}, ${x.status})`);
    const priorityLines = (pri || []).map(x => `${x.project} (${x.category || '?'}, ${x.status || '?'}${x.next_action ? ', next: ' + x.next_action : ''}${x.next_action_date ? ' by ' + x.next_action_date : ''})`);
    const priorityBlock = domain === 'home' ? `
- Open priorities across Sparta/Fortior/Personal: ${priorityLines.join('; ') || 'none open'}.` : '';
    return `LIVE PIPELINE DATA (synced from Notion — trust this over anything else, including memory):
- Targets: ${t.length} total, ${pursuing.length} pursuing. Funnel: ${funnel}.
- In dialogue: ${dialogue.join('; ') || 'none'}.
- Stalled (teaser requested, 14d+ no contact): ${stalled.join('; ') || 'none'}.
- Newest targets: ${fresh.join('; ') || 'none'}.
- Open tasks: ${todo.join('; ') || 'none'}.${priorityBlock}
${domain === 'home' ? 'Note: Finance and Health live feeds are not connected yet — say so rather than inventing numbers for those screens.' : ''}`;
  }
  return 'NOTE: no live data is wired for this domain yet. If asked for current numbers, say the live feed is not connected rather than inventing figures.';
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  if (!(await authorized(req))) return res.status(401).json({ error: 'not authorized' });

  const { domain, message } = req.body || {};
  const d = DOMAINS[domain];
  if (!d) return res.status(400).json({ error: 'unknown domain' });
  if (!message || !message.trim()) return res.status(400).json({ error: 'empty message' });

  // 1. durable memory + MOST RECENT history + live data, in parallel
  const [{ data: mem }, { data: histDesc }, live] = await Promise.all([
    sb.from('agent_memory')
      .select('kind,content').eq('owner_id', OWNER).eq('domain', domain)
      .order('last_seen', { ascending: false }).limit(40),
    sb.from('agent_messages')
      .select('role,content').eq('owner_id', OWNER).eq('domain', domain)
      .order('created_at', { ascending: false }).limit(20),
    liveContext(domain)
  ]);
  const hist = (histDesc || []).reverse(); // chronological order for the model

  const memoryBlock = (mem || []).map(m => `- (${m.kind}) ${m.content}`).join('\n') || 'none yet';
  const system = `${d.sys}

${live}

WHAT YOU'VE LEARNED ABOUT CEDRIC (durable memory — use it, keep it current):
${memoryBlock}

At the very end of your reply, on a new line, you may record ONE new durable fact you learned this turn, formatted exactly:
MEMORY: <fact>
Only if it is genuinely new and useful, and not already in the memory list above. Otherwise omit the line. Keep replies under ~130 words unless asked to expand.`;

  const messages = [...hist.map(h => ({ role: h.role, content: h.content })),
                    { role: 'user', content: message }];

  // 2. call Claude
  let data;
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({ model: 'claude-sonnet-5', max_tokens: 1000, system, messages }),
      signal: AbortSignal.timeout(45000)
    });
    data = await r.json();
    if (!r.ok) {
      return res.status(502).json({ error: data?.error?.message || 'agent upstream error' });
    }
  } catch (err) {
    return res.status(504).json({ error: 'agent timed out or unreachable' });
  }
  let text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');

  // 3. capture memory (parse & strip the MEMORY: line, dedup on content)
  const m = text.match(/\nMEMORY:\s*(.+)\s*$/);
  if (m) {
    text = text.replace(/\nMEMORY:\s*.+\s*$/, '').trim();
    const fact = m[1].trim();
    const { data: existing } = await sb.from('agent_memory').select('id')
      .eq('owner_id', OWNER).eq('domain', domain).eq('content', fact).limit(1);
    const op = existing?.length
      ? sb.from('agent_memory').update({ last_seen: new Date().toISOString() }).eq('id', existing[0].id)
      : sb.from('agent_memory').insert({
          owner_id: OWNER, domain, kind: 'observation', content: fact, source: 'conversation'
        });
    const { error } = await op;
    if (error) console.error('agent_memory write failed:', error.message);
  }

  // 4. persist the turn
  const { error: histErr } = await sb.from('agent_messages').insert([
    { owner_id: OWNER, domain, role: 'user', content: message },
    { owner_id: OWNER, domain, role: 'assistant', content: text }
  ]);
  if (histErr) console.error('agent_messages write failed:', histErr.message);

  res.json({ text });
}
