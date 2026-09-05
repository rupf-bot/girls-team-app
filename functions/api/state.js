// Gemeinsamer Zustand (Coach + Eltern) via Cloudflare KV.
// Statt einem grossen JSON-Blob wird pro Event/Spielerin ein eigener Key genutzt,
// damit gleichzeitige Änderungen verschiedener Personen sich nicht gegenseitig überschreiben.
//
// Keys:
//   ev:<eventId>                 → JSON einzelnes Event {id,type,date,location,title,plan?}
//   pl:<playerId>                → JSON einzelne Spielerin {id,name,parent,phone,nameMother?,phone2?,nameFather?,number?}
//   sf:<staffId>                 → JSON einzelnes Trainer-Team-Mitglied {id,name,role,phone,hasAttendance,photo?}
//   att:<eventId>:<playerId>     → Anwesenheits-Status ('coming'|'absent'|'injured')
//   sq:<eventId>:<playerId>      → Aufgebot-Status ('in'|'out')
//   staff:<eventId>:<staffId>    → Staff-Status ('coming'|'absent'|'injured')
//   note:<eventId>:<playerId>    → JSON Verhinderungsgrund-Notiz
//                                   {text, ts, seen, reply?, replyTs?, replySeenByParent?,
//                                    closedByCoach?, closedByParent?}
//
// Zusätzlich wird unter dem Key "full:state" ein aggregierter Cache des kompletten
// Zustands gepflegt (JSON von {events,attendance,squad,staffAttendance}). Lese-Zugriffe
// (GET, mehrfach pro Minute durch Polling/Sync auf allen Geräten) lesen nur noch diesen
// einen Key statt 4x kv.list() + einen kv.get() pro Einzel-Key zu machen — das spart
// massiv Workers-KV-Operationen (v.a. das knappe List-Kontingent im Free-Tier).
// Der Cache wird nach jeder schreibenden Aktion neu aus den Einzel-Keys aufgebaut, damit
// er garantiert konsistent mit der eigentlichen (Einzel-Key-)Quelle bleibt. Schreibvorgänge
// sind viel seltener als Lesevorgänge, daher lohnt sich der Rebuild-Aufwand dort.
//
// Zugriff ist bereits durch functions/_middleware.js (Team-Passwort-Cookie) geschützt.

const CACHE_KEY = 'full:state';

function isFiniteId(v) {
  const n = Number(v);
  return Number.isFinite(n);
}

function isNonEmptyStringId(v) {
  return typeof v === 'string' && v.length > 0;
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

async function buildState(kv) {
  const [evKeys, plKeys, sfKeys, attKeys, sqKeys, staffKeys, noteKeys] = await Promise.all([
    listAll(kv, 'ev:'),
    listAll(kv, 'pl:'),
    listAll(kv, 'sf:'),
    listAll(kv, 'att:'),
    listAll(kv, 'sq:'),
    listAll(kv, 'staff:'),
    listAll(kv, 'note:'),
  ]);

  const events = (await Promise.all(evKeys.map(k => kv.get(k.name, 'json')))).filter(Boolean);
  const players = (await Promise.all(plKeys.map(k => kv.get(k.name, 'json')))).filter(Boolean);
  const staff = (await Promise.all(sfKeys.map(k => kv.get(k.name, 'json')))).filter(Boolean);

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

  const notes = {};
  await Promise.all(noteKeys.map(async k => {
    const [, eventId, playerId] = k.name.split(':');
    const note = await kv.get(k.name, 'json');
    if (!note) return;
    notes[eventId] = notes[eventId] || {};
    notes[eventId][playerId] = note;
  }));

  return { events, players, staff, attendance, squad, staffAttendance, notes };
}

async function rebuildCache(kv) {
  const state = await buildState(kv);
  await kv.put(CACHE_KEY, JSON.stringify(state));
  return state;
}

// Liest den bestehenden Cache (oder baut ihn einmalig neu auf, falls er fehlt).
// Wichtig: Für einzelne Schreibaktionen NICHT rebuildCache() (= kv.list()) verwenden,
// da Cloudflare KV list() nur "eventually consistent" ist — ein gerade geschriebener
// Key kann dort für mehrere Sekunden noch fehlen. Ein Rebuild direkt nach dem Schreiben
// würde den Cache dann mit einem Stand OHNE die neue Änderung überschreiben, und der
// nächste Poll eines Clients zeigt den Status fälschlich wieder als zurückgesetzt an.
// Stattdessen wird die bekannte Änderung direkt in den bestehenden Cache gepatcht.
async function getCache(kv) {
  const cached = await kv.get(CACHE_KEY, 'json');
  if (cached) {
    // Absicherung: Falls der Cache vor Einführung eines neuen State-Felds (z.B. "notes")
    // geschrieben wurde, fehlt dieses Feld im alten Blob und würde bei state.<feld>[x] = ...
    // sofort crashen. Fehlende Felder hier defensiv nachrüsten statt teuren Rebuild zu erzwingen.
    cached.notes = cached.notes || {};
    return cached;
  }
  return rebuildCache(kv);
}

async function putCache(kv, state) {
  await kv.put(CACHE_KEY, JSON.stringify(state));
}

export async function onRequestGet(context) {
  const kv = context.env.TEAM_STATE;
  if (!kv) {
    return new Response(JSON.stringify({ error: 'KV binding TEAM_STATE fehlt' }), { status: 500 });
  }

  let state = await kv.get(CACHE_KEY, 'json');
  if (!state) {
    state = await rebuildCache(kv);
  }

  return new Response(JSON.stringify(state), {
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
    const field = action === 'setAttendance' ? 'attendance' : action === 'setSquad' ? 'squad' : 'staffAttendance';
    const state = await getCache(kv);
    if (!status || status === 'open') {
      if (state[field][eventId]) delete state[field][eventId][personId];
    } else {
      state[field][eventId] = state[field][eventId] || {};
      state[field][eventId][personId] = String(status);
    }
    await putCache(kv, state);
    return new Response(JSON.stringify({ ok: true }));
  }

  if (action === 'setAttendanceNote') {
    const { eventId, playerId, text } = body;
    if (!isFiniteId(eventId) || !isFiniteId(playerId)) {
      return new Response(JSON.stringify({ error: 'eventId/playerId ungültig' }), { status: 400 });
    }
    const key = `note:${eventId}:${playerId}`;
    const state = await getCache(kv);
    state.notes[eventId] = state.notes[eventId] || {};
    const trimmed = (text || '').trim();
    if (!trimmed) {
      await kv.delete(key);
      delete state.notes[eventId][playerId];
    } else {
      const existing = state.notes[eventId][playerId];
      const note = {
        text: trimmed, ts: Date.now(), seen: false,
        reply: existing ? existing.reply : null,
        replyTs: existing ? existing.replyTs : null,
        replySeenByParent: existing ? existing.replySeenByParent : null,
        closedByCoach: false, closedByParent: false,
      };
      await kv.put(key, JSON.stringify(note));
      state.notes[eventId][playerId] = note;
    }
    await putCache(kv, state);
    return new Response(JSON.stringify({ ok: true }));
  }

  if (action === 'ackAttendanceNote' || action === 'replyAttendanceNote') {
    const { eventId, playerId, reply } = body;
    if (!isFiniteId(eventId) || !isFiniteId(playerId)) {
      return new Response(JSON.stringify({ error: 'eventId/playerId ungültig' }), { status: 400 });
    }
    const key = `note:${eventId}:${playerId}`;
    const state = await getCache(kv);
    const existing = state.notes[eventId] && state.notes[eventId][playerId];
    if (!existing) {
      return new Response(JSON.stringify({ ok: true, skipped: true }));
    }
    existing.seen = true;
    if (action === 'replyAttendanceNote' && reply) {
      existing.reply = String(reply).trim();
      existing.replyTs = Date.now();
      existing.replySeenByParent = false;
      existing.closedByCoach = false;
      existing.closedByParent = false;
    }
    await kv.put(key, JSON.stringify(existing));
    state.notes[eventId][playerId] = existing;
    await putCache(kv, state);
    return new Response(JSON.stringify({ ok: true }));
  }

  if (action === 'ackAttendanceNoteReply') {
    const { eventId, playerId } = body;
    if (!isFiniteId(eventId) || !isFiniteId(playerId)) {
      return new Response(JSON.stringify({ error: 'eventId/playerId ungültig' }), { status: 400 });
    }
    const key = `note:${eventId}:${playerId}`;
    const state = await getCache(kv);
    const existing = state.notes[eventId] && state.notes[eventId][playerId];
    if (!existing) {
      return new Response(JSON.stringify({ ok: true, skipped: true }));
    }
    existing.replySeenByParent = true;
    await kv.put(key, JSON.stringify(existing));
    state.notes[eventId][playerId] = existing;
    await putCache(kv, state);
    return new Response(JSON.stringify({ ok: true }));
  }

  if (action === 'closeAttendanceNote') {
    const { eventId, playerId, side } = body;
    if (!isFiniteId(eventId) || !isFiniteId(playerId) || (side !== 'coach' && side !== 'parent')) {
      return new Response(JSON.stringify({ error: 'Parameter ungültig' }), { status: 400 });
    }
    const key = `note:${eventId}:${playerId}`;
    const state = await getCache(kv);
    const existing = state.notes[eventId] && state.notes[eventId][playerId];
    if (!existing) {
      return new Response(JSON.stringify({ ok: true, skipped: true }));
    }
    if (side === 'coach') existing.closedByCoach = true; else existing.closedByParent = true;
    await kv.put(key, JSON.stringify(existing));
    state.notes[eventId][playerId] = existing;
    await putCache(kv, state);
    return new Response(JSON.stringify({ ok: true }));
  }

  if (action === 'upsertEvent') {
    const { event } = body;
    if (!event || !isFiniteId(event.id)) {
      return new Response(JSON.stringify({ error: 'event ungültig' }), { status: 400 });
    }
    await kv.put(`ev:${event.id}`, JSON.stringify(event));
    const state = await getCache(kv);
    const idx = state.events.findIndex(e => e.id === event.id);
    if (idx >= 0) state.events[idx] = event; else state.events.push(event);
    await putCache(kv, state);
    return new Response(JSON.stringify({ ok: true }));
  }

  if (action === 'deleteEvent') {
    const { eventId } = body;
    if (!isFiniteId(eventId)) {
      return new Response(JSON.stringify({ error: 'eventId ungültig' }), { status: 400 });
    }
    const [attKeys, sqKeys, staffKeys, noteKeys] = await Promise.all([
      listAll(kv, `att:${eventId}:`),
      listAll(kv, `sq:${eventId}:`),
      listAll(kv, `staff:${eventId}:`),
      listAll(kv, `note:${eventId}:`),
    ]);
    await Promise.all([
      kv.delete(`ev:${eventId}`),
      ...attKeys.map(k => kv.delete(k.name)),
      ...sqKeys.map(k => kv.delete(k.name)),
      ...staffKeys.map(k => kv.delete(k.name)),
      ...noteKeys.map(k => kv.delete(k.name)),
    ]);
    const state = await getCache(kv);
    state.events = state.events.filter(e => e.id !== eventId);
    delete state.attendance[eventId];
    delete state.squad[eventId];
    delete state.staffAttendance[eventId];
    delete state.notes[eventId];
    await putCache(kv, state);
    return new Response(JSON.stringify({ ok: true }));
  }

  if (action === 'upsertPlayer') {
    const { player } = body;
    if (!player || !isFiniteId(player.id) || !player.name) {
      return new Response(JSON.stringify({ error: 'player ungültig' }), { status: 400 });
    }
    await kv.put(`pl:${player.id}`, JSON.stringify(player));
    const state = await getCache(kv);
    const idx = state.players.findIndex(p => p.id === player.id);
    if (idx >= 0) state.players[idx] = player; else state.players.push(player);
    await putCache(kv, state);
    return new Response(JSON.stringify({ ok: true }));
  }

  if (action === 'deletePlayer') {
    const { playerId } = body;
    if (!isFiniteId(playerId)) {
      return new Response(JSON.stringify({ error: 'playerId ungültig' }), { status: 400 });
    }
    const [attKeys, sqKeys, noteKeys] = await Promise.all([
      listAll(kv, 'att:'),
      listAll(kv, 'sq:'),
      listAll(kv, 'note:'),
    ]);
    const matches = (keys) => keys.filter(k => k.name.split(':')[2] === String(playerId));
    await Promise.all([
      kv.delete(`pl:${playerId}`),
      ...matches(attKeys).map(k => kv.delete(k.name)),
      ...matches(sqKeys).map(k => kv.delete(k.name)),
      ...matches(noteKeys).map(k => kv.delete(k.name)),
    ]);
    const state = await getCache(kv);
    state.players = state.players.filter(p => p.id !== playerId);
    Object.keys(state.attendance).forEach(evId => { delete state.attendance[evId][playerId]; });
    Object.keys(state.squad).forEach(evId => { delete state.squad[evId][playerId]; });
    Object.keys(state.notes).forEach(evId => { if (state.notes[evId]) delete state.notes[evId][playerId]; });
    await putCache(kv, state);
    return new Response(JSON.stringify({ ok: true }));
  }

  if (action === 'bootstrapPlayers') {
    // Nur schreiben, falls server-seitig noch keine Spielerinnen existieren (erster Start).
    const existing = await listAll(kv, 'pl:');
    if (existing.length > 0) {
      return new Response(JSON.stringify({ ok: true, skipped: true }));
    }
    const { players } = body;
    if (!Array.isArray(players)) {
      return new Response(JSON.stringify({ error: 'players ungültig' }), { status: 400 });
    }
    await Promise.all(players.map(p => kv.put(`pl:${p.id}`, JSON.stringify(p))));
    await rebuildCache(kv);
    return new Response(JSON.stringify({ ok: true }));
  }

  if (action === 'upsertStaff') {
    const { staff } = body;
    if (!staff || !isNonEmptyStringId(staff.id) || !staff.name) {
      return new Response(JSON.stringify({ error: 'staff ungültig' }), { status: 400 });
    }
    await kv.put(`sf:${staff.id}`, JSON.stringify(staff));
    const state = await getCache(kv);
    const idx = state.staff.findIndex(s => s.id === staff.id);
    if (idx >= 0) state.staff[idx] = staff; else state.staff.push(staff);
    await putCache(kv, state);
    return new Response(JSON.stringify({ ok: true }));
  }

  if (action === 'deleteStaff') {
    const { staffId } = body;
    if (!isNonEmptyStringId(staffId)) {
      return new Response(JSON.stringify({ error: 'staffId ungültig' }), { status: 400 });
    }
    const staffAttKeys = await listAll(kv, 'staff:');
    const matches = staffAttKeys.filter(k => k.name.split(':')[2] === String(staffId));
    await Promise.all([
      kv.delete(`sf:${staffId}`),
      ...matches.map(k => kv.delete(k.name)),
    ]);
    const state = await getCache(kv);
    state.staff = state.staff.filter(s => s.id !== staffId);
    Object.keys(state.staffAttendance).forEach(evId => { delete state.staffAttendance[evId][staffId]; });
    await putCache(kv, state);
    return new Response(JSON.stringify({ ok: true }));
  }

  if (action === 'bootstrapStaff') {
    // Nur schreiben, falls server-seitig noch kein Trainer-Team existiert (erster Start).
    const existing = await listAll(kv, 'sf:');
    if (existing.length > 0) {
      return new Response(JSON.stringify({ ok: true, skipped: true }));
    }
    const { staff } = body;
    if (!Array.isArray(staff)) {
      return new Response(JSON.stringify({ error: 'staff ungültig' }), { status: 400 });
    }
    await Promise.all(staff.map(s => kv.put(`sf:${s.id}`, JSON.stringify(s))));
    await rebuildCache(kv);
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
    await rebuildCache(kv);
    return new Response(JSON.stringify({ ok: true }));
  }

  return new Response(JSON.stringify({ error: 'Unbekannte action' }), { status: 400 });
}
