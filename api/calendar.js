import { createClient } from '@supabase/supabase-js';
import ical from 'node-ical';

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const OWNER = process.env.OWNER_USER_ID;

// Only the authenticated owner may read the calendar. The frontend sends the
// Supabase session token; we verify it and match it against OWNER_USER_ID
// (same gate as /api/agent — the .ics feed is private and must not be public).
async function authorized(req) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) return false;
  const { data, error } = await sb.auth.getUser(token);
  return !error && data?.user?.id === OWNER;
}

// Widen the window a couple of days each side of "the coming week" so the
// browser (which groups by the user's local day) always has enough to work
// with regardless of the server's UTC clock.
const WINDOW_BACK_MS = 2 * 86400000;
const WINDOW_FWD_MS = 9 * 86400000;

// Turn one VEVENT (possibly recurring) into 0..n concrete occurrences that fall
// inside [rangeStart, rangeEnd].
function expandEvent(ev, rangeStart, rangeEnd, out) {
  if (!ev || ev.type !== 'VEVENT' || !ev.start) return;
  const durationMs = ev.end && ev.start ? (ev.end - ev.start) : 0;
  const allDay = ev.datetype === 'date'; // node-ical marks all-day events this way

  const push = (start) => {
    out.push({
      title: (ev.summary || '').toString().trim() || '(untitled)',
      start: new Date(start).toISOString(),
      end: new Date(start.getTime() + durationMs).toISOString(),
      allDay
    });
  };

  if (ev.rrule) {
    // Recurring (weekly meetings, yearly birthdays, …). rrule.between gives the
    // occurrence start dates; apply overrides/cancellations node-ical parsed.
    const exdates = Object.keys(ev.exdate || {}).map(k => new Date(k).getTime());
    const occurrences = ev.rrule.between(rangeStart, rangeEnd, true);
    for (const occ of occurrences) {
      const key = occ.toISOString().slice(0, 10);
      // A modified instance is stored under ev.recurrences keyed by date.
      const override = ev.recurrences && ev.recurrences[key];
      if (override) { expandEvent(override, rangeStart, rangeEnd, out); continue; }
      if (exdates.includes(occ.getTime())) continue; // cancelled instance
      push(occ);
    }
  } else if (ev.start >= rangeStart && ev.start <= rangeEnd) {
    push(ev.start);
  }
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).end();
  if (!(await authorized(req))) return res.status(401).json({ error: 'unauthorized' });

  // One or more secret .ics addresses, comma-separated (primary, family, …).
  const urls = (process.env.GCAL_ICS_URL || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!urls.length) return res.status(500).json({ error: 'GCAL_ICS_URL not configured in Vercel' });

  try {
    const now = Date.now();
    const rangeStart = new Date(now - WINDOW_BACK_MS);
    const rangeEnd = new Date(now + WINDOW_FWD_MS);

    const feeds = await Promise.all(urls.map(async (u) => {
      const r = await fetch(u, { headers: { 'User-Agent': 'cb-dashboard' } });
      if (!r.ok) throw new Error(`a calendar feed returned ${r.status}`);
      return ical.sync.parseICS(await r.text());
    }));

    const events = [];
    for (const parsed of feeds) {
      for (const ev of Object.values(parsed)) {
        expandEvent(ev, rangeStart, rangeEnd, events);
      }
    }
    events.sort((a, b) => a.start.localeCompare(b.start));

    // Feed changes at most a few times an hour; let the edge cache it briefly.
    res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=1800');
    res.json({ events });
  } catch (e) {
    res.status(502).json({ error: `could not read calendar: ${e.message}` });
  }
}
