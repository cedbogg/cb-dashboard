// Strava → Supabase sync. Pulls activities (distance, moving time, sport type)
// into strava_activities; the Fitness screen reads them for per-day actual km
// and per-week run/elliptical time. Runs on cron + can be triggered manually.
//
// Env: STRAVA_CLIENT_ID, STRAVA_CLIENT_SECRET, STRAVA_REFRESH_TOKEN,
//      SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, OWNER_USER_ID, CRON_SECRET.

import { createClient } from '@supabase/supabase-js';

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const OWNER = process.env.OWNER_USER_ID;
const AFTER = Math.floor(new Date('2026-06-20T00:00:00Z').getTime() / 1000); // ~before W1

async function authorized(req) {
  const auth = req.headers.authorization || '';
  const secret = process.env.CRON_SECRET;
  if (secret) { if (auth === `Bearer ${secret}`) return true; }
  else if ((req.headers['user-agent'] || '').includes('vercel-cron')) return true;
  const token = auth.replace(/^Bearer\s+/i, '');
  if (!token) return false;
  const { data, error } = await sb.auth.getUser(token);
  return !error && data?.user?.id === OWNER;
}

async function stravaAccessToken() {
  const body = new URLSearchParams({
    client_id: process.env.STRAVA_CLIENT_ID,
    client_secret: process.env.STRAVA_CLIENT_SECRET,
    refresh_token: process.env.STRAVA_REFRESH_TOKEN,
    grant_type: 'refresh_token'
  });
  const r = await fetch('https://www.strava.com/oauth/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body
  });
  const d = await r.json();
  if (!r.ok || !d.access_token) throw new Error(d.message || d.error || 'strava token exchange failed');
  return d.access_token;
}

export default async function handler(req, res) {
  if (!(await authorized(req))) return res.status(401).json({ error: 'unauthorized' });
  if (!process.env.STRAVA_REFRESH_TOKEN) return res.status(500).json({ error: 'STRAVA_* env not configured' });

  try {
    const token = await stravaAccessToken();
    const rows = [];
    for (let page = 1; page <= 8; page++) {
      const r = await fetch(`https://www.strava.com/api/v3/athlete/activities?after=${AFTER}&per_page=100&page=${page}`,
        { headers: { Authorization: `Bearer ${token}` } });
      const acts = await r.json();
      if (!r.ok) throw new Error(acts.message || `Strava activities ${r.status}`);
      if (!Array.isArray(acts) || !acts.length) break;
      for (const a of acts) {
        rows.push({
          owner_id: OWNER,
          activity_id: a.id,
          start_date: a.start_date,
          local_date: (a.start_date_local || a.start_date || '').slice(0, 10) || null,
          sport_type: a.sport_type || a.type || null,
          distance_m: a.distance ?? null,
          moving_time_s: a.moving_time ?? null,
          name: a.name || null
        });
      }
      if (acts.length < 100) break;
    }
    if (rows.length) {
      const { error } = await sb.from('strava_activities').upsert(rows, { onConflict: 'owner_id,activity_id' });
      if (error) throw new Error(error.message);
    }
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({ ok: true, synced: rows.length });
  } catch (e) {
    const msg = String(e.message || e);
    const hint = /authorization|scope|401/i.test(msg) ? ' — token may lack activity:read_all; re-authorise.' : '';
    res.status(502).json({ error: msg + hint });
  }
}
