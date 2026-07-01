import { createClient } from '@supabase/supabase-js';
import { DOMAINS } from '../lib/domains.js';

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const OWNER = process.env.OWNER_USER_ID;

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  const { domain, message } = req.body || {};
  const d = DOMAINS[domain];
  if (!d) return res.status(400).json({ error: 'unknown domain' });
  if (!message || !message.trim()) return res.status(400).json({ error: 'empty message' });

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
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 1000, system, messages })
  });
  const data = await r.json();
  if (!r.ok) {
    return res.status(502).json({ error: data?.error?.message || 'agent upstream error' });
  }
  let text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');

  // 3. capture memory (parse & strip the MEMORY: line)
  const m = text.match(/\nMEMORY:\s*(.+)\s*$/);
  if (m) {
    text = text.replace(/\nMEMORY:\s*.+\s*$/, '').trim();
    await sb.from('agent_memory').insert({
      owner_id: OWNER, domain, kind: 'observation', content: m[1].trim(), source: 'conversation'
    });
  }

  // 4. persist the turn
  await sb.from('agent_messages').insert([
    { owner_id: OWNER, domain, role: 'user', content: message },
    { owner_id: OWNER, domain, role: 'assistant', content: text }
  ]);

  res.json({ text });
}
