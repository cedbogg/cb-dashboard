# CB Dashboard — Build Brief for Claude Code
## Steps 3 & 4: Fortior live slice, auth gate, Notion→Supabase sync, memory-aware Deal Desk

**Stack:** static frontend (the assembled `cb-dashboard-app.html`) + Vercel serverless functions (`/api/*`) + Supabase (data + auth, project `tfqedzoeikrofydrxfoq`) + Notion sync. Schema v1 already applied.

**Source of truth:** Notion is the editing surface; a scheduled sync upserts into Supabase; the dashboard reads Supabase.

---

## Environment variables (set in Vercel — never in the frontend bundle or in chat)
| Var | Scope | Purpose |
|---|---|---|
| `SUPABASE_URL` | public | `https://tfqedzoeikrofydrxfoq.supabase.co` |
| `SUPABASE_ANON_KEY` | public (frontend) | client reads, RLS-protected |
| `SUPABASE_SERVICE_ROLE_KEY` | server only | sync + agent memory writes |
| `ANTHROPIC_API_KEY` | server only | powers the agents |
| `NOTION_TOKEN` | server only | internal integration token; share the 7 DBs with it |
| `OWNER_USER_ID` | server only | Cedric's `auth.users` id — stamped on every synced row |

## Project structure
```
/index.html            ← the assembled app (frontend)
/lib/supabase.js        ← browser client + auth gate
/lib/domains.js         ← SERVER-side domain system prompts (ported from app DOMAINS)
/api/agent.js           ← memory-aware agent endpoint (step 4)
/api/sync-notion.js     ← Notion → Supabase upsert (cron)
/vercel.json            ← cron schedule for the sync
/package.json           ← deps: @supabase/supabase-js, @notionhq/client
```

---

## Step 0 — Repo & version control (do this first)
1. In the project folder: `git init`; rename `cb-dashboard-app.html` → `index.html`.
2. Create `.gitignore` **before the first commit** — secrets must never be committed:
```
.env
.env.*
node_modules/
.vercel
```
3. `npm init -y`, then add deps: `@supabase/supabase-js`, `@notionhq/client`.
4. Build the app (Steps 3–4), then make the first commit.
5. Create a **private** GitHub repo and push:
   `gh repo create cb-dashboard --private --source=. --push` (GitHub CLI), or create it on github.com and add the remote manually.
6. In Vercel, **import the GitHub repo** (Cedric has the Vercel connector) so every push auto-deploys. Set the six env vars in Vercel → Project → Settings → Environment Variables. Keys live here only — never in the repo.

---

## Step 3a — Auth gate (password protection)
- Create Cedric's user once: Supabase dashboard → Authentication → Add user (email + password). That password *is* the app lock.
- In `/lib/supabase.js`: init `createClient(SUPABASE_URL, SUPABASE_ANON_KEY)`. On load, `getSession()`; if none, render a minimal email+password login (`signInWithPassword`) over the app; on success, reveal the dashboard. Add a lock/sign-out control in the top bar.

## Step 3b — Fortior reads live from Supabase
Replace the hardcoded Fortior rows in `index.html` with these queries (all auto-scoped by RLS):

- **Funnel counts** — `select stage, count(*) from rocket_targets where status='Pursuing' group by stage`; map to the 7 bars (Teaser req / Received / NDA / Info & mgmt / Heads of terms / Final offer / Closed). Compare vs the month-based targets to render the pace line.
- **In dialogue** — `select business, location, ebitda_gbp, stage, last_contact from rocket_targets where stage in ('NDA','Info & mgmt call','Heads of terms','Final offer') order by last_contact desc`.
- **Stalled / chase** — `select business, last_contact from rocket_targets where teaser_status='Requested' and last_contact < now() - interval '14 days' order by last_contact asc`.
- **New targets** — `select business, lane, score, date_first_seen from rocket_targets order by date_first_seen desc limit 5`.
- **Things to do** — `select task, type, due_date, status from fortior_tasks where status <> 'Done' order by due_date asc nulls last`.

Keep the other five screens on mock data for now; wire them in the same pattern next.

## Step 3c — Notion → Supabase sync (`/api/sync-notion.js`, cron)
Use `@notionhq/client` (NOTION_TOKEN) + Supabase service-role client. For Fortior first, sync two databases:

- **Rocket Sourcing Log → `rocket_targets`** — map: Business→business, Lane→lane, Score→score, Teaser→teaser_status, (new) Stage→stage, EBITDA→ebitda_gbp, Location→location, Status→status, Date First Seen→date_first_seen, last contact→last_contact, Source→source, page id→notion_id.
- **Fortior Tasks → `fortior_tasks`** — Task→task, Type→type, Status→status, Due date→due_date, Source→source, Link→link, Notes→notes, page id→notion_id.

Upsert on `notion_id`; set `owner_id = OWNER_USER_ID` on every row. Run twice daily (align with the sourcing agent). `vercel.json`:
```json
{ "crons": [ { "path": "/api/sync-notion", "schedule": "0 7,15 * * *" } ] }
```
> The Rocket Log needs the post-teaser `Stage` field added in Notion (NDA → Info & mgmt call → Heads of terms → Final offer → Closed) for the funnel to populate beyond the teaser stages.

---

## Step 4 — Memory-aware Deal Desk endpoint (`/api/agent.js`)
This is where the agent starts to "get wiser": it loads durable memory + recent history from Supabase, answers with Claude, persists the turn, and captures new memory. Domain prompts live server-side so the client can't tamper with them.

```js
import { createClient } from '@supabase/supabase-js';
import { DOMAINS } from '../lib/domains.js';

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const OWNER = process.env.OWNER_USER_ID;

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  const { domain, message } = req.body;
  const d = DOMAINS[domain];
  if (!d) return res.status(400).json({ error: 'unknown domain' });

  // 1. load durable memory + recent history for this domain
  const { data: mem } = await sb.from('agent_memory')
    .select('kind,content').eq('owner_id', OWNER).eq('domain', domain)
    .order('last_seen', { ascending: false }).limit(40);
  const { data: hist } = await sb.from('agent_messages')
    .select('role,content').eq('owner_id', OWNER).eq('domain', domain)
    .order('created_at', { ascending: true }).limit(20);

  const memoryBlock = (mem || []).map(m => `- (${m.kind}) ${m.content}`).join('\n') || 'none yet';
  const system = `${d.sys}

WHAT YOU'VE LEARNED ABOUT CEDRIC (durable memory — use it, keep it current):
${memoryBlock}

At the very end of your reply, on a new line, you may record ONE new durable fact you learned this turn, formatted exactly:
MEMORY: <fact>
Only if it is genuinely new and useful. Otherwise omit the line. Keep replies under ~130 words unless asked to expand.`;

  const messages = [...(hist || []).map(h => ({ role: h.role, content: h.content })),
                    { role: 'user', content: message }];

  // 2. call Claude
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY,
               'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 1000, system, messages })
  });
  const data = await r.json();
  let text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');

  // 3. capture memory (parse & strip the MEMORY: line)
  const m = text.match(/\nMEMORY:\s*(.+)\s*$/);
  if (m) {
    text = text.replace(/\nMEMORY:\s*.+\s*$/, '').trim();
    await sb.from('agent_memory').insert({ owner_id: OWNER, domain, kind: 'observation', content: m[1].trim(), source: 'conversation' });
  }

  // 4. persist the turn
  await sb.from('agent_messages').insert([
    { owner_id: OWNER, domain, role: 'user', content: message },
    { owner_id: OWNER, domain, role: 'assistant', content: text }
  ]);

  res.json({ text });
}
```

**Frontend change:** in `index.html`, replace the current keyless `fetch('https://api.anthropic.com…')` in `sendMsg()` with `fetch('/api/agent', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ domain: current, message: text }) })` and read `data.text`. Render `agent_memory` rows as the "what I've learned" chips (live now, not illustrative). Port the `DOMAINS` system prompts into `/lib/domains.js` for server use.

---

## Deploy & verify
1. Push to the private GitHub repo → Vercel auto-deploys. (For a one-off without waiting on the repo, `vercel --prod` also works.)
2. Confirm the six env vars are set in Vercel (not in code); check `.env` is git-ignored and nothing sensitive was committed.
3. Add Cedric's user in Supabase Auth (sets the password).
4. Trigger `/api/sync-notion` once manually to populate `rocket_targets` + `fortior_tasks`.
5. Open the app → log in → Fortior shows live funnel + tasks; talk to Deal Desk → confirm a row appears in `agent_messages` and any `MEMORY:` line lands in `agent_memory`.

## Notes / guardrails
- Health & Finance agent prompts already carry "not a doctor / not regulated advice" framing — keep it.
- Memory capture is deliberately conservative (one fact/turn, model-gated). Review `agent_memory` periodically; add a delete control later so Cedric can correct what it "believes."
- Do not expose SERVICE_ROLE, ANTHROPIC_API_KEY, or NOTION_TOKEN to the browser — server functions only.
