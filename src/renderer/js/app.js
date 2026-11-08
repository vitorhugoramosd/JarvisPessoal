// J.A.R.V.I.S. — interface (processo de renderização)
import { TRACKS } from './music.js';

const J = window.jarvis;
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

// ---------- Utilitários ----------
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); return node; }
function ago(date) {
  const t = typeof date === 'number' ? date : new Date(date).getTime();
  if (!t || isNaN(t)) return '';
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return 'agora';
  if (s < 3600) return `há ${Math.floor(s / 60)} min`;
  if (s < 86400) return `há ${Math.floor(s / 3600)} h`;
  const d = Math.floor(s / 86400);
  return d === 1 ? 'ontem' : `há ${d} dias`;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pad = (n) => String(n).padStart(2, '0');
const periodo = (h = new Date().getHours()) => (h < 5 ? 'Boa madrugada' : h < 12 ? 'Bom dia' : h < 18 ? 'Boa tarde' : 'Boa noite');
const offline = (node, msg = 'sem conexão — tentando de novo') => { clear(node).appendChild(el('div', 'dim mono', msg)); };
const fmtDate = (d, o) => new Date(d).toLocaleString('pt-BR', o);
const dayOfYear = () => { const n = new Date(); return Math.floor((n - new Date(n.getFullYear(), 0, 0)) / 86400000); };

let CFG = { userName: 'Vitor', voice: true, autoBriefing: true, askOnStart: true };
const STATE = { weather: null, football: null, news: {}, games: null };

// ============================================================
// 1. Fundo animado (grade + partículas)
// ============================================================
function startBackground() {
  const c = $('#bg');
  const ctx = c.getContext('2d');
  let W, H, pts;
  const resize = () => {
    W = c.width = innerWidth; H = c.height = innerHeight;
    const n = Math.round((W * H) / 26000);
    pts = Array.from({ length: n }, () => ({ x: Math.random() * W, y: Math.random() * H, vx: (Math.random() - 0.5) * 0.25, vy: (Math.random() - 0.5) * 0.25 }));
  };
  resize();
  addEventListener('resize', resize);
  let t = 0, last = 0;
  function frame(now) {
    requestAnimationFrame(frame);
    if (document.hidden || now - last < 33) return; // ~30 fps
    last = now; t += 0.4;
    ctx.clearRect(0, 0, W, H);
    // grade
    ctx.strokeStyle = 'rgba(0,200,255,0.05)';
    ctx.lineWidth = 1;
    const g = 48, off = t % g;
    ctx.beginPath();
    for (let x = 0; x < W; x += g) { ctx.moveTo(x, 0); ctx.lineTo(x, H); }
    for (let y = -g + off; y < H; y += g) { ctx.moveTo(0, y); ctx.lineTo(W, y); }
    ctx.stroke();
    // partículas + linhas
    for (const p of pts) {
      p.x += p.vx; p.y += p.vy;
      if (p.x < 0 || p.x > W) p.vx *= -1;
      if (p.y < 0 || p.y > H) p.vy *= -1;
    }
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i];
      for (let j = i + 1; j < pts.length; j++) {
        const b = pts[j], dx = a.x - b.x, dy = a.y - b.y, d = dx * dx + dy * dy;
        if (d < 14000) {
          ctx.strokeStyle = `rgba(0,220,255,${0.12 * (1 - d / 14000)})`;
          ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
        }
      }
      ctx.fillStyle = 'rgba(0,230,255,0.5)';
      ctx.fillRect(a.x - 1, a.y - 1, 2, 2);
    }
  }
  requestAnimationFrame(frame);
}

// ============================================================
// Carregamento de dados (disparado logo na abertura)
// ============================================================
const loaders = {
  games: () => J.games().then((d) => (STATE.games = d)),
  football: () => J.football().then((d) => (STATE.football = d)),
  weather: () => J.weather().then((d) => (STATE.weather = d)),
  news: (k) => J.news(k).then((d) => (STATE.news[k] = d)),
};
let P = {};
function kickoff() {
  P = {
    games: loaders.games().catch(() => null),
    football: loaders.football().catch(() => null),
    weather: loaders.weather().catch(() => null),
    tech: loaders.news('tech').catch(() => null),
    geo: loaders.news('geo').catch(() => null),
    timao: loaders.news('timao').catch(() => null),
  };
}

// ============================================================
// 2. Abertura
// ============================================================
let entered = false;
function speak(text) {
  if (!CFG.voice || !('speechSynthesis' in window)) return;
  const go = () => {
    const vs = speechSynthesis.getVoices().filter((v) => /^pt/i.test(v.lang));
    if (!vs.length) return;
    const v = vs.find((x) => /maria|francisca|antonio/i.test(x.name) && /BR/i.test(x.lang)) || vs.find((x) => /BR/i.test(x.lang)) || vs[0];
    const u = new SpeechSynthesisUtterance(text);
    u.voice = v; u.lang = v.lang; u.rate = 1.02; u.pitch = 0.95;
    speechSynthesis.cancel(); speechSynthesis.speak(u);
  };
  if (speechSynthesis.getVoices().length) go();
  else speechSynthesis.addEventListener('voiceschanged', go, { once: true });
}

async function boot() {
  const log = $('#bootlog');
  const n = await Promise.race([P.games.then((g) => g?.total ?? '?'), sleep(500).then(() => '…')]);
  const lines = [
    '› Inicializando núcleo J.A.R.V.I.S.… OK',
    '› Conectando satélites de notícias… OK',
    '› Sincronizando com a Neo Química Arena… OK',
    `› Indexando biblioteca de jogos (${n} títulos)… OK`,
    '› Afinando as guitarras… OK',
    '› Calibrando nível de sarcasmo… 12%',
  ];
  const cursor = el('span', 'cursor', '▌');
  log.appendChild(cursor);
  for (const line of lines) {
    if (entered) return;
    const m = line.match(/^(.*?)(OK|\d+%)$/);
    const row = el('span', null, m ? m[1] : line);
    if (m) row.appendChild(el('span', 'ok', m[2]));
    row.appendChild(document.createTextNode('\n'));
    log.insertBefore(row, cursor);
    await sleep(290);
  }
  if (entered) return;
  const p = periodo();
  $('#helloTitle').textContent = `Olá, ${CFG.userName}.`;
  $('#helloSub').textContent = `${p}. Todos os sistemas operacionais.`;
  $('#hello').classList.remove('hidden');
  if (CFG.askOnStart) {
    $('#question').classList.remove('hidden');
    speak(`Olá, ${CFG.userName}. ${p}. Todos os sistemas operacionais. Vai jogar, ou vamos fazer outra coisa?`);
    const g = await P.games;
    if (g?.last && !entered) {
      const b = $('#btnContinue');
      b.textContent = `ou continuar ${g.last.name} ›`;
      b.classList.remove('hidden');
    }
  } else {
    speak(`Olá, ${CFG.userName}. ${p}. Todos os sistemas operacionais.`);
    await sleep(1500);
    enterDashboard();
  }
}

function enterDashboard() {
  if (entered) return;
  entered = true;
  document.removeEventListener('keydown', bootKeys);
  const b = $('#boot');
  b.classList.add('leaving');
  $('#hud').classList.remove('hidden');
  setTimeout(() => b.classList.add('hidden'), 600);
  startDashboard();
}
async function choosePlay() {
  try { await J.openBladeDash(); } catch (e) { console.warn(e); }
  enterDashboard();
}
async function chooseContinue() {
  const g = STATE.games || (await P.games);
  if (g?.last) { try { await J.launchGame(g.last.id); } catch (e) { console.warn(e); } }
  enterDashboard();
}
function bootKeys(e) {
  if ($('#question').classList.contains('hidden')) { if (e.key === 'Escape') enterDashboard(); return; }
  const k = e.key.toLowerCase();
  if (k === 'j') choosePlay();
  else if (k === 'enter' || k === 'escape') enterDashboard();
  else if (k === 'c' && !$('#btnContinue').classList.contains('hidden')) chooseContinue();
}

// ============================================================
// 3. Barra superior
// ============================================================
function startClock() {
  const tick = () => {
    const d = new Date();
    $('#clock').textContent = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    $('#date').textContent = d.toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' });
  };
  tick(); setInterval(tick, 1000);
}
async function loadQuotes() {
  const box = $('#ticker');
  try {
    const qs = await J.quotes();
    clear(box);
    for (const q of qs) {
      const up = q.pct >= 0;
      const it = el('span', `tick ${up ? 'up' : 'down'}`);
      const val = q.code === 'BTC' ? q.bid.toLocaleString('pt-BR', { maximumFractionDigits: 0 }) : q.bid.toFixed(2).replace('.', ',');
      it.append(el('b', null, q.code), ` R$ ${val} `, el('small', null, `${up ? '▲' : '▼'} ${Math.abs(q.pct).toFixed(2).replace('.', ',')}%`));
      box.appendChild(it);
    }
  } catch { offline(box, 'cotações offline'); }
}

// ============================================================
// 4. Saudação
// ============================================================
const STATUS = [
  'Todos os sistemas operacionais.',
  'Firewall de bom humor: ativo.',
  'Monitorando o Timão em tempo real.',
  'Nível de cafeína recomendado: alto.',
  'Guitarras afinadas. Amplificadores aquecidos.',
  'Satélites de notícias sincronizados.',
  'Pressione / para falar comigo.',
  'Ctrl + Alt + J me traz de volta de qualquer lugar.',
];
function startGreet() {
  const upd = () => ($('#greetTitle').textContent = `${periodo()}, ${CFG.userName}.`);
  upd(); setInterval(upd, 60000);
  let i = 0;
  setInterval(() => { i = (i + 1) % STATUS.length; $('#greetSub').textContent = STATUS[i]; }, 7000);
}

// ============================================================
// 5. Clima
// ============================================================
const WMO = (c) => {
  if (c === 0) return ['☀', 'Céu limpo'];
  if (c <= 2) return ['⛅', 'Parcialmente nublado'];
  if (c === 3) return ['☁', 'Nublado'];
  if (c <= 48) return ['🌫', 'Neblina'];
  if (c <= 57) return ['🌦', 'Garoa'];
  if (c <= 67) return ['🌧', 'Chuva'];
  if (c <= 77) return ['❄', 'Neve'];
  if (c <= 82) return ['🌧', 'Pancadas de chuva'];
  if (c <= 86) return ['❄', 'Neve'];
  return ['⛈', 'Tempestade'];
};
function renderWeather() {
  const box = $('#weather');
  const w = STATE.weather;
  if (!w) return offline(box);
  $('#wPlace').textContent = w.place || '';
  clear(box);
  const c = w.current;
  const [ic, desc] = WMO(c.weather_code);
  const now = el('div', 'w-now');
  now.append(el('span', 'ico', ic), el('span', 't', `${Math.round(c.temperature_2m)}°`));
  const info = el('div');
  info.append(el('div', 'desc', desc), el('div', 'meta', `Sensação ${Math.round(c.apparent_temperature)}° · Umidade ${c.relative_humidity_2m}% · Vento ${Math.round(c.wind_speed_10m)} km/h`));
  now.appendChild(info);
  const days = el('div', 'w-days');
  const d = w.daily;
  for (let i = 1; i < Math.min(4, d.time.length); i++) {
    const day = el('div', 'w-day');
    const name = new Date(d.time[i] + 'T12:00').toLocaleDateString('pt-BR', { weekday: 'short' }).replace('.', '');
    day.append(el('b', null, name), el('span', 'ico', WMO(d.weather_code[i])[0]),
      el('span', null, `${Math.round(d.temperature_2m_min[i])}° / ${Math.round(d.temperature_2m_max[i])}°`),
      el('small', 'rain', `💧 ${d.precipitation_probability_max[i] ?? 0}%`));
    days.appendChild(day);
  }
  box.append(now, days);
}
async function loadWeather() { try { await loaders.weather(); } catch {} renderWeather(); }

// ============================================================
// 6. Sistema
// ============================================================
const GB = (b) => (b / 1024 ** 3).toFixed(1).replace('.', ',');
function bar(label, pct, value) {
  const b = el('div', 'bar');
  const head = el('div', 'bar-head');
  head.append(el('span', 'label', label), el('span', 'value', value ?? `${pct}%`));
  const track = el('div', 'track');
  const fill = el('div', `fill${pct >= 90 ? ' hot' : pct >= 70 ? ' warn' : ''}`);
  fill.style.width = `${Math.min(100, Math.max(0, pct))}%`;
  track.appendChild(fill);
  b.append(head, track);
  return b;
}
function kv(k, v) { const r = el('div', 'kv'); r.append(el('span', 'dim', k), el('span', null, v)); return r; }
async function loadSystem() {
  const box = $('#system');
  try {
    const s = await J.system();
    $('#sysHost').textContent = s.host || '';
    clear(box);
    const used = s.memTotal - s.memFree;
    box.append(bar('CPU', s.cpu), bar('RAM', Math.round((used / s.memTotal) * 100), `${GB(used)} / ${GB(s.memTotal)} GB`));
    for (const d of s.disks || []) {
      if (!d.size) continue;
      const pct = Math.round(((d.size - d.free) / d.size) * 100);
      box.appendChild(bar(`Disco ${d.id}`, pct, `${GB(d.free)} GB livres`));
    }
    const h = Math.floor(s.uptime / 3600), m = Math.floor((s.uptime % 3600) / 60);
    box.append(kv('Ligado há', `${h}h ${pad(m)}m`), kv('Processador', `${s.cpuModel || '?'} · ${s.cores} núcleos`), kv('Operador', s.user || ''));
  } catch { offline(box); }
}

// ============================================================
// 7. Corinthians
// ============================================================
let countdownTimer = null;
function countdown(date) {
  const ms = new Date(date) - Date.now();
  if (ms <= 0) return 'é agora! Vai, Corinthians!';
  const d = Math.floor(ms / 86400000), h = Math.floor((ms % 86400000) / 3600000), m = Math.floor((ms % 3600000) / 60000);
  return `faltam ${d ? d + 'd ' : ''}${pad(h)}h ${pad(m)}m`;
}
function teamImg(src, alt) {
  const i = el('img'); i.alt = alt || ''; if (src) i.src = src; i.loading = 'lazy';
  i.onerror = () => (i.style.visibility = 'hidden');
  return i;
}
function renderFootball() {
  const box = $('#football');
  const f = STATE.football;
  if (!f || (!f.standing && !f.last?.length)) return offline(box, 'dados do Timão indisponíveis — tentando de novo');
  clear(box);
  const st = f.standing;
  const size = f.size || 20;

  // Cabeçalho
  const head = el('div', 'fb-head');
  head.appendChild(teamImg(f.team?.logo, 'Corinthians'));
  if (st) {
    const pos = el('div', 'pos', `${st.rank}`);
    pos.appendChild(el('small', null, 'º'));
    head.appendChild(pos);
    const nums = el('div', 'pts');
    nums.append(el('b', null, `${st.points} pts`), el('span', 'dim', `${st.played} jogos · ${st.wins}V ${st.ties}E ${st.losses}D · saldo ${st.gd > 0 ? '+' : ''}${st.gd}`));
    head.appendChild(nums);
  }
  box.appendChild(head);

  // Alerta de situação
  if (st) {
    const left = Math.max(0, 38 - st.played);
    if (st.rank >= size - 3) {
      const safe = f.table.find((t) => t.rank === size - 4);
      const gap = safe ? safe.points - st.points : null;
      const a = el('div', 'fb-alert', `⚠ ZONA DE REBAIXAMENTO — ${st.points} pts, ${left} jogos restantes`);
      if (gap != null) a.appendChild(el('small', null, ` · a ${Math.max(gap, 0)} pt${gap === 1 ? '' : 's'} de sair (${safe.name} é o ${safe.rank}º)`));
      box.appendChild(a);
    } else if (st.rank <= 4) {
      box.appendChild(el('div', 'fb-alert ok', `★ G4 — ${st.rank}º lugar, ${left} jogos restantes`));
    } else {
      const z = f.table.find((t) => t.rank === size - 3);
      box.appendChild(el('div', `fb-alert ${st.rank >= size - 6 ? 'warn' : 'neutral'}`, `${left} jogos restantes${z ? ` · ${st.points - z.points} pts acima do Z4` : ''}`));
    }
  }

  const cols = el('div', 'fb-cols');
  const leftCol = el('div', 'fb-colL');

  // Últimos resultados
  if (f.last?.length) {
    const form = el('div', 'fb-form');
    form.appendChild(el('span', 'label', 'Últimos'));
    for (const g of [...f.last].reverse()) {
      const r = el('span', `res ${g.result}`, g.result);
      r.title = `${g.home ? 'Corinthians' : g.opponent} ${g.home ? g.myScore : g.opScore} x ${g.home ? g.opScore : g.myScore} ${g.home ? g.opponent : 'Corinthians'} · ${fmtDate(g.date, { day: '2-digit', month: '2-digit' })}`;
      form.appendChild(r);
    }
    leftCol.appendChild(form);
  }

  // Próximo jogo
  if (f.next?.length) {
    const n = f.next[0];
    const card = el('div', 'fb-next');
    const vs = el('div', 'opp');
    vs.append(teamImg(f.team?.logo), el('b', null, n.home ? 'Corinthians x ' + n.opponent : n.opponent + ' x Corinthians'), teamImg(n.opponentLogo, n.opponent));
    const cd = el('div', 'countdown', countdown(n.date));
    card.append(el('span', 'tag', 'PRÓXIMO JOGO'), vs,
      el('div', 'when', `${fmtDate(n.date, { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })} · ${n.home ? 'em casa' : 'fora'}${n.venue ? ' · ' + n.venue : ''}`), cd);
    clearInterval(countdownTimer);
    countdownTimer = setInterval(() => (cd.textContent = countdown(n.date)), 30000);
    for (const o of f.next.slice(1, 3)) {
      card.appendChild(el('div', 'meta small', `${fmtDate(o.date, { day: '2-digit', month: '2-digit' })} · ${o.home ? 'x ' + o.opponent + ' (casa)' : '@ ' + o.opponent}`));
    }
    leftCol.appendChild(card);
  }
  cols.appendChild(leftCol);

  // Mini tabela
  if (st && f.table?.length) {
    const tb = el('table', 'fb-table');
    const from = Math.max(1, st.rank - 3), to = Math.min(size, st.rank + 3);
    for (const t of f.table.filter((x) => x.rank >= from && x.rank <= to)) {
      const tr = el('tr', `${t.id === st.id || t.rank === st.rank ? 'me' : ''}${t.rank >= size - 3 ? ' z4' : ''}`.trim());
      tr.append(el('td', null, `${t.rank}`), el('td', null, t.name), el('td', null, `${t.points}`), el('td', 'dim', `${t.played}j`));
      tb.appendChild(tr);
    }
    cols.appendChild(tb);
  }
  box.appendChild(cols);

  // Notícias do Timão
  const nw = STATE.news.timao;
  if (nw?.length) {
    const ul = el('ul', 'fb-news');
    for (const it of nw.slice(0, 3)) {
      const li = el('li', null, it.title);
      li.appendChild(el('span', 'meta', ` · ${it.source || ''} ${ago(it.date)}`));
      li.onclick = () => J.open(it.link);
      ul.appendChild(li);
    }
    box.appendChild(ul);
  }
}
async function loadFootball() {
  await Promise.allSettled([loaders.football(), loaders.news('timao')]);
  renderFootball();
}

// ============================================================
// 8. Notícias
// ============================================================
let currentTab = 'tech';
function renderNews(k) {
  const ul = clear($('#news'));
  const items = STATE.news[k];
  if (!items) return ul.appendChild(el('li', 'dim mono', 'carregando…'));
  if (!items.length) return ul.appendChild(el('li', 'dim mono', 'sem conexão — tentando de novo'));
  for (const it of items.slice(0, 12)) {
    const li = el('li');
    li.append(el('span', 'title', it.title), el('span', 'meta', `${it.source || 'Google Notícias'} · ${ago(it.date)}`));
    li.title = 'Abrir no navegador';
    li.onclick = () => J.open(it.link);
    ul.appendChild(li);
  }
}
async function showTab(k, force = false) {
  currentTab = k;
  $$('#newsTabs button').forEach((b) => b.classList.toggle('on', b.dataset.k === k));
  renderNews(k);
  if (force || !STATE.news[k]) {
    try { await loaders.news(k); } catch { STATE.news[k] = STATE.news[k] || []; }
    if (currentTab === k) renderNews(k);
  }
}

// ============================================================
// 9. Jogos
// ============================================================
async function launch(id) { try { await J.launchGame(id); } catch (e) { alert(e.message); } }
function renderGames() {
  const g = STATE.games;
  const box = clear($('#lastGame'));
  box.classList.remove('empty');
  box.style.backgroundImage = '';
  const rec = clear($('#recentGames'));
  if (!g || !g.available) {
    $('#gameCount').textContent = '';
    box.classList.add('empty');
    box.appendChild(el('div', 'dim mono', 'Biblioteca do Blade Dash não encontrada.'));
    return;
  }
  $('#gameCount').textContent = `${g.total} jogos`;
  if (g.last) {
    if (g.last.hero) box.style.backgroundImage = `linear-gradient(90deg, rgba(2,7,13,.92), rgba(2,7,13,.35)), url("${g.last.hero}")`;
    if (g.last.cover) { const i = el('img', 'cover'); i.src = g.last.cover; i.alt = g.last.name; box.appendChild(i); }
    const info = el('div', 'info');
    const hrs = Math.round((g.last.playtimeMinutes || 0) / 60);
    info.append(el('span', 'tag', 'ÚLTIMO JOGO'), el('b', 'name', g.last.name), el('span', 'meta', `jogado ${ago(g.last.lastPlayed)} · ${hrs}h no total`));
    const btn = el('button', 'continue', '▶ Continuar');
    btn.onclick = () => launch(g.last.id);
    info.appendChild(btn);
    box.appendChild(info);
  } else {
    box.classList.add('empty');
    box.appendChild(el('div', 'dim mono', 'Nenhum jogo jogado recentemente.'));
  }
  if (g.top?.length) {
    const top = g.top.filter((t) => t.playtimeMinutes > 0).slice(0, 3).map((t) => `${t.name} ${Math.round(t.playtimeMinutes / 60)}h`);
    if (top.length) rec.appendChild(el('div', 'stats', 'Mais jogados: ' + top.join(' · ')));
  }
  for (const r of g.recent || []) {
    if (!r.cover) continue;
    const i = el('img'); i.src = r.cover; i.alt = r.name; i.title = `Jogar ${r.name}`;
    i.onclick = () => launch(r.id);
    rec.appendChild(i);
  }
}

// ============================================================
// 10. Música
// ============================================================
const yt = (t) => `https://www.youtube.com/results?search_query=${encodeURIComponent(`${t.artist} ${t.song}`)}`;
const sp = (t) => `https://open.spotify.com/search/${encodeURIComponent(`${t.artist} ${t.song}`)}`;
function renderTrack(idx) {
  const t = TRACKS[idx % TRACKS.length];
  const box = clear($('#track'));
  box.append(el('span', 'band', t.artist), el('b', 'song', t.song), el('p', 'why', `“${t.why}”`));
  const btns = el('div', 'links');
  const a = el('button', 'yt', '▶ YouTube'); a.onclick = () => J.open(yt(t));
  const b = el('button', 'sp', '● Spotify'); b.onclick = () => J.open(sp(t));
  btns.append(a, b);
  box.appendChild(btns);
}
function renderMoreTracks(seed) {
  const box = clear($('#moreTracks'));
  box.appendChild(el('small', 'dim', 'Também vale ouvir:'));
  for (let i = 1; i <= 4; i++) {
    const t = TRACKS[(seed * 7 + i * 11) % TRACKS.length];
    const li = el('div', 'item');
    const label = el('span');
    label.append(el('b', null, t.artist), ` — ${t.song}`);
    const a = el('button', 'yt', '▶'); a.title = 'YouTube'; a.onclick = () => J.open(yt(t));
    const b = el('button', 'sp', '●'); b.title = 'Spotify'; b.onclick = () => J.open(sp(t));
    li.append(label, a, b);
    box.appendChild(li);
  }
}

// ============================================================
// 11. Rádio
// ============================================================
const audio = () => $('#audio');
async function loadStations(btn) {
  $$('#radioTags button').forEach((b) => b.classList.toggle('on', b === btn));
  const ul = clear($('#stations'));
  ul.appendChild(el('li', 'dim mono', 'sintonizando…'));
  try {
    const list = await J.radio(btn.dataset.tag, btn.dataset.c || '');
    clear(ul);
    if (!list.length) ul.appendChild(el('li', 'dim mono', 'nenhuma estação encontrada'));
    for (const s of list) {
      const li = el('li');
      const ic = el('img'); ic.alt = ''; if (s.favicon) ic.src = s.favicon; ic.onerror = () => (ic.style.visibility = 'hidden');
      li.append(ic, el('span', 'nm', s.name), el('span', 'br', `${s.country || ''}${s.bitrate ? ' · ' + s.bitrate + 'k' : ''}`));
      li.onclick = () => play(s, li);
      ul.appendChild(li);
    }
  } catch { offline(ul); }
}
function play(s, li) {
  const a = audio();
  $$('#stations li').forEach((x) => x.classList.toggle('on', x === li));
  $('#radioNow').textContent = 'sintonizando ' + s.name + '…';
  a.src = s.url;
  a.volume = +$('#vol').value;
  a.play().catch(() => { $('#radioNow').textContent = 'estação fora do ar'; $('#eq').classList.remove('playing'); });
  a.onplaying = () => { $('#radioNow').textContent = '♪ ' + s.name; $('#eq').classList.add('playing'); };
  a.onerror = () => { $('#radioNow').textContent = 'estação fora do ar'; $('#eq').classList.remove('playing'); };
}
function stopRadio() {
  const a = audio();
  a.pause(); a.removeAttribute('src'); a.load();
  $('#eq').classList.remove('playing');
  $('#radioNow').textContent = 'desligado';
  $$('#stations li').forEach((x) => x.classList.remove('on'));
}

// ============================================================
// 12. Briefing do Claude
// ============================================================
function buildContext() {
  const L = [`Horário: ${new Date().toLocaleString('pt-BR', { weekday: 'long', hour: '2-digit', minute: '2-digit' })} (${periodo()}).`];
  const w = STATE.weather;
  if (w?.current) L.push(`Clima em ${w.place}: ${Math.round(w.current.temperature_2m)}°C, ${WMO(w.current.weather_code)[1].toLowerCase()}; máx. hoje ${Math.round(w.daily.temperature_2m_max[0])}°C, chuva ${w.daily.precipitation_probability_max[0] ?? 0}%.`);
  const f = STATE.football;
  if (f?.standing) {
    const s = f.standing;
    L.push(`Corinthians no Brasileirão: ${s.rank}º de ${f.size}, ${s.points} pts em ${s.played} jogos (${s.wins}V ${s.ties}E ${s.losses}D). Z4 começa no ${f.size - 3}º.`);
  }
  if (f?.last?.length) L.push(`Últimos resultados: ${f.last.map((g) => `${g.result} ${g.myScore}x${g.opScore} vs ${g.opponent}`).join('; ')}.`);
  if (f?.next?.length) { const n = f.next[0]; L.push(`Próximo jogo: ${n.home ? 'em casa contra' : 'fora contra'} ${n.opponent} em ${fmtDate(n.date, { weekday: 'long', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}.`); }
  const titles = (k) => (STATE.news[k] || []).slice(0, 5).map((x) => '- ' + x.title).join('\n');
  if (STATE.news.tech?.length) L.push('Manchetes de tecnologia:\n' + titles('tech'));
  if (STATE.news.geo?.length) L.push('Manchetes de geopolítica:\n' + titles('geo'));
  const g = STATE.games;
  if (g?.last) L.push(`Último jogo dele: ${g.last.name} (${ago(g.last.lastPlayed)}).`);
  return L.join('\n');
}
let briefingBusy = false;
async function generateBriefing() {
  if (briefingBusy) return;
  briefingBusy = true;
  const box = $('#briefing');
  box.classList.add('loading'); box.classList.remove('dim');
  box.textContent = 'J.A.R.V.I.S. analisando…';
  try {
    const r = await J.ask(`Faça um briefing de abertura para o ${CFG.userName} em 3 a 5 frases curtas, no seu estilo, com base nestes dados (não invente nada além deles, sem buscar na web):\n\n${buildContext()}`, { fresh: true, allowWeb: false });
    box.textContent = r.text.trim();
  } catch (e) {
    box.classList.add('dim');
    box.textContent = 'Não consegui falar com o Claude agora: ' + e.message;
  } finally {
    box.classList.remove('loading');
    briefingBusy = false;
  }
}

// ============================================================
// 13. Chat
// ============================================================
function addMsg(cls, text) {
  const m = el('div', `msg ${cls}`);
  if (cls.startsWith('me')) m.appendChild(el('span', 'who', 'VOCÊ'));
  // o rótulo "J.A.R.V.I.S." vem do CSS (.msg.ai::before)
  m.appendChild(el('div', 'txt', text));
  const log = $('#chatLog');
  log.appendChild(m);
  log.scrollTop = log.scrollHeight;
  return m;
}
function welcomeChat() {
  addMsg('ai', `À sua disposição, ${CFG.userName}. Pergunte o que quiser — eu consulto a web se precisar.`);
}
async function sendChat(e) {
  e.preventDefault();
  const input = $('#chatInput');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  input.disabled = true;
  addMsg('me', text);
  const wait = addMsg('ai thinking', 'processando…');
  try {
    const r = await J.ask(text);
    wait.remove();
    addMsg('ai', r.text.trim() || '(sem resposta)');
  } catch (err) {
    wait.remove();
    addMsg('err', 'Falha na comunicação: ' + err.message);
  } finally {
    input.disabled = false;
    input.focus();
  }
}

// ============================================================
// 14. Configurações
// ============================================================
function setupSettings() {
  const dlg = $('#settings');
  $('#btnSettings').onclick = async () => {
    try { CFG = await J.getConfig(); } catch {}
    for (const inp of $$('[data-cfg]', dlg)) {
      const k = inp.dataset.cfg;
      if (inp.type === 'checkbox') inp.checked = !!CFG[k]; else inp.value = CFG[k] ?? '';
    }
    dlg.showModal();
  };
  for (const inp of $$('[data-cfg]', dlg)) {
    inp.addEventListener('change', async () => {
      const k = inp.dataset.cfg;
      const v = inp.type === 'checkbox' ? inp.checked : inp.value.trim();
      try { CFG = await J.setConfig({ [k]: v }); } catch (e) { alert('Não consegui salvar: ' + e.message); }
      if (k === 'userName') $('#greetTitle').textContent = `${periodo()}, ${CFG.userName}.`;
    });
  }
  $('#settingsClose').onclick = () => dlg.close();
}

// ============================================================
// Painel: inicialização
// ============================================================
let dashStarted = false;
async function startDashboard() {
  if (dashStarted) return;
  dashStarted = true;
  startClock();
  startGreet();
  loadQuotes(); setInterval(loadQuotes, 5 * 60 * 1000);

  P.weather.then(renderWeather); setInterval(loadWeather, 30 * 60 * 1000);
  loadSystem(); setInterval(loadSystem, 2000);
  Promise.allSettled([P.football, P.timao]).then(renderFootball); setInterval(loadFootball, 10 * 60 * 1000);
  renderNews('tech');
  P.tech.then(() => currentTab === 'tech' && renderNews('tech'));
  setInterval(() => showTab(currentTab, true), 15 * 60 * 1000);
  P.games.then(renderGames); setInterval(() => loaders.games().then(renderGames).catch(() => {}), 5 * 60 * 1000);

  const seed = dayOfYear();
  renderTrack(seed); renderMoreTracks(seed);
  loadStations($('#radioTags button'));

  welcomeChat();

  // Briefing automático (espera os dados, no máximo 8 s)
  if (CFG.autoBriefing) {
    await Promise.race([Promise.allSettled([P.football, P.tech, P.geo, P.weather]), sleep(8000)]);
    generateBriefing();
  } else {
    $('#briefing').textContent = 'Clique em “gerar” para um briefing do Claude.';
  }
}

function wireEvents() {
  $('#btnPlay').onclick = choosePlay;
  $('#btnOther').onclick = enterDashboard;
  $('#btnContinue').onclick = chooseContinue;
  $('#bootSkip').onclick = enterDashboard;
  document.addEventListener('keydown', bootKeys);

  $$('[data-win]').forEach((b) => (b.onclick = () => J.win(b.dataset.win)));
  $$('#newsTabs button').forEach((b) => (b.onclick = () => showTab(b.dataset.k)));
  $('#btnBlade').onclick = () => J.openBladeDash().catch((e) => alert(e.message));
  $('#btnShuffle').onclick = () => { const i = Math.floor(Math.random() * TRACKS.length); renderTrack(i); renderMoreTracks(i); };
  $$('#radioTags button').forEach((b) => (b.onclick = () => loadStations(b)));
  $('#radioStop').onclick = stopRadio;
  $('#vol').oninput = (e) => (audio().volume = +e.target.value);
  $('#btnBriefing').onclick = generateBriefing;
  $('#chatForm').addEventListener('submit', sendChat);
  $('#btnNewChat').onclick = async () => {
    try { await J.resetChat(); } catch {}
    clear($('#chatLog'));
    addMsg('sys', '— novo assunto —');
    welcomeChat();
  };
  document.addEventListener('keydown', (e) => {
    if (!entered) return;
    const tag = document.activeElement?.tagName;
    if (e.key === '/' && tag !== 'INPUT' && tag !== 'TEXTAREA') { e.preventDefault(); $('#chatInput').focus(); }
  });
  setupSettings();
}

// ---------- Início ----------
(async function main() {
  startBackground();
  try { CFG = { ...CFG, ...(await J.getConfig()) }; } catch {}
  kickoff();
  wireEvents();
  boot();
})();
