// Save the Home-screen daily quote into Cedric's Notion quote file.
//
// The quote file can be either a Notion *database* (one row per quote) or a
// plain *page* (quotes appended as blocks) — the endpoint retrieves the id and
// does whichever is right, so you don't have to tell it which you made.
//
// Auth: owner only (Supabase session token from the dashboard). No cron path —
// this only ever fires from the "Save" button.
//
// Env: NOTION_TOKEN, NOTION_QUOTES_DB_ID (the database or page id — share it
// with the integration first), SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
// OWNER_USER_ID.

import { Client } from '@notionhq/client';
import { createClient } from '@supabase/supabase-js';

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const OWNER = process.env.OWNER_USER_ID;

async function ownerOnly(req) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) return { ok: false, why: 'no session token — sign out and back in on the dashboard, then retry' };
  if (!OWNER) return { ok: false, why: 'OWNER_USER_ID not set on server' };
  const { data, error } = await sb.auth.getUser(token);
  if (error) return { ok: false, why: 'dashboard session expired — sign out (lock icon, top-right) and back in [' + error.message + ']' };
  if (data?.user?.id !== OWNER) return { ok: false, why: 'not the owner' };
  return { ok: true };
}

// Build a property payload only if the database actually has that property, and
// only in a shape its type accepts. Anything unmatched is skipped, so the same
// code works whether the DB has Author/Date columns or just a title.
function prop(schema, name, value) {
  const p = schema.properties[name];
  if (!p || !value) return null;
  switch (p.type) {
    case 'title':     return { title: [{ text: { content: value } }] };
    case 'rich_text': return { rich_text: [{ text: { content: value } }] };
    case 'date':      return { date: { start: value } };
    case 'select':    return { select: { name: value } };
    case 'url':       return { url: value };
    default:          return null;
  }
}

// First property of the given type, whatever it happens to be called.
const firstOfType = (schema, type) =>
  Object.keys(schema.properties).find(k => schema.properties[k].type === type);

// Find a property by any of several likely names (case-insensitive).
const named = (schema, ...names) => {
  const keys = Object.keys(schema.properties);
  for (const n of names) {
    const hit = keys.find(k => k.toLowerCase() === n.toLowerCase());
    if (hit) return hit;
  }
  return null;
};

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const auth = await ownerOnly(req);
  if (!auth.ok) return res.status(401).json({ error: 'auth failed — ' + auth.why });

  const targetId = process.env.NOTION_QUOTES_DB_ID;
  if (!targetId) return res.status(500).json({ error: 'NOTION_QUOTES_DB_ID not set — add the quote file id in Vercel and share it with the Notion integration' });
  if (!process.env.NOTION_TOKEN) return res.status(500).json({ error: 'NOTION_TOKEN not set' });

  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  const quote  = String(body.quote  || '').trim();
  const author = String(body.author || '').trim();
  if (!quote) return res.status(400).json({ error: 'no quote supplied' });

  const notion = new Client({ auth: process.env.NOTION_TOKEN });
  const today = new Date().toISOString().slice(0, 10);

  try {
    // --- Case 1: the id is a database -> create a row -----------------------
    let schema = null;
    try { schema = await notion.databases.retrieve({ database_id: targetId }); } catch { /* not a database */ }

    if (schema) {
      const titleKey = firstOfType(schema, 'title');
      if (!titleKey) return res.status(500).json({ error: 'quote database has no title property' });

      // Don't save the same quote twice.
      try {
        const dupe = await notion.databases.query({
          database_id: targetId,
          filter: { property: titleKey, title: { equals: quote } },
          page_size: 1
        });
        if (dupe.results.length) return res.status(200).json({ ok: true, duplicate: true, url: dupe.results[0].url });
      } catch { /* filter unsupported on this schema — fall through and create */ }

      const properties = { [titleKey]: prop(schema, titleKey, quote) };
      const authorKey = named(schema, 'Author', 'Who', 'Source', 'By');
      const dateKey   = named(schema, 'Date saved', 'Date', 'Saved', 'Added');
      if (authorKey) { const v = prop(schema, authorKey, author); if (v) properties[authorKey] = v; }
      if (dateKey)   { const v = prop(schema, dateKey,   today);  if (v) properties[dateKey]   = v; }

      const page = await notion.pages.create({ parent: { database_id: targetId }, properties });
      return res.status(200).json({ ok: true, kind: 'database', url: page.url });
    }

    // --- Case 2: the id is a plain page -> append in the page's house style --
    // The Quotes page already has a format and we match it exactly rather than
    // inventing one: divider, quote block with the text inside literal quote
    // marks, bold author, italic "Source:" line. Don't change this without
    // looking at the page first.
    await notion.pages.retrieve({ page_id: targetId });   // throws if neither

    // Don't append a quote that's already on the page.
    const norm = s => s.toLowerCase().replace(/[^a-z0-9]/g, '');
    const want = norm(quote);
    let cursor;
    do {
      const page = await notion.blocks.children.list({ block_id: targetId, start_cursor: cursor, page_size: 100 });
      for (const b of page.results) {
        if (b.type !== 'quote') continue;
        const text = (b.quote.rich_text || []).map(t => t.plain_text).join('');
        if (norm(text) === want) return res.status(200).json({ ok: true, kind: 'page', duplicate: true });
      }
      cursor = page.has_more ? page.next_cursor : null;
    } while (cursor);

    const longDate = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
    await notion.blocks.children.append({
      block_id: targetId,
      children: [
        { object: 'block', type: 'divider', divider: {} },
        { object: 'block', type: 'quote', quote: { rich_text: [{ text: { content: `"${quote}"` } }] } },
        { object: 'block', type: 'paragraph', paragraph: {
          rich_text: [{ text: { content: author || 'Unknown' }, annotations: { bold: true } }] } },
        { object: 'block', type: 'paragraph', paragraph: {
          rich_text: [{ text: { content: `Source: CB Dashboard daily quote, ${longDate}` }, annotations: { italic: true } }] } }
      ]
    });
    return res.status(200).json({ ok: true, kind: 'page' });

  } catch (e) {
    const msg = String(e.message || e);
    // The overwhelmingly common failure: the file isn't shared with the integration.
    const hint = /could not find|not found|unauthorized/i.test(msg)
      ? ' — open the quote file in Notion, ... menu > Connections > add the integration, then check NOTION_QUOTES_DB_ID'
      : '';
    return res.status(500).json({ error: msg + hint });
  }
}
