// Modo Timão — acompanha os jogos do Corinthians ao vivo (ESPN, sem chave).
// Contrato com a interface: docs/MODO_TIMAO.md
//
// A lógica "pura" (parse, diff de lances, jogo decisivo, frases) não depende do Electron,
// para poder ser testada com `node scripts/timao-test.js`. O Electron só é carregado em init().
const fs = require('fs');
const path = require('path');

const TEAM_ID = '874';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) JarvisDashboard/0.1';
const SIM_EVENT = '401841295'; // Corinthians 2×0 Mirassol (Brasileirão 2026) — usado no simulador
const MIN = 60 * 1000;

const LEAGUE_NAMES = {
  'bra.1': 'Brasileirão', 'bra.copa_do_brazil': 'Copa do Brasil', 'conmebol.libertadores': 'Libertadores',
  'conmebol.sudamericana': 'Sul-Americana', 'bra.camp.paulista': 'Paulistão',
};
const CLASSICOS = /palmeiras|s[ãa]o paulo|santos/i;

// ============================================================
// Rede
// ============================================================
const cache = new Map();
async function getJSON(url, ttlMs = 0) {
  const hit = cache.get(url);
  if (ttlMs && hit && Date.now() - hit.at < ttlMs) return hit.data;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 12000);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (ttlMs) cache.set(url, { at: Date.now(), data });
    return data;
  } finally { clearTimeout(t); }
}
const ESPN = 'https://site.api.espn.com/apis/site/v2/sports/soccer';
const urls = {
  schedule: (lg) => `${ESPN}/${lg}/teams/${TEAM_ID}/schedule?fixture=true`,
  scoreboard: (lg, date) => `${ESPN}/${lg}/scoreboard${date ? `?dates=${date}` : ''}`,
  summary: (lg, id) => `${ESPN}/${lg}/summary?event=${id}`,
  standings: (lg) => `https://site.api.espn.com/apis/v2/sports/soccer/${lg}/standings`,
};

// ============================================================
// Parse (ESPN → formato do contrato)
// ============================================================
const num = (v) => (v == null || v === '' ? null : Number(v));
const logoOf = (t) => t?.logos?.[0]?.href || t?.logo || (t?.id ? `https://a.espncdn.com/i/teamlogos/soccer/500/${t.id}.png` : null);

function statusDetail(st) {
  const name = st?.type?.name || '';
  const clock = st?.displayClock || '';
  if (st?.type?.completed || /FULL_TIME|FINAL|END_OF/.test(name)) return 'Encerrado';
  if (/HALFTIME/.test(name)) return 'Intervalo';
  if (/SCHEDULED|PRE/.test(name)) return 'Agendado';
  if (/POSTPONED/.test(name)) return 'Adiado';
  if (/CANCELED|ABANDONED/.test(name)) return 'Cancelado';
  if (clock.includes('+')) return 'Acréscimos';
  if (/SECOND_HALF/.test(name) || st?.period === 2) return '2º tempo';
  if (/FIRST_HALF/.test(name) || st?.period === 1) return '1º tempo';
  if (/EXTRA|OVERTIME/.test(name)) return 'Prorrogação';
  if (/SHOOTOUT|PENALT/.test(name)) return 'Pênaltis';
  return st?.type?.description || '';
}

function mapStats(team) {
  const s = Object.fromEntries((team?.statistics || []).map((x) => [x.name, x.displayValue]));
  return {
    possession: num(s.possessionPct), shots: num(s.totalShots), shotsOnTarget: num(s.shotsOnTarget),
    corners: num(s.wonCorners), yellow: num(s.yellowCards), red: num(s.redCards), saves: num(s.saves), fouls: num(s.foulsCommitted),
  };
}

// keyEvent ESPN → evento do contrato. side(teamObj) diz se é 'cor' ou 'opp'.
function mapKeyEvent(k, side, idx) {
  const t = k.type?.text || '';
  const who = (k.participants || []).map((p) => p.athlete?.displayName).filter(Boolean);
  let type = null;
  if (/own goal/i.test(t)) type = 'own_goal';
  else if (/penalty.*scored|penalty - scored/i.test(t)) type = 'penalty_goal';
  else if (/^goal/i.test(t) || (k.scoringPlay && !/miss|saved/i.test(t))) type = 'goal';
  else if (/second yellow|red card/i.test(t)) type = 'red';
  else if (/yellow card/i.test(t)) type = 'yellow';
  else if (/substitution/i.test(t)) type = 'sub';
  else if (/^kickoff/i.test(t)) type = 'kickoff';
  else if (/^halftime/i.test(t)) type = 'halftime';
  else if (/start 2nd half|second half begins/i.test(t)) type = 'second_half';
  else if (/end regular time|full time|end of match|match ends/i.test(t)) type = 'fulltime';
  else if (/\bvar\b|disallowed|overturned/i.test(t)) type = 'var';
  if (!type) return null;
  let team = k.team ? side(k.team) : null;
  // ESPN marca o gol contra no time de quem fez; quem se beneficia é o outro lado.
  if (type === 'own_goal' && team) team = team === 'cor' ? 'opp' : 'cor';
  return {
    key: k.id ? `k${k.id}` : `${type}|${k.period?.number}|${k.clock?.displayValue}|${team}|${who[0] || ''}|${idx}`,
    type, minute: k.clock?.displayValue || '', period: k.period?.number || null, team,
    player: who[0] || null, assist: who[1] || null, text: k.text || k.shortText || '',
  };
}

// summary (e opcionalmente a competição do scoreboard, que tem o relógio mais fresco) → snapshot normalizado
function parseSummary(sum, league, sbComp) {
  const comp = sum?.header?.competitions?.[0];
  if (!comp) throw new Error('summary sem header');
  const comps = comp.competitors || [];
  const mine = comps.find((c) => String(c.team?.id || c.id) === TEAM_ID);
  if (!mine) throw new Error('jogo sem o Corinthians');
  const other = comps.find((c) => c !== mine) || {};
  const sbMine = sbComp?.competitors?.find((c) => String(c.team?.id || c.id) === TEAM_ID);
  const sbOther = sbComp?.competitors?.find((c) => c !== sbMine);
  const status = sbComp?.status || comp.status || {};
  const side = (team) => {
    const id = String(team?.id || '');
    if (id) return id === TEAM_ID ? 'cor' : 'opp';
    return /corinthians/i.test(team?.displayName || '') ? 'cor' : 'opp';
  };
  const box = sum.boxscore?.teams || [];
  const boxMine = box.find((b) => String(b.team?.id) === TEAM_ID);
  const boxOther = box.find((b) => b !== boxMine);
  const team = (c, sb) => ({
    id: String(c.team?.id || c.id || ''), name: c.team?.displayName || c.team?.name || '?',
    short: c.team?.abbreviation || '', logo: logoOf(c.team),
    score: num(sb?.score ?? c.score) ?? 0,
  });
  const events = (sum.keyEvents || []).map((k, i) => mapKeyEvent(k, side, i)).filter(Boolean);
  const bc = (sum.broadcasts || comp.broadcasts || sbComp?.broadcasts || [])
    .flatMap((b) => b.names || [b.media?.shortName || b.station || b.name]).filter(Boolean);
  return {
    id: String(sum.header.id || comp.id),
    league, leagueName: LEAGUE_NAMES[league] || sum.header.league?.name || league,
    date: comp.date || sum.header.competitions?.[0]?.date,
    isHome: mine.homeAway === 'home',
    venue: sum.gameInfo?.venue?.fullName || comp.venue?.fullName || '',
    broadcasts: [...new Set(bc)],
    statusName: status.type?.name || '', state: status.type?.state || 'pre', completed: !!status.type?.completed,
    clock: status.displayClock || (status.type?.state === 'post' ? "90'" : ''),
    period: status.period || null, statusDetail: statusDetail(status),
    cor: team(mine, sbMine), opp: team(other, sbOther),
    events,
    stats: box.length ? { cor: mapStats(boxMine), opp: mapStats(boxOther) } : null,
  };
}

// Jogo agendado (do schedule/scoreboard) → snapshot mínimo
function parseScheduled(ev, league) {
  const comp = ev.competitions?.[0] || {};
  const comps = comp.competitors || [];
  const mine = comps.find((c) => String(c.team?.id || c.id) === TEAM_ID) || {};
  const other = comps.find((c) => c !== mine) || {};
  const st = comp.status || ev.status || {};
  const t = (c) => ({ id: String(c.team?.id || ''), name: c.team?.displayName || '?', short: c.team?.abbreviation || '', logo: logoOf(c.team), score: num(c.score?.displayValue ?? c.score) ?? 0 });
  return {
    id: String(ev.id), league, leagueName: LEAGUE_NAMES[league] || ev.league?.name || league, date: ev.date || comp.date,
    isHome: mine.homeAway === 'home', venue: comp.venue?.fullName || '',
    broadcasts: (comp.broadcasts || []).flatMap((b) => b.names || [b.media?.shortName]).filter(Boolean),
    statusName: st.type?.name || 'STATUS_SCHEDULED', state: st.type?.state || 'pre', completed: !!st.type?.completed,
    clock: st.displayClock || '', period: st.period || null, statusDetail: statusDetail(st),
    cor: t(mine), opp: t(other), events: [], stats: null,
  };
}

// ============================================================
// Frases (voz do Jarvis)
// ============================================================
const minuteSpoken = (m) => {
  const mm = String(m || '').match(/(\d+)'?(?:\+(\d+))?/);
  if (!mm) return '';
  return mm[2] ? `aos ${mm[1]} mais ${mm[2]}` : `aos ${mm[1]} minutos`;
};
const placar = (snap) => `Corinthians ${snap.cor.score}, ${snap.opp.name} ${snap.opp.score}`;

function say(kind, snap, extra = {}) {
  const opp = snap.opp.name;
  switch (kind) {
    case 'goal_for': {
      const quem = extra.player ? `${extra.player}, ${minuteSpoken(extra.minute)}` : minuteSpoken(extra.minute);
      const og = extra.type === 'own_goal' ? ' Gol contra, mas conta igual, senhor.' : '';
      return `Gol do Corinthians! ${quem}.${og} ${placar(snap)}.`.replace(/\s+/g, ' ');
    }
    case 'goal_against': {
      const d = snap.cor.score - snap.opp.score;
      const tail = d < 0 ? 'Ainda dá tempo, senhor.' : d === 0 ? 'Empate. Respire, senhor.' : 'Seguimos na frente.';
      return `Gol do ${opp}${extra.player ? `, ${extra.player}` : ''}. ${placar(snap)}. ${tail}`;
    }
    case 'kickoff': return `Bola rolando! Corinthians e ${opp}${snap.decisive?.is ? '. Jogo decisivo, senhor' : ''}. Vai, Corinthians!`;
    case 'halftime': return `Fim do primeiro tempo. ${placar(snap)}.`;
    case 'second_half': return `Começa o segundo tempo. ${placar(snap)}.`;
    case 'fulltime': {
      const r = extra.result;
      if (r === 'V') return `Fim de jogo! Vitória do Timão: ${placar(snap)}. Três pontos valiosíssimos, senhor.`;
      if (r === 'E') return `Fim de jogo. Empate: ${placar(snap)}. Um ponto na conta.`;
      return `Fim de jogo. ${placar(snap)}. Dia difícil, senhor. Próximo jogo é outra história.`;
    }
    case 'red_for': return `Cartão vermelho pro Corinthians${extra.player ? `: ${extra.player}` : ''}. Vamos com dez.`;
    case 'red_against': return `Vermelho pro ${opp}${extra.player ? `: ${extra.player}` : ''}! Um a menos pra eles, senhor.`;
    case 'var': return extra.text || 'O VAR entrou em ação. Gol anulado.';
    case 'prematch_60': return `Daqui a uma hora tem Corinthians e ${opp}${snap.broadcasts?.length ? `, com transmissão de ${snap.broadcasts.join(' e ')}` : ''}.`;
    case 'prematch_10': {
      const why = snap.decisive?.reasons?.[0];
      return `Faltam dez minutos para Corinthians e ${opp}.${why ? ` Jogo decisivo: ${why.toLowerCase()}.` : ''} Prepare o coração, senhor.`;
    }
    case 'rival_goal': {
      const r = extra.rival || {};
      return r.good ? `Boa notícia do radar: ${r.name} levou gol. ${r.score} contra o ${r.vs}.` : `Atenção ao radar: ${r.name} marcou. ${r.score} contra o ${r.vs}.`;
    }
    default: return '';
  }
}

// ============================================================
// Jogo decisivo + projeção na tabela
// ============================================================
function parseStandings(json) {
  const entries = json?.children?.[0]?.standings?.entries || [];
  const st = (en, n) => en.stats.find((s) => s.name === n)?.value ?? 0;
  return entries.map((en) => ({
    id: String(en.team.id), name: en.team.shortDisplayName || en.team.displayName, short: en.team.abbreviation,
    logo: logoOf(en.team), rank: st(en, 'rank'), points: st(en, 'points'), played: st(en, 'gamesPlayed'),
    wins: st(en, 'wins'), gd: st(en, 'pointDifferential'),
  })).sort((a, b) => a.rank - b.rank);
}

function decisiveFor(snap, table) {
  const reasons = [];
  if (snap.league && snap.league !== 'bra.1') reasons.push('Mata-mata');
  const me = table?.find((t) => t.id === TEAM_ID);
  if (me && table.length) {
    const size = table.length;
    const z4Line = table.find((t) => t.rank === size - 3); // 1º time dentro do Z4
    const safe = table.find((t) => t.rank === size - 4);   // último fora do Z4
    if (me.rank >= size - 3) reasons.push('Briga contra o rebaixamento');
    else if (z4Line && me.points - z4Line.points <= 3) reasons.push('Briga contra o rebaixamento');
    else if (me.rank <= 6 && (table.find((t) => t.rank === 7)?.points ?? 0) >= me.points - 3) reasons.push('Briga por vaga na Libertadores');
    const left = 38 - (me.played || 0);
    if (snap.league === 'bra.1' && left <= 5) reasons.push('Reta final do Brasileirão');
    void safe;
  }
  if (CLASSICOS.test(snap.opp?.name || '')) reasons.push('Clássico');
  return { is: reasons.length > 0, reasons };
}

const pts = (a, b) => (a > b ? 3 : a === b ? 1 : 0);

function projectTable(table, snap, radar) {
  if (!table?.length) return null;
  const t = table.map((x) => ({ ...x }));
  const me = t.find((x) => x.id === TEAM_ID);
  if (!me) return null;
  if (snap && (snap.state === 'in' || snap.state === 'post')) {
    me.points += pts(snap.cor.score, snap.opp.score);
    me.gd += snap.cor.score - snap.opp.score;
    if (snap.cor.score > snap.opp.score) me.wins += 1;
    const opp = t.find((x) => x.id === snap.opp.id);
    if (opp) { opp.points += pts(snap.opp.score, snap.cor.score); opp.gd += snap.opp.score - snap.cor.score; }
  }
  for (const r of radar || []) {
    if (!r.live && !r.finished) continue;
    const row = t.find((x) => x.id === r.id);
    if (!row || r.id === snap?.opp?.id) continue;
    row.points = r.projectedPoints;
    row.gd += r.gdDelta || 0;
  }
  t.sort((a, b) => b.points - a.points || b.wins - a.wins || b.gd - a.gd);
  const rank = t.findIndex((x) => x.id === TEAM_ID) + 1;
  return { rank, points: me.points };
}

// Radar: rivais diretos (±3 pts do Corinthians) e o jogo deles na rodada
function buildRadar(table, scoreboard, excludeId) {
  const me = table?.find((t) => t.id === TEAM_ID);
  if (!me) return [];
  const rivals = table.filter((t) => t.id !== TEAM_ID && t.id !== excludeId && Math.abs(t.points - me.points) <= 3);
  const games = scoreboard?.events || [];
  return rivals.map((r) => {
    const ev = games.find((e) => e.competitions?.[0]?.competitors?.some((c) => String(c.team?.id) === r.id));
    const base = { id: r.id, name: r.name, short: r.short, logo: r.logo, rank: r.rank, points: r.points,
      live: false, finished: false, score: null, vs: null, clock: null, projectedPoints: r.points, threat: false, gdDelta: 0 };
    if (!ev) return base;
    const comp = ev.competitions[0];
    const mine = comp.competitors.find((c) => String(c.team?.id) === r.id);
    const other = comp.competitors.find((c) => c !== mine);
    const st = comp.status?.type || {};
    const a = num(mine.score) ?? 0, b = num(other?.score) ?? 0;
    const live = st.state === 'in', finished = st.state === 'post';
    const proj = live || finished ? r.points + pts(a, b) : r.points;
    return { ...base, live, finished, score: (live || finished) ? `${a}-${b}` : null, goalsFor: a, goalsAgainst: b,
      vs: other?.team?.shortDisplayName || other?.team?.displayName || '?', clock: live ? (comp.status?.displayClock || '') : (finished ? 'Fim' : null),
      kickoff: ev.date, projectedPoints: proj, threat: (live || finished) && proj > me.points, gdDelta: (live || finished) ? a - b : 0 };
  }).sort((x, y) => y.projectedPoints - x.projectedPoints);
}

// ============================================================
// Tracker: compara snapshots e gera eventos (mesmo código no ao vivo e no simulador)
// ============================================================
function createTracker() {
  let cur = null; // { id, seen:Set, cor, opp, flags:{} }
  return {
    reset() { cur = null; },
    // silent = primeira vez que vemos um jogo já em andamento → não dispara o que já aconteceu
    process(snap, { silent } = {}) {
      const out = [];
      const fresh = !cur || cur.id !== snap.id;
      if (fresh) {
        cur = { id: snap.id, seen: new Set(), cor: 0, opp: 0, flags: {} };
        const alreadyOn = snap.state === 'in' || snap.state === 'post';
        if (silent ?? alreadyOn) {
          snap.events.forEach((e) => cur.seen.add(e.key));
          cur.cor = snap.cor.score; cur.opp = snap.opp.score;
          if (alreadyOn) cur.flags.kickoff = true;
          if (/HALFTIME/.test(snap.statusName) || snap.events.some((e) => e.type === 'halftime')) cur.flags.halftime = true;
          if (snap.events.some((e) => e.type === 'second_half') || snap.period === 2) cur.flags.second_half = true;
          if (snap.state === 'post') cur.flags.fulltime = true;
          return out;
        }
      }
      const base = (kind, extra = {}) => ({ kind, minute: extra.minute || snap.clock || '', score: { cor: snap.cor.score, opp: snap.opp.score }, ...extra });

      // gols pendentes = diferença de placar
      let pend = { cor: snap.cor.score - cur.cor, opp: snap.opp.score - cur.opp };
      for (const s of ['cor', 'opp']) {
        if (pend[s] < 0) { out.push(base('var', { team: s, text: `O VAR anulou um gol ${s === 'cor' ? 'do Corinthians' : `do ${snap.opp.name}`}. ${placar(snap)}.` })); pend[s] = 0; }
      }
      const once = (flag, kind, extra) => { if (!cur.flags[flag]) { cur.flags[flag] = true; out.push(base(kind, extra)); } };

      if (snap.state !== 'pre') once('kickoff', 'kickoff', { minute: "0'" });

      const newEvents = snap.events.filter((e) => !cur.seen.has(e.key));
      for (const e of newEvents) {
        cur.seen.add(e.key);
        if (e.type === 'kickoff') once('kickoff', 'kickoff', { minute: "0'" });
        else if (e.type === 'halftime') once('halftime', 'halftime', { minute: e.minute });
        else if (e.type === 'second_half') once('second_half', 'second_half', { minute: e.minute });
        else if (e.type === 'red') out.push(base(e.team === 'cor' ? 'red_for' : 'red_against', { minute: e.minute, player: e.player }));
        else if (e.type === 'var') out.push(base('var', { minute: e.minute, text: 'O VAR entrou em ação.' }));
        else if (['goal', 'penalty_goal', 'own_goal'].includes(e.type) && e.team && pend[e.team] > 0) {
          pend[e.team]--;
          out.push(base(e.team === 'cor' ? 'goal_for' : 'goal_against', { minute: e.minute, player: e.player, assist: e.assist, type: e.type }));
        }
      }
      // placar mudou mas o lance ainda não apareceu no summary → gol sem autor
      for (const s of ['cor', 'opp']) {
        while (pend[s] > 0) { pend[s]--; out.push(base(s === 'cor' ? 'goal_for' : 'goal_against', { player: null })); }
      }
      cur.cor = snap.cor.score; cur.opp = snap.opp.score;

      if (/HALFTIME/.test(snap.statusName)) once('halftime', 'halftime');
      if (snap.state === 'in' && (snap.period || 0) >= 2 && cur.flags.halftime) once('second_half', 'second_half');
      if (snap.state === 'post' || snap.completed || newEvents.some((e) => e.type === 'fulltime')) {
        const r = snap.cor.score > snap.opp.score ? 'V' : snap.cor.score < snap.opp.score ? 'D' : 'E';
        once('fulltime', 'fulltime', { result: r });
      }
      return out;
    },
  };
}

// ============================================================
// Simulador: transforma um jogo terminado em "fotos" minuto a minuto (formato ESPN)
// ============================================================
function eventTime(k, prev) {
  const disp = k.clock?.displayValue || '';
  const m = disp.match(/(\d+)'?(?:\+(\d+))?/);
  const p = k.period?.number || 1;
  let t = m ? Number(m[1]) + (m[2] ? Number(m[2]) / 10 : 0) : 0;
  const type = k.type?.text || '';
  if (/^kickoff/i.test(type)) t = 0;
  if (/^halftime/i.test(type)) t = 45.9;
  if (p === 2 && t < 46) t = 46;
  if (/end regular time|full time/i.test(type)) t = 95.5;
  return Math.max(t, prev);
}

function buildSimFrames(sum) {
  const comp = sum.header.competitions[0];
  const keys = sum.keyEvents || [];
  let prev = 0;
  const times = keys.map((k) => (prev = eventTime(k, prev)));
  const finalBox = sum.boxscore?.teams || [];
  const ticks = [];
  ticks.push({ t: -1, clock: '', period: 0, name: 'STATUS_SCHEDULED', state: 'pre' });
  for (let m = 0; m <= 45; m++) ticks.push({ t: m, clock: `${m}'`, period: 1, name: 'STATUS_FIRST_HALF', state: 'in' });
  for (let x = 1; x <= 5; x++) ticks.push({ t: 45 + x / 10, clock: `45'+${x}'`, period: 1, name: 'STATUS_FIRST_HALF', state: 'in' });
  ticks.push({ t: 45.9, clock: "45'+5'", period: 1, name: 'STATUS_HALFTIME', state: 'in', pause: 3 });
  for (let m = 46; m <= 90; m++) ticks.push({ t: m, clock: `${m}'`, period: 2, name: 'STATUS_SECOND_HALF', state: 'in' });
  for (let x = 1; x <= 5; x++) ticks.push({ t: 90 + x / 10 + 5, clock: `90'+${x}'`, period: 2, name: 'STATUS_SECOND_HALF', state: 'in' });
  ticks.push({ t: 96, clock: "90'+5'", period: 2, name: 'STATUS_FULL_TIME', state: 'post', completed: true });
  // eventos de acréscimo do 2º tempo (90'+x) entram no tick 95+x/10
  const tAdj = times.map((t, i) => {
    const d = keys[i].clock?.displayValue || '';
    const m = d.match(/^90'\+(\d+)/);
    return m && (keys[i].period?.number === 2) ? 95 + Number(m[1]) / 10 : t;
  });
  return ticks.map((tick) => {
    const included = keys.filter((_, i) => tAdj[i] <= tick.t);
    const goalsBy = (id) => included.filter((k) => k.scoringPlay && String(k.team?.id) === id && !/own goal/i.test(k.type?.text || '')).length
      + included.filter((k) => /own goal/i.test(k.type?.text || '') && k.team && String(k.team.id) !== id).length;
    const frac = Math.max(0, Math.min(1, tick.t / 95));
    const box = finalBox.map((b) => ({
      team: b.team,
      statistics: (b.statistics || []).map((s) => {
        const v = Number(s.displayValue);
        if (Number.isNaN(v) || s.name === 'possessionPct') return s;
        return { ...s, displayValue: String(Math.round(v * frac)) };
      }),
    }));
    return {
      pause: tick.pause || 1,
      summary: {
        header: {
          id: sum.header.id, league: sum.header.league,
          competitions: [{ ...comp, status: { displayClock: tick.clock, period: tick.period, type: { name: tick.name, state: tick.state, completed: !!tick.completed, description: '' } },
            competitors: comp.competitors.map((c) => ({ ...c, score: String(tick.state === 'pre' ? 0 : goalsBy(String(c.team?.id || c.id))) })) }],
        },
        keyEvents: included, boxscore: { teams: tick.state === 'pre' ? [] : box }, gameInfo: sum.gameInfo, broadcasts: [{ names: ['Premiere'] }],
      },
    };
  });
}

// Rivais falsos para o radar do simulador
function simRadar(table, frac, excludeId) {
  const me = table.find((t) => t.id === TEAM_ID) || { points: 37 };
  const rivals = table.filter((t) => t.id !== TEAM_ID && t.id !== excludeId && Math.abs(t.points - me.points) <= 3).slice(0, 2);
  const scripts = [[[30, 0, 1], [70, 1, 1]], [[55, 1, 0]]]; // [minuto, gols pró, gols contra]
  return rivals.map((r, i) => {
    const minute = Math.round(frac * 95);
    const sc = (scripts[i] || []).filter(([m]) => m <= minute).pop() || [0, 0, 0];
    const [, a, b] = sc;
    const live = frac > 0 && frac < 1, finished = frac >= 1;
    const proj = r.points + pts(a, b);
    return { id: r.id, name: r.name, short: r.short, logo: r.logo, rank: r.rank, points: r.points, live, finished,
      score: `${a}-${b}`, goalsFor: a, goalsAgainst: b, vs: i === 0 ? 'Bahia' : 'Vasco', clock: live ? `${minute}'` : finished ? 'Fim' : null,
      projectedPoints: proj, threat: proj > me.points, gdDelta: a - b };
  });
}

// ============================================================
// Serviço (Electron)
// ============================================================
let getWin = () => null;
let cfg = () => ({});
let electron = null;
let userData = null;
let timer = null;
let stopped = false;
let simulating = null; // { stop() }
const tracker = createTracker();
let radarPrev = new Map();
let lastLiveSnap = null;
let postUntil = 0;

const state = {
  phase: 'idle', simulated: false, updatedAt: Date.now(), minutesToKickoff: null,
  match: null, stats: null, events: [], decisive: { is: false, reasons: [] }, standing: null, projected: null, radar: [],
};

function alertedFile() { return userData ? path.join(userData, 'timao.json') : null; }
function loadAlerted() { try { return JSON.parse(fs.readFileSync(alertedFile(), 'utf8')).alerted || {}; } catch { return {}; } }
function markAlerted(id, kind) {
  const f = alertedFile(); if (!f) return;
  const a = loadAlerted();
  a[id] = [...new Set([...(a[id] || []), kind])];
  // guarda só os 30 jogos mais recentes
  const ids = Object.keys(a); if (ids.length > 30) ids.slice(0, ids.length - 30).forEach((k) => delete a[k]);
  try { fs.writeFileSync(f, JSON.stringify({ alerted: a }, null, 2)); } catch {}
}
const wasAlerted = (id, kind) => (loadAlerted()[id] || []).includes(kind);

function matchView(snap) {
  if (!snap) return null;
  return {
    id: snap.id, league: snap.league, leagueName: snap.leagueName, date: snap.date, isHome: snap.isHome, venue: snap.venue,
    broadcasts: snap.broadcasts, clock: snap.clock, period: snap.period, statusDetail: snap.statusDetail,
    cor: { name: snap.cor.name, short: snap.cor.short, logo: snap.cor.logo, score: snap.cor.score },
    opp: { name: snap.opp.name, short: snap.opp.short, logo: snap.opp.logo, score: snap.opp.score },
  };
}

function send(channel, payload) {
  const w = getWin();
  if (w && !w.isDestroyed()) w.webContents.send(channel, payload);
}
function pushState() { state.updatedAt = Date.now(); send('timao:state', getState()); }

const NOTIFY = new Set(['goal_for', 'goal_against', 'kickoff', 'fulltime', 'prematch_60', 'prematch_10']);
function notify(ev) {
  const w = getWin();
  try {
    const hidden = !w || w.isDestroyed() || w.isMinimized() || !w.isVisible() || !w.isFocused();
    if (/^goal_/.test(ev.kind) && w && !w.isDestroyed()) w.flashFrame(true);
    if (ev.kind === 'goal_for' && cfg().timaoPopup && w && !w.isDestroyed()) { if (w.isMinimized()) w.restore(); w.show(); }
    if (!hidden || !NOTIFY.has(ev.kind) || !electron?.Notification?.isSupported()) return;
    const m = ev.match;
    const sc = m ? `${m.cor.short || 'COR'} ${m.cor.score} × ${m.opp.score} ${m.opp.short || m.opp.name}` : '';
    const titles = {
      goal_for: '⚽ GOOOL DO TIMÃO!', goal_against: `Gol do ${m?.opp?.name || 'adversário'}`, kickoff: 'Bola rolando!',
      fulltime: 'Fim de jogo', prematch_60: 'Jogo do Timão em 1 hora', prematch_10: 'Faltam 10 min pro jogo do Timão',
    };
    const n = new electron.Notification({
      title: (ev.simulated ? '[simulação] ' : '') + (titles[ev.kind] || 'Modo Timão'),
      body: [sc, ev.player ? `${ev.player} ${ev.minute || ''}` : ''].filter(Boolean).join(' · ') || ev.say,
      icon: path.join(__dirname, '..', '..', 'assets', 'icon.png'), silent: false,
    });
    n.on('click', () => { const ww = getWin(); if (ww && !ww.isDestroyed()) { if (ww.isMinimized()) ww.restore(); ww.show(); ww.focus(); } });
    n.show();
  } catch {}
}

function emit(kind, snap, extra = {}) {
  const ev = {
    kind, match: snap ? { cor: { ...snap.cor }, opp: { ...snap.opp }, clock: snap.clock } : null,
    minute: extra.minute ?? snap?.clock ?? '', player: extra.player ?? null, assist: extra.assist ?? null,
    score: snap ? { cor: snap.cor.score, opp: snap.opp.score } : null,
    result: extra.result, decisive: extra.decisive, rival: extra.rival, simulated: !!state.simulated,
  };
  ev.say = say(kind, { ...(snap || { cor: {}, opp: {} }), decisive: state.decisive }, { ...extra, ...ev });
  if (kind === 'var' && extra.text) ev.say = extra.text;
  send('timao:event', ev);
  notify(ev);
  return ev;
}

// Aplica um snapshot (ao vivo ou simulado) ao estado + dispara eventos
function applySnapshot(snap, { silent } = {}) {
  const evs = tracker.process(snap, { silent });
  state.match = matchView(snap);
  state.stats = snap.stats;
  state.events = snap.events.map(({ key, period, ...e }) => e);
  state.phase = snap.state === 'post' ? 'post' : /HALFTIME/.test(snap.statusName) ? 'halftime' : snap.state === 'in' ? 'live' : 'pre';
  state.minutesToKickoff = snap.state === 'pre' && snap.date ? Math.round((new Date(snap.date) - Date.now()) / MIN) : null;
  for (const e of evs) emit(e.kind, snap, e);
  return evs;
}

function applyRadar(radar, snap) {
  for (const r of radar) {
    const prev = radarPrev.get(r.id);
    if (prev && r.score && prev.score !== r.score && (r.live || r.finished)) {
      const conceded = (r.goalsAgainst ?? 0) > (prev.goalsAgainst ?? 0);
      const scored = (r.goalsFor ?? 0) > (prev.goalsFor ?? 0);
      if (conceded || scored) emit('rival_goal', snap, { rival: { name: r.name, score: r.score, vs: r.vs, good: conceded && !scored } });
    }
    radarPrev.set(r.id, { score: r.score, goalsFor: r.goalsFor, goalsAgainst: r.goalsAgainst });
  }
  state.radar = radar.map(({ goalsFor, goalsAgainst, gdDelta, kickoff, ...r }) => r);
}

async function standings(league = 'bra.1') {
  try { return parseStandings(await getJSON(urls.standings(league), 10 * MIN)); } catch { return null; }
}

function brDate(iso) {
  const d = new Date(iso);
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  return p.replace(/-/g, '');
}

// Descobre o jogo atual ou o próximo, em todas as ligas configuradas
async function findMatch() {
  const leagues = cfg().timaoLeagues || ['bra.1'];
  let best = null;
  for (const lg of leagues) {
    try {
      // jogo rolando hoje aparece no scoreboard
      const sb = await getJSON(urls.scoreboard(lg), 0);
      for (const ev of sb.events || []) {
        const comp = ev.competitions?.[0];
        if (!comp?.competitors?.some((c) => String(c.team?.id) === TEAM_ID)) continue;
        const st = comp.status?.type?.state;
        if (st === 'in' || (st === 'post' && Date.now() - new Date(ev.date) < 4 * 60 * MIN)) return { ev, league: lg, sbComp: comp };
      }
      const sch = await getJSON(urls.schedule(lg), 10 * MIN);
      for (const ev of sch.events || []) {
        const st = ev.competitions?.[0]?.status?.type;
        if (st?.completed) continue;
        if (!best || new Date(ev.date) < new Date(best.ev.date)) best = { ev, league: lg };
      }
    } catch {}
  }
  return best;
}

function schedule(ms) {
  clearTimeout(timer);
  if (stopped || simulating) return;
  timer = setTimeout(() => tick().catch(() => schedule(60 * 1000)), ms);
}

async function tick() {
  if (simulating) return;
  let next = 10 * MIN;
  try {
    const table = await standings();
    if (table) {
      const me = table.find((t) => t.id === TEAM_ID);
      if (me) state.standing = { rank: me.rank, points: me.points, size: table.length };
    }
    const found = await findMatch();
    if (!found) {
      if (Date.now() > postUntil) Object.assign(state, { phase: 'idle', match: null, stats: null, events: [], radar: [], projected: null, minutesToKickoff: null });
      pushState(); return schedule(next);
    }
    const { ev, league } = found;
    const st = ev.competitions?.[0]?.status?.type?.state || 'pre';
    const mins = (new Date(ev.date) - Date.now()) / MIN;

    let snap;
    if (st === 'pre') {
      snap = parseScheduled(ev, league);
      state.decisive = decisiveFor(snap, table);
      if (mins > 70) {
        // longe do jogo: só mostra o próximo
        Object.assign(state, { phase: 'idle', match: matchView(snap), stats: null, events: [], radar: [], projected: null, minutesToKickoff: Math.round(mins) });
        pushState();
        return schedule(Math.min(10 * MIN, Math.max(MIN, (mins - 70) * MIN)));
      }
      applySnapshot(snap);
      if (mins <= 60 && mins > 10 && !wasAlerted(snap.id, 'prematch_60')) { markAlerted(snap.id, 'prematch_60'); emit('prematch_60', snap, { decisive: state.decisive }); }
      if (mins <= 10 && mins > -5 && state.decisive.is && !wasAlerted(snap.id, 'prematch_10')) { markAlerted(snap.id, 'prematch_10'); emit('prematch_10', snap, { decisive: state.decisive }); }
      next = MIN;
    } else {
      const date = brDate(ev.date);
      const [sum, sb] = await Promise.all([
        getJSON(urls.summary(league, ev.id), 0),
        getJSON(urls.scoreboard(league, date), 0).catch(() => null),
      ]);
      const sbComp = found.sbComp || sb?.events?.find((e) => String(e.id) === String(ev.id))?.competitions?.[0];
      snap = parseSummary(sum, league, sbComp);
      if (!state.decisive.reasons.length) state.decisive = decisiveFor(snap, table);
      // primeira vez vendo o jogo já em andamento (ex.: abriu o PC no meio do jogo) → sem disparar o que já passou
      const firstSight = !lastLiveSnap || lastLiveSnap.id !== snap.id;
      applySnapshot(snap, firstSight ? { silent: true } : {});
      lastLiveSnap = snap;
      if (league === 'bra.1' && table && sb) {
        applyRadar(buildRadar(table, sb, snap.opp.id), snap);
        state.projected = projectTable(table, snap, state.radar);
      }
      if (snap.state === 'post') { postUntil = postUntil || Date.now() + 2 * 60 * MIN; next = 5 * MIN; }
      else next = 15 * 1000;
    }
    state.simulated = false;
    pushState();
  } catch {
    next = Math.min(next, 60 * 1000); // erro de rede: tenta de novo logo
  }
  schedule(next);
}

// ---------- Simulação ----------
async function simulate({ speed = 2 } = {}) {
  stopSim(true);
  clearTimeout(timer);
  const sum = await getJSON(urls.summary('bra.1', SIM_EVENT), 24 * 60 * MIN);
  const table = (await standings()) || [];
  const frames = buildSimFrames(sum);
  const me = table.find((t) => t.id === TEAM_ID);
  let cancelled = false;
  const saved = JSON.parse(JSON.stringify(state));
  simulating = { stop: () => { cancelled = true; } };
  tracker.reset(); radarPrev = new Map();
  Object.assign(state, { simulated: true, events: [], radar: [], projected: null });
  if (me) state.standing = { rank: me.rank, points: me.points, size: table.length };

  const first = parseSummary(frames[0].summary, 'bra.1');
  first.date = new Date(Date.now() + 10 * MIN).toISOString();
  state.decisive = decisiveFor(first, table);
  if (!state.decisive.is) state.decisive = { is: true, reasons: ['Briga contra o rebaixamento'] };
  applySnapshot(first);
  state.minutesToKickoff = 10;
  pushState();
  emit('prematch_10', first, { decisive: state.decisive });

  const wait = (s) => new Promise((r) => setTimeout(r, Math.max(0, s * 1000)));
  (async () => {
    await wait(Math.max(4, speed * 3));
    for (let i = 1; i < frames.length && !cancelled; i++) {
      const snap = parseSummary(frames[i].summary, 'bra.1');
      snap.date = first.date;
      applySnapshot(snap);
      const frac = Math.min(1, i / (frames.length - 1));
      if (table.length) { applyRadar(simRadar(table, frac, snap.opp.id), snap); state.projected = projectTable(table, snap, state.radar); }
      pushState();
      await wait(speed * frames[i].pause);
    }
    if (!cancelled) await wait(Math.max(15, speed * 8)); // mostra o "post" um pouco
    if (simulating && !cancelled) stopSim();
    void saved;
  })().catch(() => stopSim());
  return { frames: frames.length, seconds: Math.round(frames.length * speed) };
}

function stopSim(silent) {
  if (!simulating) return false;
  simulating.stop();
  simulating = null;
  tracker.reset(); radarPrev = new Map(); lastLiveSnap = null;
  Object.assign(state, { simulated: false, phase: 'idle', match: null, stats: null, events: [], radar: [], projected: null, decisive: { is: false, reasons: [] } });
  if (!silent) { pushState(); schedule(500); }
  return true;
}

// Só um gol (testar animação/sirene)
let testTimer = null;
function testGoal({ against = false } = {}) {
  if (simulating) stopSim(true);
  clearTimeout(testTimer);
  const opp = state.match?.opp?.name && state.match.opp.name !== 'Corinthians' ? state.match.opp : { name: 'Botafogo', short: 'BOT', logo: 'https://a.espncdn.com/i/teamlogos/soccer/500/6086.png' };
  const snap = {
    id: 'teste', league: 'bra.1', leagueName: 'Brasileirão', date: new Date().toISOString(), isHome: true, venue: 'Neo Química Arena',
    broadcasts: [], statusName: 'STATUS_SECOND_HALF', state: 'in', completed: false, clock: "77'", period: 2, statusDetail: '2º tempo',
    cor: { name: 'Corinthians', short: 'COR', logo: 'https://a.espncdn.com/i/teamlogos/soccer/500/874.png', score: against ? 1 : 2 },
    opp: { name: opp.name, short: opp.short, logo: opp.logo, score: against ? 2 : 1 }, events: [], stats: null,
  };
  const saved = JSON.parse(JSON.stringify(state));
  Object.assign(state, { phase: 'live', simulated: true, match: matchView(snap), events: [{ type: 'goal', minute: "77'", team: against ? 'opp' : 'cor', player: against ? 'Atacante Rival' : 'Yuri Alberto', assist: against ? null : 'Rodrigo Garro', text: '' }] });
  pushState();
  emit(against ? 'goal_against' : 'goal_for', snap, { minute: "77'", player: against ? 'Atacante Rival' : 'Yuri Alberto', assist: against ? null : 'Rodrigo Garro' });
  testTimer = setTimeout(() => { Object.assign(state, saved, { simulated: false }); pushState(); }, 20000);
  return true;
}

function getState() { return JSON.parse(JSON.stringify(state)); }

function init(winGetter, configGetter) {
  electron = require('electron');
  getWin = winGetter;
  cfg = configGetter || (() => ({}));
  userData = electron.app.getPath('userData');
  const { ipcMain } = electron;
  const safe = (fn) => async (_e, ...a) => { try { return { ok: true, data: await fn(...a) }; } catch (e) { return { ok: false, error: e.message || String(e) }; } };
  ipcMain.handle('timao:get', safe(() => getState()));
  ipcMain.handle('timao:simulate', safe((opts) => simulate(opts || {})));
  ipcMain.handle('timao:stopSim', safe(() => stopSim()));
  ipcMain.handle('timao:testGoal', safe((opts) => testGoal(opts || {})));
  schedule(3000);
}

function stop() { stopped = true; clearTimeout(timer); clearTimeout(testTimer); if (simulating) simulating.stop(); }

module.exports = {
  init, stop, getState, simulate, stopSim, testGoal,
  // lógica pura (testes)
  parseSummary, parseScheduled, parseStandings, createTracker, buildSimFrames, decisiveFor, projectTable, buildRadar, simRadar, say, getJSON, urls, SIM_EVENT,
};
