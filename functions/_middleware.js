const COOKIE_NAME = 'svh_team_auth';
const COOKIE_MAX_AGE = 60 * 60 * 24 * 30; // 30 Tage

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

function loginPage(showError) {
  return `<!DOCTYPE html>
<html lang="de"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>SV Höngg Juniorinnen Ema</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Segoe UI', system-ui, sans-serif; background:#F3F3F3; display:flex; align-items:center; justify-content:center; min-height:100vh; margin:0; color:#0F172A; -webkit-font-smoothing:antialiased; }
  .card { background:white; border-radius:20px; padding:32px 24px; max-width:340px; width:90%; box-shadow:0 8px 32px rgba(15,23,42,0.12); text-align:center; }
  .card img { height:72px; width:auto; margin-bottom:16px; }
  h1 { font-size:18px; font-weight:700; margin:0 0 6px; color:#0F172A; }
  p { color:#64748B; font-size:14px; margin:0 0 28px; }
  input { width:100%; box-sizing:border-box; height:48px; padding:0 14px; border:1.5px solid #E2E8F0; border-radius:12px; font-size:15px; background:#F8FAFC; color:#0F172A; margin-bottom:12px; -webkit-appearance:none; appearance:none; transition:border-color 0.15s; }
  input:focus { outline:none; border-color:#3B82F6; background:white; box-shadow:0 0 0 3px rgba(59,130,246,0.15); }
  button { width:100%; height:48px; border:none; border-radius:12px; background:#3B82F6; color:white; font-size:16px; font-weight:700; cursor:pointer; transition:transform 0.1s; }
  button:active { transform:scale(0.97); }
  .err { color:#EF4444; font-size:13px; margin-bottom:12px; text-align:center; }
</style></head>
<body>
  <div class="card">
    <img src="/SVH-Logo-transparent.png" alt="SV Höngg">
    <h1>SV Höngg Juniorinnen Ema</h1>
    <p>Bitte Team-Passwort eingeben</p>
    <form method="POST">
      ${showError ? '<div class="err">Falsches Passwort</div>' : ''}
      <input type="password" name="password" placeholder="Passwort" autofocus required>
      <button type="submit">Weiter</button>
    </form>
  </div>
</body></html>`;
}

const STATIC_ASSET_EXTENSIONS = /\.(png|jpg|jpeg|svg|webp|ico|gif)$/i;

export async function onRequest(context) {
  const { request, env, next } = context;
  const url = new URL(request.url);

  // Statische Bild-Dateien (z.B. Vereinslogo) dürfen auch ohne gültiges Auth-Cookie
  // geladen werden, damit das Logo bereits auf dem Passwort-Screen sichtbar ist.
  // Enthält keine sensiblen Daten, daher unkritisch.
  if (request.method === 'GET' && STATIC_ASSET_EXTENSIONS.test(url.pathname)) {
    return next();
  }

  const cookieHeader = request.headers.get('Cookie') || '';
  const hasValidCookie = cookieHeader.split(';').some(c => c.trim() === `${COOKIE_NAME}=ok`);

  if (request.method === 'POST') {
    const form = await request.formData();
    const submitted = String(form.get('password') || '');
    const correct = env.TEAM_PASSWORD && timingSafeEqual(submitted, env.TEAM_PASSWORD);
    if (correct) {
      const res = new Response(null, { status: 303, headers: { Location: '/' } });
      res.headers.append('Set-Cookie', `${COOKIE_NAME}=ok; Path=/; Max-Age=${COOKIE_MAX_AGE}; HttpOnly; Secure; SameSite=Lax`);
      return res;
    }
    return new Response(loginPage(true), { status: 401, headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
  }

  if (!hasValidCookie) {
    return new Response(loginPage(false), { status: 401, headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
  }

  return next();
}
