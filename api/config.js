// Serves the PUBLIC Supabase config to the browser from Vercel env vars,
// so no keys are committed to the repo. Never expose service-role / API keys here.

export default function handler(req, res) {
  const url = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    return res.status(500).json({ error: 'Supabase env not configured' });
  }
  // Small cache; these are public, RLS-protected values.
  res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate');
  res.json({ url, anonKey });
}
