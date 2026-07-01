// Browser Supabase client + auth gate.
// The public config (SUPABASE_URL, SUPABASE_ANON_KEY) is served by /api/config
// from Vercel env vars, so no keys live in the committed frontend bundle.
// The anon key is RLS-protected and safe for the browser by design.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

let _client;

async function loadConfig() {
  const res = await fetch('/api/config');
  if (!res.ok) throw new Error('Supabase config unavailable (is /api/config deployed?)');
  return res.json(); // { url, anonKey }
}

export async function getClient() {
  if (_client) return _client;
  const { url, anonKey } = await loadConfig();
  _client = createClient(url, anonKey);
  return _client;
}

export async function signOut() {
  const sb = await getClient();
  await sb.auth.signOut();
  location.reload();
}

// Minimal email + password overlay. On success it reloads so getSession() picks
// up the session cleanly (no double-boot).
export function renderLogin(sb) {
  if (document.getElementById('authgate')) return;
  const el = document.createElement('div');
  el.id = 'authgate';
  el.innerHTML = `
    <style>
      #authgate{position:fixed;inset:0;z-index:200;background:var(--ink,#0E1217);
        display:grid;place-items:center;padding:24px;
        background-image:radial-gradient(1200px 600px at 85% -10%, rgba(200,168,107,.06), transparent 60%);}
      #authgate .box{width:min(360px,92vw);background:var(--panel,#161C24);
        border:1px solid var(--line,#263241);border-radius:16px;padding:26px 24px;
        box-shadow:0 20px 60px rgba(0,0,0,.55);font-family:var(--body,'Inter',sans-serif);color:var(--text,#E6ECF2)}
      #authgate .mark{width:42px;height:42px;border:1px solid var(--line,#263241);border-radius:10px;
        display:grid;place-items:center;font-family:var(--mono,'IBM Plex Mono',monospace);font-weight:600;
        color:var(--accent,#C8A86B);background:var(--panel,#161C24);margin-bottom:16px}
      #authgate h1{font-family:var(--display,'Space Grotesk',sans-serif);font-weight:500;font-size:1.15rem;margin-bottom:4px}
      #authgate p{font-family:var(--mono,monospace);font-size:.7rem;color:var(--faint,#5A6776);
        text-transform:uppercase;letter-spacing:.5px;margin-bottom:20px}
      #authgate label{display:block;font-family:var(--mono,monospace);font-size:.62rem;letter-spacing:1px;
        text-transform:uppercase;color:var(--muted,#8A98A8);margin:0 0 6px}
      #authgate input{width:100%;background:var(--ink,#0E1217);border:1px solid var(--line,#263241);
        border-radius:10px;padding:11px 12px;color:var(--text,#E6ECF2);font-family:var(--body,'Inter',sans-serif);
        font-size:.9rem;outline:none;margin-bottom:14px}
      #authgate input:focus{border-color:var(--accent,#C8A86B)}
      #authgate button{width:100%;background:var(--accent,#C8A86B);border:none;border-radius:10px;padding:11px;
        color:var(--ink,#0E1217);font-family:var(--body,'Inter',sans-serif);font-weight:600;font-size:.9rem;cursor:pointer}
      #authgate button:disabled{opacity:.6;cursor:default}
      #authgate .err{color:var(--bad,#E5634D);font-size:.78rem;min-height:1.1em;margin-top:10px}
    </style>
    <form class="box" id="authform">
      <div class="mark">CB</div>
      <h1>CB Dashboard</h1>
      <p>Private · Locked</p>
      <label for="ag-email">Email</label>
      <input id="ag-email" type="email" autocomplete="username" required>
      <label for="ag-pass">Password</label>
      <input id="ag-pass" type="password" autocomplete="current-password" required>
      <button type="submit" id="ag-btn">Unlock</button>
      <div class="err" id="ag-err"></div>
    </form>`;
  document.body.appendChild(el);

  const form = el.querySelector('#authform');
  const btn = el.querySelector('#ag-btn');
  const err = el.querySelector('#ag-err');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.textContent = '';
    btn.disabled = true; btn.textContent = 'Unlocking…';
    const email = el.querySelector('#ag-email').value.trim();
    const password = el.querySelector('#ag-pass').value;
    const { error } = await sb.auth.signInWithPassword({ email, password });
    if (error) {
      err.textContent = error.message || 'Sign-in failed';
      btn.disabled = false; btn.textContent = 'Unlock';
      return;
    }
    location.reload();
  });
}
