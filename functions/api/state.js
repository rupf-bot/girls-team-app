// Gemeinsamer Zustand (Coach + Eltern) via Cloudflare KV.
// Statt einem grossen JSON-Blob wird pro Event/Spielerin ein eigener Key genutzt,
// damit gleichzeitige Änderungen verschiedener Personen sich nicht gegenseitig überschreiben.
//
// Keys:
//   ev:<eventId>                 → JSON einzelnes Event {id,type,date,location,title,plan?}
//   att:<eventId>:<playerId>     → Anwesenheits-Status ('coming'|'absent'|'injured')
//   sq:<eventId>:<playerId>      → Aufgebot-Status ('in'|'out')
//   staff:<eventId>:<staffId>    → Staff-Status ('coming'|'absent'|'injured')
//
// Zugriff ist bereits durch functions/_middleware.js (Team-Passwort-Cookie) geschützt.

function isFiniteId(v) {
  const n = Number(v);
  return Number.isFinite(n);
}

async function listAll(kv, prefix) {
  const out = [];
  let cursor;
  do {
    const res = await kv.list({ prefix, cursor });
    out.push(...res.keys);
    cursor = res.list_complete ? undefined : res.cursor;
  } while (cursor);
  return out;
}

export async function onRequestGet(context) {
  const kv = context.env.TEAM_STATE;
  if (!kv) {
    return new Response(JSON.stringify({ error: 'KV binding TEAM_STATE fehlt' }), { status: 500 });
  }

  const [evKeys, attKeys, sqKeys, staffKeys] = await Promise.all([
    listAll(kv, 'ev:'),
    listAll(kv, 'att:'),
    listAll(kv, 'sq:'),
    listAll(kv, 'staff:'),
  ]);

  const events = (await Promise.all(evKeys.map(k => kv.get(k.name, 'json')))).filter(Boolean);

  const attendance = {};
  await Promise.all(attKeys.map(async k => {
    const [, eventId, playerId] = k.name.split(':');
    const status = await kv.get(k.name);
    if (!status) return;
    attendance[eventId] = attendance[eventId] || {};
    attendance[eventId][playerId] = status;
  }));

  const squad = {};
  await Promise.all(sqKeys.map(async k => {
    const [, eventId, playerId] = k.name.split(':');
    const status = await kv.get(k.name);
    if (!status) return;
    squad[eventId] = squad[eventId] || {};
    squad[eventId][playerId] = status;
  }));

  const staffAttendance = {};
  await Promise.all(staffKeys.map(async k => {
    const [, eventId, staffId] = k.name.split(':');
    const status = await kv.get(k.name);
    if (!status) return;
    staffAttendance[eventId] = staffAttendance[eventId] || {};
    staffAttendance[eventId][staffId] = status;
  }));

  return new Response(JSON.stringify({ events, attendance, squad, staffAttendance }), {
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function onRequestPost(context) {
  const kv = context.env.TEAM_STATE;
  if (!kv) {
    return new Response(JSON.stringify({ error: 'KV binding TEAM_STATE fehlt' }), { status: 500 });
  }

  let body;
  try {
    body = await context.request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Ungültiges JSON' }), { status: 400 });
  }

  const { action } = body;

  if (action === 'setAttendance' || action === 'setSquad' || action === 'setStaffAttendance') {
    const { eventId, status } = body;
    const personId = body.playerId ?? body.staffId;
    if (!isFiniteId(eventId) || !isFiniteId(personId)) {
      return new Response(JSON.stringify({ error: 'eventId/playerId ungültig' }), { status: 400 });
    }
    const prefix = action === 'setAttendance' ? 'att' : action === 'setSquad' ? 'sq' : 'staff';
    const key = `${prefix}:${eventId}:${personId}`;
    if (!status || status === 'open') {
      await kv.delete(key);
    } else {
      await kv.put(key, String(status));
    }
    return new Response(JSON.stringify({ ok: true }));
  }

  if (action === 'upsertEvent') {
    const { event } = body;
    if (!event || !isFiniteId(event.id)) {
      return new Response(JSON.stringify({ error: 'event ungültig' }), { status: 400 });
    }
    await kv.put(`ev:${event.id}`, JSON.stringify(event));
    return new Response(JSON.stringify({ ok: true }));
  }

  if (action === 'deleteEvent') {
    const { eventId } = body;
    if (!isFiniteId(eventId)) {
      return new Response(JSON.stringify({ error: 'eventId ungültig' }), { status: 400 });
    }
    const [attKeys, sqKeys, staffKeys] = await Promise.all([
      listAll(kv, `att:${eventId}:`),
      listAll(kv, `sq:${eventId}:`),
      listAll(kv, `staff:${eventId}:`),
    ]);
    await Promise.all([
      kv.delete(`ev:${eventId}`),
      ...attKeys.map(k => kv.delete(k.name)),
      ...sqKeys.map(k => kv.delete(k.name)),
      ...staffKeys.map(k => kv.delete(k.name)),
    ]);
    return new Response(JSON.stringify({ ok: true }));
  }

  if (action === 'bootstrapEvents') {
    // Nur schreiben, falls server-seitig noch gar keine Events existieren (erster Start).
    const existing = await listAll(kv, 'ev:');
    if (existing.length > 0) {
      return new Response(JSON.stringify({ ok: true, skipped: true }));
    }
    const { events } = body;
    if (!Array.isArray(events)) {
      return new Response(JSON.stringify({ error: 'events ungültig' }), { status: 400 });
    }
    await Promise.all(events.map(ev => kv.put(`ev:${ev.id}`, JSON.stringify(ev))));
    return new Response(JSON.stringify({ ok: true }));
  }

  return new Response(JSON.stringify({ error: 'Unbekannte action' }), { status: 400 });
}
