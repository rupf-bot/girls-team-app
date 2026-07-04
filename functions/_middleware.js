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
  body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; background:#F3F3F3; display:flex; align-items:center; justify-content:center; min-height:100vh; margin:0; }
  .card { background:white; border-radius:16px; padding:32px 28px; max-width:340px; width:90%; box-shadow:0 4px 24px rgba(0,0,0,0.08); text-align:center; }
  h1 { font-size:18px; margin:0 0 6px; color:#1a1a2e; }
  p { color:#666; font-size:14px; margin:0 0 20px; }
  input { width:100%; box-sizing:border-box; padding:12px 14px; border:1.5px solid #ddd; border-radius:10px; font-size:16px; margin-bottom:12px; }
  input:focus { outline:none; border-color:#3B82F6; }
  button { width:100%; padding:12px; border:none; border-radius:10px; background:#3B82F6; color:white; font-size:16px; font-weight:700; cursor:pointer; }
  .err { color:#DC2626; font-size:13px; margin-bottom:12px; }
</style></head>
<body>
  <div class="card">
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

export async function onRequest(context) {
  const { request, env, next } = context;
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
