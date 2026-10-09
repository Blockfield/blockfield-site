/* Shared mock data and a scripted "live stream" for the admin prototypes.
   In production this is one SSE channel (/api/admin/events); here it is a timer. */
window.BF = (() => {
  const now = Date.now()
  const min = (n) => now - n * 60_000
  const state = {
    me: { name: 'Nether', role: 'owner', c: '4' },
    presence: [
      { name: 'Kira', role: 'admin', where: 'settings', c: '1', since: min(3) },
      { name: 'Bobr', role: 'moderator', where: 'players', c: '2', since: min(11) },
    ],
    server: { phase: 'game', online: 14, matches: 2, tps: 19.8, mspt: 21, checkedAt: now },
    rooms: [
      {
        id: 'r1',
        map: 'Поля',
        mode: 'Ranked',
        phase: 'GAME',
        red: 112,
        blue: 87,
        players: 12,
        startedAt: min(14),
        points: ['A', 'B', 'C'],
        owner: ['RED', 'RED', 'BLUE'],
      },
      {
        id: 'r2',
        map: 'Констакса',
        mode: 'Casual',
        phase: 'VOTING',
        red: 0,
        blue: 0,
        players: 2,
        startedAt: min(1),
        points: ['A', 'B', 'C'],
        owner: [null, null, null],
      },
    ],
    players: [
      { name: 'Shadow_Fox', team: 'RED', room: 'Поля', cls: 'Штурмовик', c: '2' },
      { name: 'Lampochka', team: 'BLUE', room: 'Поля', cls: 'Снайпер', c: '3' },
      { name: 'Griefer_01', team: 'RED', room: 'Поля', cls: 'Инженер', c: '1' },
      { name: 'Mint', team: 'BLUE', room: 'Поля', cls: 'Марксман', c: '3' },
      { name: 'Kolya_Tank', team: null, room: 'Лобби', cls: null, c: '4' },
      { name: 'vortex', team: null, room: 'Констакса', cls: null, c: '2' },
    ],
    settings: {
      revision: 12,
      appliedAt: min(42),
      updatedBy: 'Kira',
      lobby: { pvpEnabled: true, pvpCooldownSeconds: 10 },
      rooms: { maxRooms: 4, idleCloseSeconds: 60, abandonCloseSeconds: 30 },
      deathmatch: { minPlayers: 2 },
      classCosts: { engineer: 60, sniper: 80, fpv: 120 },
      classLocks: { assault: true, marksman: true, sniper: true, engineer: true, fpv: false },
      parcool: null,
    },
    team: [
      { name: 'Nether', role: 'owner', c: '4', seen: min(0) },
      { name: 'Kira', role: 'admin', c: '1', seen: min(3) },
      { name: 'Bobr', role: 'moderator', c: '2', seen: min(11) },
      { name: 'Mint', role: 'builder', c: '3', seen: min(240), maps: ['Поля'] },
    ],
    audit: [
      { at: min(2), who: 'Kira', action: 'Изменила настройки', target: 'ревизия 12', ok: true },
      {
        at: min(9),
        who: 'Bobr',
        action: 'Выгнал игрока',
        target: 'xXx_Noob',
        ok: true,
        detail: 'спам в чате',
      },
      { at: min(27), who: 'Nether', action: 'Открыл полигон', target: '', ok: true },
      {
        at: min(58),
        who: 'Kira',
        action: 'Забанила игрока',
        target: 'Cheater228',
        ok: true,
        detail: 'аимбот',
      },
      {
        at: min(71),
        who: 'Bobr',
        action: 'Остановил матч',
        target: 'Констакса',
        ok: false,
        detail: 'сервер не ответил',
      },
    ],
    health: { tps: 19.8, avg: 21.4, p95: 38, p99: 61, freezes24h: 1, errors24h: 3 },
  }

  const LABELS = {
    'lobby.pvpEnabled': 'PvP в лобби',
    'lobby.pvpCooldownSeconds': 'Задержка выключения PvP',
    'rooms.maxRooms': 'Матчей одновременно',
    'rooms.idleCloseSeconds': 'Закрывать пустую комнату через',
    'rooms.abandonCloseSeconds': 'Завершать матч без игроков через',
    'deathmatch.minPlayers': 'Игроков для старта DM',
    'classCosts.engineer': 'Инженер, БК',
    'classCosts.sniper': 'Снайпер, БК',
    'classCosts.fpv': 'Оператор FPV, БК',
  }

  /* Scripted events; each prototype decides how to show them. */
  const script = [
    [2500, { type: 'player.join', name: 'Sova', room: 'Лобби', c: '1' }],
    [5000, { type: 'match.score', room: 'r1', red: 118, blue: 87 }],
    [
      8000,
      { type: 'settings.change', by: 'Kira', path: 'rooms.maxRooms', from: 4, to: 6, revision: 13 },
    ],
    [
      11000,
      {
        type: 'audit',
        who: 'Bobr',
        action: 'Выгнал игрока',
        target: 'Griefer_01',
        ok: true,
        detail: 'гриферит точку B',
      },
    ],
    [11000, { type: 'player.leave', name: 'Griefer_01' }],
    [14000, { type: 'presence', name: 'Kira', where: 'players' }],
    [17000, { type: 'match.start', room: 'r2', players: 4 }],
    [20000, { type: 'match.score', room: 'r1', red: 131, blue: 92 }],
    [
      24000,
      {
        type: 'settings.change',
        by: 'Kira',
        path: 'classCosts.sniper',
        from: 80,
        to: 100,
        revision: 14,
      },
    ],
    [28000, { type: 'match.score', room: 'r1', red: 140, blue: 101 }],
    [32000, { type: 'health', tps: 17.2, mspt: 48 }],
    [36000, { type: 'match.score', room: 'r2', red: 6, blue: 11 }],
    [40000, { type: 'health', tps: 19.9, mspt: 20 }],
  ]
  const handlers = []
  function apply(ev) {
    if (ev.type === 'match.score') {
      const r = state.rooms.find((r) => r.id === ev.room)
      if (r) Object.assign(r, { red: ev.red, blue: ev.blue })
    } else if (ev.type === 'match.start') {
      const r = state.rooms.find((r) => r.id === ev.room)
      if (r) Object.assign(r, { phase: 'GAME', players: ev.players, startedAt: Date.now() })
      state.server.matches = state.rooms.filter((r) => r.phase === 'GAME').length
    } else if (ev.type === 'player.join') {
      state.players.push({ name: ev.name, team: null, room: ev.room, cls: null, c: ev.c })
      state.server.online += 1
    } else if (ev.type === 'player.leave') {
      state.players = state.players.filter((p) => p.name !== ev.name)
      state.server.online -= 1
    } else if (ev.type === 'settings.change') {
      const [a, b] = ev.path.split('.')
      state.settings[a][b] = ev.to
      state.settings.revision = ev.revision
      state.settings.updatedBy = ev.by
      state.settings.appliedAt = Date.now()
    } else if (ev.type === 'audit') {
      state.audit.unshift({ at: Date.now(), ...ev })
    } else if (ev.type === 'presence') {
      const p = state.presence.find((p) => p.name === ev.name)
      if (p) p.where = ev.where
    } else if (ev.type === 'health') {
      Object.assign(state.server, { tps: ev.tps, mspt: ev.mspt })
    }
    state.server.checkedAt = Date.now()
  }
  let started = false
  function stream(handler) {
    handlers.push(handler)
    if (started) return
    started = true
    for (const [t, ev] of script)
      setTimeout(() => {
        apply(ev)
        handlers.forEach((h) => h(ev))
      }, t)
  }
  /* Local writes: optimistic apply, then a fake 400–900 ms round trip, 1 in 12 fails. */
  function write(ev) {
    apply(ev)
    handlers.forEach((h) => h({ ...ev, mine: true }))
    return new Promise((resolve, reject) =>
      setTimeout(
        () =>
          Math.random() < 1 / 12 && !ev.safe
            ? reject(new Error('Сервер не ответил. Значение не применено.'))
            : resolve(),
        400 + Math.random() * 500,
      ),
    )
  }

  const rel = new Intl.RelativeTimeFormat('ru', { numeric: 'auto' })
  function ago(ms) {
    const s = (ms - Date.now()) / 1000
    for (const [u, n] of [
      ['day', 86400],
      ['hour', 3600],
      ['minute', 60],
    ])
      if (Math.abs(s) >= n) return rel.format(Math.round(s / n), u)
    return 'только что'
  }
  const clock = (ms) => new Date(ms).toISOString().slice(11, 16)
  function el(tag, props = {}, ...kids) {
    const n = document.createElement(tag)
    for (const [k, v] of Object.entries(props)) {
      if (k === 'class') n.className = v
      else if (k.startsWith('data-') || k.startsWith('aria-') || k === 'role' || k === 'for')
        n.setAttribute(k, v)
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v)
      else n[k] = v
    }
    n.append(...kids.filter((k) => k != null && k !== false))
    return n
  }
  function toast(text, { who, undo, tone } = {}) {
    let box = document.querySelector('.toasts')
    if (!box) document.body.append((box = el('div', { class: 'toasts' })))
    const t = el(
      'div',
      { class: 'toast' + (tone ? ' ' + tone : '') },
      who ? el('span', { class: 'who' }, who) : null,
      el('span', {}, text),
      undo ? el('button', { class: 'sm', onclick: () => (undo(), t.remove()) }, 'Отменить') : null,
    )
    box.append(t)
    setTimeout(() => t.remove(), 7000)
    return t
  }
  const avatar = (p) =>
    el('span', { class: 'av', 'data-c': p.c || '1', title: p.name }, p.name[0].toUpperCase())
  const $ = (s, r = document) => r.querySelector(s)
  const $$ = (s, r = document) => [...r.querySelectorAll(s)]
  return { state, LABELS, stream, write, ago, clock, el, toast, avatar, $, $$ }
})()
