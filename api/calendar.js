import { createClient } from '@supabase/supabase-js';
import ical from 'node-ical';

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const OWNER = process.env.OWNER_USER_ID;

// Only the authenticated owner may read the calendar. The frontend sends the
// Supabase session token; we verify it and match it against OWNER_USER_ID
// (same gate as /api/agent — the feed is private and must not be public).
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

// ---- iCal events ------------------------------------------------------------
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
      allDay,
      kind: 'event'
    });
  };

  if (ev.rrule) {
    // Recurring (weekly meetings, …). rrule.between gives the occurrence start
    // dates; apply the overrides/cancellations node-ical parsed.
    const exdates = Object.keys(ev.exdate || {}).map(k => new Date(k).getTime());
    const occurrences = ev.rrule.between(rangeStart, rangeEnd, true);
    for (const occ of occurrences) {
      const key = occ.toISOString().slice(0, 10);
      const override = ev.recurrences && ev.recurrences[key];
      if (override) { expandEvent(override, rangeStart, rangeEnd, out); continue; }
      if (exdates.includes(occ.getTime())) continue; // cancelled instance
      push(occ);
    }
  } else if (ev.start >= rangeStart && ev.start <= rangeEnd) {
    push(ev.start);
  }
}

async function fetchFeeds(urls) {
  return Promise.all(urls.map(async (u) => {
    const r = await fetch(u, { headers: { 'User-Agent': 'cb-dashboard' } });
    if (!r.ok) throw new Error(`a calendar feed returned ${r.status}`);
    return ical.sync.parseICS(await r.text());
  }));
}

function expandFeeds(feeds, rangeStart, rangeEnd) {
  const out = [];
  for (const parsed of feeds) {
    for (const ev of Object.values(parsed)) expandEvent(ev, rangeStart, rangeEnd, out);
  }
  return out;
}

// Bar/bat mitzvah events are just calendar entries — match them by title so the
// dashboard can warn ahead of time (gift + RSVP). Catches "bar mitzvah",
// "bat mitzvah", "barmitzvah", "bat-mitzvah", etc.
const MITZVAH_RE = /b(ar|at)[\s-]?mitzva/i;

// ---- Contact birthdays (Google People API) ----------------------------------
// The auto-generated Google "Birthdays" calendar has no iCal address, so we read
// birthdays straight from Contacts. Requires an OAuth refresh token with the
// contacts.readonly scope. All three env vars must be present, else we skip.
async function googleAccessToken() {
  const body = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    client_secret: process.env.GOOGLE_CLIENT_SECRET,
    refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
    grant_type: 'refresh_token'
  });
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });
  const data = await r.json();
  if (!r.ok || !data.access_token) throw new Error(data.error_description || data.error || 'token exchange failed');
  return data.access_token;
}

// A birthday (month/day, year optional) recurs yearly; emit the occurrence(s)
// that land in the window. Check this year and next so a window straddling
// 31 Dec → 1 Jan still catches early-January birthdays.
function birthdayOccurrences(name, month, day, rangeStart, rangeEnd, out) {
  const years = [rangeStart.getUTCFullYear(), rangeStart.getUTCFullYear() + 1];
  for (const yr of years) {
    const d = new Date(Date.UTC(yr, month - 1, day));
    if (d >= rangeStart && d <= rangeEnd) {
      out.push({ title: `${name}'s birthday`, start: d.toISOString(), end: d.toISOString(), allDay: true, kind: 'birthday' });
    }
  }
}

// Raw contact birthdays [{name, month, day}] — fetched once, then reused for
// both the week view and the longer "looking ahead" gift horizon.
async function fetchContactBirthdays() {
  const token = await googleAccessToken();
  const people = [];
  let pageToken = '';
  // Contacts are paginated; cap the loop so a huge contact list can't run away.
  for (let page = 0; page < 20; page++) {
    const url = new URL('https://people.googleapis.com/v1/people/me/connections');
    url.searchParams.set('personFields', 'names,birthdays');
    url.searchParams.set('pageSize', '1000');
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error?.message || `People API returned ${r.status}`);

    for (const person of data.connections || []) {
      const bday = (person.birthdays || []).find(b => b.date && b.date.month && b.date.day);
      if (!bday) continue;
      people.push({ name: person.names?.[0]?.displayName || 'Someone', month: bday.date.month, day: bday.date.day });
    }
    pageToken = data.nextPageToken || '';
    if (!pageToken) break;
  }
  return people;
}

// Next occurrence of a month/day on or after `from` (this year, else next).
function nextOccurrence(month, day, from) {
  for (const yr of [from.getUTCFullYear(), from.getUTCFullYear() + 1]) {
    const d = new Date(Date.UTC(yr, month - 1, day));
    if (d >= from) return d;
  }
  return null;
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).end();
  if (!(await authorized(req))) return res.status(401).json({ error: 'unauthorized' });

  const urls = (process.env.GCAL_ICS_URL || '').split(',').map(s => s.trim()).filter(Boolean);
  const hasBirthdays = process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.GOOGLE_REFRESH_TOKEN;
  if (!urls.length && !hasBirthdays) {
    return res.status(500).json({ error: 'No calendar source configured (set GCAL_ICS_URL and/or Google OAuth vars in Vercel)' });
  }

  const now = Date.now();
  const rangeStart = new Date(now - WINDOW_BACK_MS);
  const rangeEnd = new Date(now + WINDOW_FWD_MS);
  const todayUTC = new Date(Date.UTC(rangeEnd.getUTCFullYear(), rangeEnd.getUTCMonth(), rangeEnd.getUTCDate()));
  // How far "looking ahead" peers: gift lead for birthdays, longer for mitzvahs.
  const AHEAD_BDAY = new Date(now + 60 * 86400000);
  const AHEAD_MITZVAH = new Date(now + 130 * 86400000);

  const events = [];
  const warnings = [];
  const lookAhead = { birthdays: [], mitzvahs: [] };

  // Events, birthdays and look-ahead are independent — one failing must not sink
  // the others.
  if (urls.length) {
    try {
      const feeds = await fetchFeeds(urls);
      events.push(...expandFeeds(feeds, rangeStart, rangeEnd));               // the week view
      // Scan a wider horizon for bar/bat mitzvahs to warn ahead of.
      lookAhead.mitzvahs = expandFeeds(feeds, new Date(now), AHEAD_MITZVAH)
        .filter(ev => MITZVAH_RE.test(ev.title))
        .map(ev => ({ title: ev.title, date: ev.start, allDay: ev.allDay }));
    } catch (e) { warnings.push(`events: ${e.message}`); }
  }
  if (hasBirthdays) {
    try {
      const contacts = await fetchContactBirthdays();
      for (const c of contacts) {
        birthdayOccurrences(c.name, c.month, c.day, rangeStart, rangeEnd, events); // week view
        const next = nextOccurrence(c.month, c.day, todayUTC);                     // gift horizon
        if (next && next <= AHEAD_BDAY) lookAhead.birthdays.push({ name: c.name, date: next.toISOString() });
      }
    } catch (e) { warnings.push(`birthdays: ${e.message}`); }
  }

  // Nothing came back and everything errored → surface it as a failure.
  if (!events.length && !lookAhead.birthdays.length && !lookAhead.mitzvahs.length && warnings.length) {
    return res.status(502).json({ error: `could not read calendar — ${warnings.join('; ')}` });
  }

  events.sort((a, b) => a.start.localeCompare(b.start));
  res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=1800');
  res.json({ events, warnings, lookAhead });
}
