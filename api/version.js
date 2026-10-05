// Which build is live — the footer shows it so a stale tab is easy to spot.
// VERCEL_GIT_COMMIT_SHA is one of Vercel's system env vars; no-store so it's never cached.
export default function handler(req, res) {
  const sha = process.env.VERCEL_GIT_COMMIT_SHA || '';
  res.setHeader('Cache-Control', 'no-store');
  res.json({ sha: sha.slice(0, 7) || null, ref: process.env.VERCEL_GIT_COMMIT_REF || null });
}
