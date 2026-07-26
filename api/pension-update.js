// Ingest endpoint for the monthly pension workbook. The workbook agent POSTs the
// current figures here after each update; the Finance screen reads them from the
// `pension` table. Protected by a single-purpose shared secret so the agent never
// holds the Supabase keys.
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, OWNER_USER_ID, PENSION_INGEST_SECRET

import { createClient } from '@supabase/supabase-js';

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const OWNER = process.env.OWNER_USER_ID;

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const secret = process.env.PENSION_INGEST_SECRET;
  if (!secret) return res.status(500).json({ error: 'PENSION_INGEST_SECRET not configured' });
  if ((req.headers.authorization || '') !== `Bearer ${secret}`) return res.status(401).json({ error: 'unauthorized' });

  // Vercel parses JSON bodies automatically; tolerate a string body too.
  let b = req.body || {};
  if (typeof b === 'string') {
    try { b = JSON.parse(b); } catch { return res.status(400).json({ error: 'body must be JSON' }); }
  }

  const num = (v) => (v == null || v === '' ? null : Number(v));
  if (b.total_value == null && !Array.isArray(b.funds)) {
    return res.status(400).json({ error: 'need at least total_value and/or a funds array' });
  }
  const as_of = (b.as_of && String(b.as_of).slice(0, 10)) || new Date().toISOString().slice(0, 10);

  const row = {
    owner_id: OWNER,
    as_of,
    total_value: num(b.total_value),
    blended_ocf: num(b.blended_ocf),
    qtd_return: num(b.qtd_return),
    funds: Array.isArray(b.funds) ? b.funds : null,   // stored as JSONB
    updated_at: new Date().toISOString()
  };

  const { error } = await sb.from('pension').upsert(row, { onConflict: 'owner_id,as_of' });
  if (error) return res.status(500).json({ error: error.message });
  res.status(200).json({ ok: true, as_of, funds: Array.isArray(b.funds) ? b.funds.length : 0 });
}
