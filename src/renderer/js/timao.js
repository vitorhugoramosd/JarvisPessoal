// J.A.R.V.I.S. — Modo Timão: placar ao vivo do Corinthians, gol com sirene, alertas pré-jogo e radar do Z4.
// Contrato com o processo principal: docs/MODO_TIMAO.md (window.jarvis.timao.*).
import * as Voice from './voice.js';

const $ = (s, r = document) => r.querySelector(s);
const MOCK = location.hash === '#timao-mock';

let getCfg = () => ({});
let S = { phase: 'idle' };          // último TimaoState recebido
let api = null;                     // window.jarvis.timao (ou o mock)
let tick = 0;                       // intervalo do relógio local
let lastPhase = 'idle';

// ------------------------------------------------------------
// Utilitários
// ------------------------------------------------------------
function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}
function img(src, cls) {
  const i = el('img', cls);
  i.alt = '';
  if (src) i.src = src; else i.style.visibility = 'hidden';
  i.onerror = () => (i.style.visibility = 'hidden');
  return i;
}
const pad = (n) => String(n).padStart(2, '0');
const cfg = () => getCfg() || {};
const isLive = (p = S.phase) => p === 'live' || p === 'halftime';
const minuteNum = (m) => { const x = String(m || '').match(/(\d+)(?:'\+(\d+))?/); return x ? +x[1] + (x[2] ? +x[2] / 10 : 0) : 0; };

function msToKick() {
  const d = S.match?.date ? new Date(S.match.date).getTime() : NaN;
  if (Number.isFinite(d)) return d - Date.now();
  if (Number.isFinite(S.minutesToKickoff)) return S.minutesToKickoff * 60000;
  return NaN;
}
function countdownText(ms) {
  if (!Number.isFinite(ms)) return '--:--';
  if (ms <= 0) return 'JÁ VAI COMEÇAR';
  const t = Math.round(ms / 1000);
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

// ------------------------------------------------------------
// Som (WebAudio): sirene, torcida, buzina, tons
// ------------------------------------------------------------
let ac = null;
function audio() {
  if (!ac) ac = new AudioContext();
  if (ac.state === 'suspended') ac.resume();
  return ac;
}
function noiseBuffer(ctx, secs) {
  const b = ctx.createBuffer(1, ctx.sampleRate * secs, ctx.sampleRate);
  const d = b.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return b;
}
// Sirene de dois tons + rugido da torcida crescendo. Resolve quando termina.
function siren(secs = 4.2) {
  return new Promise((resolve) => {
    try {
      const c = audio(), t = c.currentTime;
      const master = c.createGain(); master.gain.value = 0.9; master.connect(c.destination);

      const o = c.createOscillator(); o.type = 'sawtooth';
      const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 2400;
      const g = c.createGain(); g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.16, t + 0.08);
      g.gain.setValueAtTime(0.16, t + secs - 0.4);
      g.gain.exponentialRampToValueAtTime(0.0001, t + secs);
      for (let k = 0, x = t; x < t + secs; k++, x += 0.38) o.frequency.setValueAtTime(k % 2 ? 960 : 660, x);
      o.connect(lp); lp.connect(g); g.connect(master);
      o.start(t); o.stop(t + secs + 0.05);

      // torcida: ruído filtrado com envelope crescendo
      const n = c.createBufferSource(); n.buffer = noiseBuffer(c, secs + 2.5);
      const bp = c.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 900; bp.Q.value = 0.6;
      const ng = c.createGain(); ng.gain.setValueAtTime(0.0001, t);
      ng.gain.exponentialRampToValueAtTime(0.35, t + 1.6);
      ng.gain.setValueAtTime(0.35, t + secs);
      ng.gain.exponentialRampToValueAtTime(0.0001, t + secs + 2.4);
      const lfo = c.createOscillator(); lfo.frequency.value = 3.2;
      const lg = c.createGain(); lg.gain.value = 0.08; lfo.connect(lg); lg.connect(ng.gain);
      n.connect(bp); bp.connect(ng); ng.connect(master);
      n.start(t); lfo.start(t); n.stop(t + secs + 2.5); lfo.stop(t + secs + 2.5);
      setTimeout(resolve, (secs + 0.6) * 1000);
    } catch { resolve(); }
  });
}
// Buzina de estádio (alerta "faltam 10 min")
function horn() {
  try {
    const c = audio(), t = c.currentTime;
    const g = c.createGain(); g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.18, t + 0.06);
    g.gain.setValueAtTime(0.18, t + 1.3);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 1.7);
    const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 1400;
    lp.connect(g); g.connect(c.destination);
    for (const f of [185, 233, 277]) {
      const o = c.createOscillator(); o.type = 'sawtooth'; o.frequency.value = f;
      o.connect(lp); o.start(t); o.stop(t + 1.75);
    }
  } catch {}
}
function tone(from, to, dur = 0.8, type = 'sine', vol = 0.2) {
  try {
    const c = audio(), t = c.currentTime;
    const o = c.createOscillator(), g = c.createGain();
    o.type = type; o.frequency.setValueAtTime(from, t); o.frequency.exponentialRampToValueAtTime(to, t + dur);
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol, t + 0.03); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(c.destination); o.start(t); o.stop(t + dur + 0.05);
  } catch {}
}
const chime = () => { tone(880, 880, 0.25, 'sine', 0.12); setTimeout(() => tone(1320, 1320, 0.35, 'sine', 0.12), 160); };
const whistle = () => { tone(2900, 3100, 0.35, 'square', 0.05); setTimeout(() => tone(2900, 3100, 0.7, 'square', 0.05), 450); };

function say(text, { interrupt = false } = {}) {
  if (!text || cfg().timaoVoice === false) return Promise.resolve();
  if (interrupt) Voice.stopSpeaking();
  return Voice.speak(text);
}

// ------------------------------------------------------------
// Confete (canvas) — preto, branco e um toque de ciano
// ------------------------------------------------------------
function confetti(canvas, ms = 6000) {
  const ctx = canvas.getContext('2d');
  const W = (canvas.width = innerWidth), H = (canvas.height = innerHeight);
  const colors = ['#ffffff', '#111111', '#e9e9e9', '#29e3ff', '#2a2a2a'];
  const parts = Array.from({ length: 220 }, () => ({
    x: Math.random() * W, y: -20 - Math.random() * H * 0.6, w: 6 + Math.random() * 8, h: 8 + Math.random() * 14,
    vx: (Math.random() - 0.5) * 3, vy: 2 + Math.random() * 4, r: Math.random() * 6, vr: (Math.random() - 0.5) * 0.3,
    c: colors[(Math.random() * colors.length) | 0],
  }));
  const t0 = performance.now();
  (function frame(now) {
    ctx.clearRect(0, 0, W, H);
    for (const p of parts) {
      p.x += p.vx; p.y += p.vy; p.r += p.vr; p.vy += 0.03;
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.r);
      ctx.fillStyle = p.c; ctx.strokeStyle = 'rgba(41,227,255,.35)';
      ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h); ctx.strokeRect(-p.w / 2, -p.h / 2, p.w, p.h);
      ctx.restore();
    }
    if (now - t0 < ms && canvas.isConnected) requestAnimationFrame(frame);
    else ctx.clearRect(0, 0, W, H);
  })(t0);
}

// ------------------------------------------------------------
// Overlays: gol, alerta pré-jogo, resultado, toasts
// ------------------------------------------------------------
let overlayTimer = 0;
function closeOverlay() {
  clearTimeout(overlayTimer);
  document.body.classList.remove('timao-goal', 'timao-against');
  $('#timaoOverlay')?.remove();
  document.removeEventListener('keydown', escClose);
}
function escClose(e) { if (e.key === 'Escape') closeOverlay(); }
function overlay(cls, build, ms) {
  closeOverlay();
  const o = el('div', 'timao-overlay ' + cls);
  o.id = 'timaoOverlay';
  build(o);
  o.addEventListener('click', closeOverlay);
  document.body.appendChild(o);
  document.addEventListener('keydown', escClose);
  overlayTimer = setTimeout(closeOverlay, ms);
  return o;
}

function scoreLine(ev) {
  const m = ev.match || S.match || {};
  const cor = ev.score?.cor ?? m.cor?.score ?? 0, opp = ev.score?.opp ?? m.opp?.score ?? 0;
  return { cor, opp, corName: m.cor?.short || 'COR', oppName: m.opp?.short || m.opp?.name || 'ADV', corLogo: m.cor?.logo, oppLogo: m.opp?.logo };
}

async function goalFor(ev) {
  Voice.stopSpeaking();
  document.body.classList.add('timao-goal');
  const sc = scoreLine(ev);
  overlay('goal', (o) => {
    const cv = el('canvas', 'confetti'); o.appendChild(cv);
    o.appendChild(el('div', 'goal-stripes'));
    const box = el('div', 'goal-box');
    const big = el('div', 'goal-big', 'GOOOOOL'); big.dataset.text = 'GOOOOOL';
    box.append(big, el('div', 'goal-sub', 'DO TIMÃO'));
    if (ev.player) box.appendChild(el('div', 'goal-player', `⚽ ${ev.player}${ev.minute ? ' · ' + ev.minute : ''}`));
    if (ev.assist) box.appendChild(el('div', 'goal-assist', `assistência: ${ev.assist}`));
    const s = el('div', 'goal-score');
    s.append(img(sc.corLogo, 'lg'), el('b', null, `${sc.corName} ${sc.cor}`), el('span', null, '×'), el('b', null, `${sc.opp} ${sc.oppName}`), img(sc.oppLogo, 'lg'));
    box.appendChild(s);
    if (ev.simulated) box.appendChild(el('div', 'goal-sim', 'SIMULAÇÃO'));
    o.appendChild(box);
    requestAnimationFrame(() => confetti(cv, 6500));
  }, 8000);
  if (cfg().timaoSiren !== false) await siren();
  await say(ev.say || `Gol do Corinthians! ${ev.player ? ev.player + (ev.minute ? ', aos ' + minuteNum(ev.minute) + ' minutos' : '') + '.' : ''} ${sc.corName === 'COR' ? 'Corinthians' : sc.corName} ${sc.cor}, ${S.match?.opp?.name || 'adversário'} ${sc.opp}.`);
}

function goalAgainst(ev) {
  const sc = scoreLine(ev);
  document.body.classList.add('timao-against');
  overlay('against', (o) => {
    const box = el('div', 'against-box');
    box.append(el('div', 'against-title', `GOL ${S.match?.opp?.name ? 'DO ' + S.match.opp.name.toUpperCase() : 'DO ADVERSÁRIO'}`));
    if (ev.player) box.appendChild(el('div', 'against-player', `${ev.player}${ev.minute ? ' · ' + ev.minute : ''}`));
    box.appendChild(el('div', 'against-score', `${sc.corName} ${sc.cor} × ${sc.opp} ${sc.oppName}`));
    o.appendChild(box);
  }, 4200);
  tone(320, 110, 1.1, 'triangle', 0.22);
  say(ev.say || `Gol do adversário. ${ev.player || ''}. Corinthians ${sc.cor}, ${S.match?.opp?.name || 'adversário'} ${sc.opp}.`, { interrupt: true });
}

function prematch10(ev) {
  const m = ev.match || S.match || {};
  const dec = ev.decisive || S.decisive || {};
  overlay('alert', (o) => {
    const box = el('div', 'alert-box');
    box.append(el('div', 'alert-kicker', dec.is ? 'JOGO DECISIVO' : 'PREPARE-SE'), el('div', 'alert-big', 'FALTAM 10 MIN'));
    const vs = el('div', 'alert-vs');
    vs.append(img(m.cor?.logo, 'lg'), el('b', null, m.cor?.name || 'Corinthians'), el('span', null, '×'), el('b', null, m.opp?.name || 'adversário'), img(m.opp?.logo, 'lg'));
    box.appendChild(vs);
    const ul = el('ul', 'alert-reasons');
    for (const r of dec.reasons || []) ul.appendChild(el('li', null, r));
    if (ul.children.length) box.appendChild(ul);
    const info = [m.venue, (m.broadcasts || []).join(' / ')].filter(Boolean).join(' · ');
    if (info) box.appendChild(el('div', 'alert-info', info));
    box.appendChild(el('div', 'alert-cd mono')).dataset.cd = '1';
    o.appendChild(box);
  }, 10000);
  horn();
  setTimeout(() => say(ev.say || `Senhor, faltam dez minutos para Corinthians e ${m.opp?.name || 'adversário'}. ${dec.is ? 'Jogo decisivo.' : ''}`, { interrupt: true }), 1600);
}

function fulltime(ev) {
  const sc = scoreLine(ev);
  const r = ev.result || (sc.cor > sc.opp ? 'V' : sc.cor < sc.opp ? 'D' : 'E');
  const label = { V: 'VITÓRIA', E: 'EMPATE', D: 'DERROTA' }[r];
  overlay('final res-' + r, (o) => {
    if (r === 'V') { const cv = el('canvas', 'confetti'); o.appendChild(cv); requestAnimationFrame(() => confetti(cv, 4000)); }
    const box = el('div', 'final-box');
    box.append(el('div', 'final-kicker', 'FIM DE JOGO'), el('div', 'final-big', label));
    const s = el('div', 'goal-score');
    s.append(img(sc.corLogo, 'lg'), el('b', null, `${sc.corName} ${sc.cor}`), el('span', null, '×'), el('b', null, `${sc.opp} ${sc.oppName}`), img(sc.oppLogo, 'lg'));
    box.appendChild(s);
    if (S.projected) box.appendChild(el('div', 'final-proj', `Na tabela: ${S.projected.rank}º · ${S.projected.points} pts`));
    o.appendChild(box);
  }, 6500);
  whistle();
  if (r === 'V') setTimeout(() => siren(2.2), 900);
  setTimeout(() => say(ev.say || `Fim de jogo. ${label.toLowerCase()}: Corinthians ${sc.cor}, ${S.match?.opp?.name || 'adversário'} ${sc.opp}.`, { interrupt: true }), 1200);
}

function ttoast(text, kind = 'info', ms = 5500) {
  let stack = $('#timaoToasts');
  if (!stack) { stack = el('div'); stack.id = 'timaoToasts'; document.body.appendChild(stack); }
  const t = el('div', 'ttoast ' + kind);
  t.append(el('span', 'tt-ico', { goal: '⚽', red: '🟥', good: '▲', bad: '▼', var: '📺', whistle: '⏱', info: '◉' }[kind] || '◉'), el('span', null, text));
  stack.appendChild(t);
  setTimeout(() => t.classList.add('out'), ms);
  setTimeout(() => t.remove(), ms + 600);
}

// ------------------------------------------------------------
// Eventos do backend
// ------------------------------------------------------------
function onEvent(ev) {
  if (!ev || !ev.kind) return;
  const sc = scoreLine(ev);
  const placar = `${sc.corName} ${sc.cor} × ${sc.opp} ${sc.oppName}`;
  switch (ev.kind) {
    case 'goal_for': goalFor(ev); break;
    case 'goal_against': goalAgainst(ev); break;
    case 'prematch_10': prematch10(ev); break;
    case 'prematch_60':
      ttoast(`Daqui a 1 hora: Corinthians × ${ev.match?.opp?.name || S.match?.opp?.name || 'adversário'}`, 'whistle', 8000);
      chime();
      say(ev.say || `Senhor, o Corinthians entra em campo daqui a uma hora.`);
      break;
    case 'kickoff': whistle(); ttoast(`Bola rolando! ${placar}`, 'whistle'); say(ev.say || 'Bola rolando. Vai, Corinthians!'); break;
    case 'halftime': whistle(); ttoast(`Intervalo: ${placar}`, 'whistle'); say(ev.say || `Fim do primeiro tempo. ${placar.replace('×', 'a')}.`); break;
    case 'second_half': whistle(); ttoast(`Começa o 2º tempo · ${placar}`, 'whistle'); say(ev.say || 'Começa o segundo tempo.'); break;
    case 'fulltime': fulltime(ev); break;
    case 'red_for': // expulsão de jogador do Corinthians
      ttoast(`Expulsão no Timão${ev.player ? ': ' + ev.player : ''} ${ev.minute || ''}`, 'red', 7000); tone(260, 140, 0.6, 'square', 0.08);
      say(ev.say || `Cartão vermelho para o Corinthians${ev.player ? ', ' + ev.player : ''}.`); break;
    case 'red_against': // expulsão no adversário
      ttoast(`Expulsão no adversário${ev.player ? ': ' + ev.player : ''} ${ev.minute || ''}`, 'good', 7000); chime();
      say(ev.say || `Cartão vermelho para o adversário${ev.player ? ', ' + ev.player : ''}.`); break;
    case 'var': ttoast('VAR: gol anulado — ' + placar, 'var', 7000); tone(600, 300, 0.5, 'square', 0.06); say(ev.say || 'Atenção: o VAR anulou o gol.'); break;
    case 'rival_goal': {
      const r = ev.rival || {};
      ttoast(`Radar Z4: ${r.name || 'rival'} ${r.score || ''}${r.vs ? ' ' + r.vs : ''} — ${r.good ? 'bom pro Timão' : 'ruim pro Timão'}`, r.good ? 'good' : 'bad', 7000);
      if (r.good) chime();
      if (ev.say) say(ev.say);
      break;
    }
  }
}

// ------------------------------------------------------------
// Estado → painel, selo do topo, tema
// ------------------------------------------------------------
function onState(st) {
  if (!st) return;
  S = st;
  const panel = $('#timao');
  const on = st.phase && st.phase !== 'idle' && !!st.match;
  panel?.classList.toggle('timao-on', on);
  document.body.classList.toggle('timao-live', isLive(st.phase));
  if (lastPhase !== st.phase && st.phase === 'idle') fadeBack();
  lastPhase = st.phase;
  render();
  renderBadge();
}

function fadeBack() {
  const box = $('#timaoLive');
  if (!box) return;
  box.classList.add('leaving');
  setTimeout(() => box.classList.remove('leaving'), 700);
}

function liveBox() {
  let box = $('#timaoLive');
  if (!box) {
    box = el('div', 'tl-box');
    box.id = 'timaoLive';
    $('#football')?.after(box);
  }
  return box;
}

function teamBlock(t, side) {
  const b = el('div', 'tl-team ' + side);
  b.append(img(t?.logo, 'tl-logo'), el('div', 'tl-name', t?.name || '—'));
  return b;
}

function render() {
  const box = liveBox();
  box.replaceChildren();
  if (!S.match || S.phase === 'idle') return;
  const m = S.match;
  const head = $('#timaoComp');
  if (head) head.textContent = S.phase === 'pre' ? 'pré-jogo' : isLive() ? '● ao vivo' : S.phase === 'post' ? 'encerrado' : (m.leagueName || 'Brasileirão');

  if (S.phase === 'pre') return renderPre(box, m);

  // ---------- placar ----------
  const board = el('div', 'tl-board');
  const mid = el('div', 'tl-mid');
  const tag = el('div', 'tl-tag ' + (S.phase === 'post' ? 'post' : 'live'),
    S.phase === 'post' ? 'ENCERRADO' : S.phase === 'halftime' ? '● INTERVALO' : '● AO VIVO');
  const score = el('div', 'tl-score');
  score.append(el('b', 'n', String(m.cor?.score ?? 0)), el('span', 'x', '×'), el('b', 'n', String(m.opp?.score ?? 0)));
  const clock = el('div', 'tl-clock mono', S.phase === 'post' ? (m.statusDetail || 'fim de jogo') : `${m.clock || ''} ${m.statusDetail ? '· ' + m.statusDetail : ''}`.trim());
  mid.append(tag, score, clock);
  if (S.simulated) mid.appendChild(el('div', 'tl-sim mono', 'SIMULAÇÃO'));
  const home = m.isHome !== false;
  board.append(teamBlock(home ? m.cor : m.opp, 'l'), mid, teamBlock(home ? m.opp : m.cor, 'r'));
  // o placar segue a ordem mandante × visitante
  if (!home) { score.replaceChildren(el('b', 'n', String(m.opp?.score ?? 0)), el('span', 'x', '×'), el('b', 'n', String(m.cor?.score ?? 0))); }
  box.appendChild(board);

  if (S.phase === 'post') {
    const r = (m.cor?.score ?? 0) > (m.opp?.score ?? 0) ? 'V' : (m.cor?.score ?? 0) < (m.opp?.score ?? 0) ? 'D' : 'E';
    box.appendChild(el('div', 'tl-result res-' + r, { V: 'VITÓRIA DO TIMÃO', E: 'EMPATE', D: 'DERROTA' }[r]));
  }

  box.appendChild(momentum());

  const cols = el('div', 'tl-cols');
  const left = el('div', 'tl-left');
  if (S.stats) left.appendChild(statsBars(S.stats, home));
  if (S.projected) {
    const p = el('div', 'tl-proj');
    const was = S.standing;
    const arrow = was ? (S.projected.rank < was.rank ? ' ▲' : S.projected.rank > was.rank ? ' ▼' : ' =') : '';
    p.append(el('span', 'dim', S.phase === 'post' ? 'Na tabela: ' : 'Se terminasse agora: '), el('b', null, `${S.projected.rank}º · ${S.projected.points} pts${arrow}`));
    const size = S.standing?.size || 20;
    if (S.projected.rank > size - 4) p.classList.add('z4');
    left.appendChild(p);
  }
  const right = el('div', 'tl-right');
  right.appendChild(timeline());
  if (S.radar?.length) right.appendChild(radar());
  cols.append(left, right);
  box.appendChild(cols);
}

function renderPre(box, m) {
  const pre = el('div', 'tl-pre');
  const vs = el('div', 'tl-pre-vs');
  vs.append(img(m.cor?.logo, 'tl-logo'), el('span', 'x', '×'), img(m.opp?.logo, 'tl-logo'));
  const info = el('div', 'tl-pre-info');
  info.append(el('div', 'tl-kicker mono', 'AO VIVO EM'), el('div', 'tl-countdown', countdownText(msToKick())));
  info.lastChild.id = 'timaoCountdown';
  info.appendChild(el('div', 'tl-pre-opp', `${m.isHome ? 'Corinthians × ' + (m.opp?.name || '') : (m.opp?.name || '') + ' × Corinthians'}`));
  const d = m.date ? new Date(m.date) : null;
  const meta = [d && d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }), m.venue, (m.broadcasts || []).join(' / '), m.leagueName].filter(Boolean).join(' · ');
  info.appendChild(el('div', 'tl-pre-meta mono', meta));
  pre.append(vs, info);
  box.appendChild(pre);
  if (S.decisive?.is) {
    const dec = el('div', 'tl-decisive');
    dec.appendChild(el('b', null, '⚠ JOGO DECISIVO'));
    for (const r of S.decisive.reasons || []) dec.appendChild(el('span', null, r));
    box.appendChild(dec);
  }
  if (S.standing) box.appendChild(el('div', 'tl-proj', `Antes do jogo: ${S.standing.rank}º · ${S.standing.points} pts`));
  if (S.radar?.length) box.appendChild(radar());
}

// Faixa 0–90' com marcadores dos lances (gols, cartões) e a posse como “pressão”
function momentum() {
  const wrap = el('div', 'tl-momentum');
  const track = el('div', 'tl-mtrack');
  const pos = S.stats?.cor?.possession;
  if (pos != null) track.style.setProperty('--pos', `${Math.max(5, Math.min(95, +pos))}%`);
  const now = el('i', 'tl-now');
  const cur = S.phase === 'post' ? 90 : minuteNum(S.match?.clock);
  now.style.left = `${Math.min(100, (cur / 95) * 100)}%`;
  if (isLive()) track.appendChild(now);
  for (const e of S.events || []) {
    if (!['goal', 'own_goal', 'penalty_goal', 'red', 'yellow'].includes(e.type)) continue;
    const k = el('span', `tl-mk ${e.type} ${e.team || ''}`, e.type === 'red' ? '■' : e.type === 'yellow' ? '▮' : '⚽');
    k.style.left = `${Math.min(100, (minuteNum(e.minute) / 95) * 100)}%`;
    k.title = `${e.minute || ''} ${e.player || ''}`;
    track.appendChild(k);
  }
  const lbl = el('div', 'tl-mlabels mono');
  lbl.append(el('span', null, "0'"), el('span', null, pos != null ? `posse ${Math.round(pos)}% COR` : ''), el('span', null, "90'"));
  wrap.append(track, lbl);
  return wrap;
}

function statsBars(st, home) {
  const rows = [
    ['Posse', 'possession', (v) => `${Math.round(v)}%`],
    ['Finalizações', 'shots'],
    ['No alvo', 'shotsOnTarget'],
    ['Escanteios', 'corners'],
    ['Defesas', 'saves'],
    ['Amarelos', 'yellow'],
    ['Vermelhos', 'red'],
  ];
  const box = el('div', 'tl-stats');
  for (const [label, k, fmt] of rows) {
    const a = +(st.cor?.[k] ?? NaN), b = +(st.opp?.[k] ?? NaN);
    if (!Number.isFinite(a) && !Number.isFinite(b)) continue;
    const L = home ? a : b, R = home ? b : a;
    const tot = (L || 0) + (R || 0) || 1;
    const r = el('div', 'tl-stat');
    const f = fmt || ((v) => String(Number.isFinite(v) ? v : 0));
    const bl = el('div', 'bar l'); const fl = el('i'); fl.style.width = `${((L || 0) / tot) * 100}%`; bl.appendChild(fl);
    const br = el('div', 'bar r'); const fr = el('i'); fr.style.width = `${((R || 0) / tot) * 100}%`; br.appendChild(fr);
    (home ? fl : fr).classList.add('cor');
    r.append(el('b', 'v', f(L || 0)), bl, el('span', 'lbl', label), br, el('b', 'v', f(R || 0)));
    box.appendChild(r);
  }
  return box;
}

const ICON = { goal: '⚽', own_goal: '⚽', penalty_goal: '⚽', yellow: '🟨', red: '🟥', sub: '⇄', kickoff: '⏱', halftime: '⏱', second_half: '⏱', fulltime: '⏱', var: '📺' };
function timeline() {
  const ul = el('ul', 'tl-events');
  const evs = (S.events || []).slice(-14).reverse();
  if (!evs.length) ul.appendChild(el('li', 'dim', isLive() ? 'Sem lances ainda…' : '—'));
  for (const e of evs) {
    const li = el('li', `ev ${e.type} ${e.team || ''}`);
    let who = e.player || '';
    if (e.type === 'own_goal') who += ' (contra)';
    if (e.type === 'penalty_goal') who += ' (pênalti)';
    if (e.type === 'sub' && e.assist) who = `${e.player} ⇄ ${e.assist}`;
    const name = who || ({ kickoff: 'Bola rolando', halftime: 'Intervalo', second_half: '2º tempo', fulltime: 'Fim de jogo', var: 'VAR' }[e.type] || e.text || '');
    li.append(el('span', 'mn mono', e.minute || ''), el('span', 'ic', ICON[e.type] || '•'), el('span', 'who', name));
    if (e.type === 'goal' || e.type === 'penalty_goal') {
      if (e.assist && e.type === 'goal') li.appendChild(el('small', 'dim', ` ass. ${e.assist}`));
    }
    ul.appendChild(li);
  }
  return ul;
}

function radar() {
  const box = el('div', 'tl-radar');
  box.appendChild(el('div', 'tl-radar-h mono', 'RADAR DO Z4'));
  for (const r of S.radar.slice(0, 6)) {
    const row = el('div', 'rr' + (r.threat ? ' threat' : '') + (r.live ? ' live' : ''));
    row.append(el('span', 'rk mono', `${r.rank ?? ''}º`), img(r.logo, 'rl'), el('span', 'nm', r.short || r.name || ''),
      el('span', 'sc mono', r.live || r.score ? `${r.score || ''}${r.vs ? ' ' + r.vs : ''}` : '—'),
      el('span', 'ck mono', r.clock || ''),
      el('span', 'pp mono', r.projectedPoints != null ? `${r.projectedPoints} pts` : `${r.points ?? ''} pts`));
    row.title = r.threat ? 'Ameaça direta ao Timão' : '';
    box.appendChild(row);
  }
  return box;
}

function renderBadge() {
  let b = $('#timaoBadge');
  if (!b) {
    const clock = $('.topbar .clock');
    if (!clock) return;
    b = el('button', 'timao-badge');
    b.id = 'timaoBadge';
    b.title = 'Modo Timão';
    b.onclick = () => {
      const p = $('#timao');
      p?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      p?.classList.remove('flash'); void p?.offsetWidth; p?.classList.add('flash');
    };
    clock.before(b);
  }
  const m = S.match;
  const show = !!m && (S.phase === 'pre' || isLive());
  b.classList.toggle('hidden', !show);
  b.classList.toggle('pre', S.phase === 'pre');
  if (!show) return;
  b.textContent = S.phase === 'pre'
    ? `◷ COR × ${m.opp?.short || ''} em ${countdownText(msToKick())}`
    : `● ${m.cor?.short || 'COR'} ${m.cor?.score ?? 0} × ${m.opp?.score ?? 0} ${m.opp?.short || ''} ${S.phase === 'halftime' ? 'INT' : m.clock || ''}`;
}

// relógio local: contagem regressiva e selo
function startTick() {
  clearInterval(tick);
  tick = setInterval(() => {
    if (S.phase !== 'pre') return;
    const cd = $('#timaoCountdown');
    if (cd) cd.textContent = countdownText(msToKick());
    renderBadge();
    const ov = document.querySelector('#timaoOverlay [data-cd]');
    if (ov) ov.textContent = `começa em ${countdownText(msToKick())}`;
  }, 1000);
}

// ------------------------------------------------------------
// Configurações: seção "Modo Timão"
// ------------------------------------------------------------
function wireSettingsButtons() {
  const run = (fn) => () => { try { const r = fn(); r?.catch?.((e) => ttoast('Modo Timão: ' + e.message, 'bad')); } catch (e) { ttoast('Modo Timão indisponível', 'bad'); } };
  const bind = (id, fn) => { const b = document.getElementById(id); if (b) b.onclick = run(fn); };
  bind('timaoSim', () => { $('#settings')?.close?.(); return api?.simulate({ speed: 2 }); });
  bind('timaoSimStop', () => api?.stopSim());
  bind('timaoTestGoal', () => { $('#settings')?.close?.(); return api?.testGoal({}); });
  bind('timaoTestAgainst', () => { $('#settings')?.close?.(); return api?.testGoal({ against: true }); });
}

// ------------------------------------------------------------
// Voz: frase com a situação atual (comando "placar" / "como está o jogo")
// ------------------------------------------------------------
export function liveSpeech() {
  const m = S.match;
  if (!m || S.phase === 'idle') {
    const f = window.JarvisActions?.football?.();
    const n = f?.next?.[0];
    if (n) {
      const d = new Date(n.date).toLocaleString('pt-BR', { weekday: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' });
      return `O Timão não está em campo agora. O próximo jogo é contra o ${n.opponent}, ${d}.`;
    }
    return 'O Timão não está em campo agora, senhor.';
  }
  const opp = m.opp?.name || 'adversário';
  const cor = m.cor?.score ?? 0, adv = m.opp?.score ?? 0;
  if (S.phase === 'pre') {
    const min = Math.max(0, Math.round(msToKick() / 60000));
    return `Corinthians e ${opp} começa em ${min} minuto${min === 1 ? '' : 's'}${m.venue ? ', na ' + m.venue : ''}.${S.decisive?.is ? ' É jogo decisivo.' : ''}`;
  }
  const gols = (S.events || []).filter((e) => ['goal', 'penalty_goal', 'own_goal'].includes(e.type))
    .map((e) => `${e.player || 'gol'} aos ${minuteNum(e.minute)}`).join(', ');
  const placar = cor === adv ? `empate em ${cor} a ${adv} com o ${opp}` : `Corinthians ${cor}, ${opp} ${adv}`;
  if (S.phase === 'post') return `Terminou: ${placar}.${gols ? ' Gols: ' + gols + '.' : ''}`;
  const tempo = S.phase === 'halftime' ? 'No intervalo' : `Aos ${minuteNum(m.clock)} minutos`;
  return `${tempo}: ${placar}.${gols ? ' Gols: ' + gols + '.' : ''}${S.projected ? ` Se terminasse agora, o Timão ficaria em ${S.projected.rank}º.` : ''}`;
}
export function getState() { return S; }

// ------------------------------------------------------------
// Início
// ------------------------------------------------------------
let started = false;
export async function init({ cfg: c } = {}) {
  if (c) getCfg = c;
  if (started) return;
  started = true;
  window.JarvisTimao = { liveSpeech, getState };
  if (MOCK) installMock();
  api = window.jarvis?.timao || null;
  wireSettingsButtons();
  startTick();
  if (!api) return; // backend ainda não disponível → painel normal
  try { api.onState?.(onState); } catch {}
  try { api.onEvent?.(onEvent); } catch {}
  try { const st = await api.get(); if (st) onState(st); } catch {}
}

// ============================================================
// Dev: mock para ver a interface sem o backend (index.html#timao-mock)
// window.TimaoDev.pre() / live() / goal() / against() / prematch() / post() / idle()
// ============================================================
function installMock() {
  const L = (id) => `https://a.espncdn.com/i/teamlogos/soccer/500/${id}.png`;
  const base = () => ({
    id: 'mock', league: 'bra.1', leagueName: 'Brasileirão', date: new Date(Date.now() + 9 * 60000).toISOString(),
    isHome: true, venue: 'Neo Química Arena', broadcasts: ['Premiere', 'Globo'], clock: "67'", period: 2, statusDetail: '2º tempo',
    cor: { name: 'Corinthians', short: 'COR', logo: L(874), score: 1 }, opp: { name: 'Botafogo', short: 'BOT', logo: L(6086), score: 0 },
  });
  const radarRows = [
    { id: '1', name: 'Internacional', short: 'INT', logo: L(1936), rank: 16, points: 38, live: true, score: '0-1', vs: 'Bahia', clock: "61'", projectedPoints: 38, threat: true },
    { id: '2', name: 'Grêmio', short: 'GRE', logo: L(6273), rank: 18, points: 37, live: true, score: '1-1', vs: 'Bahia', clock: "60'", projectedPoints: 38, threat: true },
    { id: '3', name: 'Remo', short: 'REM', logo: null, rank: 19, points: 29, live: false, projectedPoints: 29 },
  ];
  const events = [
    { type: 'kickoff', minute: '', team: null },
    { type: 'yellow', minute: "23'", team: 'opp', player: 'Marlon Freitas' },
    { type: 'halftime', minute: "45'+3'", team: null },
    { type: 'second_half', minute: "45'", team: null },
    { type: 'goal', minute: "58'", team: 'cor', player: 'Yuri Alberto', assist: 'Garro' },
    { type: 'sub', minute: "63'", team: 'cor', player: 'Romero', assist: 'Talles Magno' },
  ];
  const states = {
    pre: () => ({ phase: 'pre', simulated: true, minutesToKickoff: 9, match: base(), decisive: { is: true, reasons: ['Briga contra o rebaixamento', 'Reta final do Brasileirão'] }, standing: { rank: 17, points: 37, size: 20 }, radar: radarRows.map((r) => ({ ...r, live: false, score: '' })), events: [] }),
    live: () => ({ phase: 'live', simulated: true, match: base(), decisive: { is: true, reasons: ['Briga contra o rebaixamento'] }, standing: { rank: 17, points: 37, size: 20 }, projected: { rank: 15, points: 40 },
      stats: { cor: { possession: 58, shots: 11, shotsOnTarget: 5, corners: 6, yellow: 1, red: 0, saves: 2 }, opp: { possession: 42, shots: 6, shotsOnTarget: 2, corners: 3, yellow: 2, red: 0, saves: 4 } },
      events, radar: radarRows }),
    post: () => ({ ...states.live(), phase: 'post', match: { ...base(), statusDetail: 'Fim de jogo', clock: "90'+5'" } }),
    idle: () => ({ phase: 'idle', match: null }),
  };
  const subs = { state: [], event: [] };
  const emitState = (s) => subs.state.forEach((f) => f(s));
  const emitEvent = (e) => subs.event.forEach((f) => f(e));
  let cur = states.live();
  window.jarvis = window.jarvis || {};
  window.jarvis.timao = {
    get: async () => cur,
    onState: (f) => subs.state.push(f),
    onEvent: (f) => subs.event.push(f),
    simulate: async () => { cur = states.pre(); emitState(cur); },
    stopSim: async () => { cur = states.idle(); emitState(cur); },
    testGoal: async ({ against } = {}) => emitEvent({ kind: against ? 'goal_against' : 'goal_for', match: base(), minute: "58'", player: against ? 'Igor Jesus' : 'Yuri Alberto', assist: against ? '' : 'Garro', score: { cor: 1, opp: against ? 1 : 0 }, simulated: true, say: against ? 'Gol do Botafogo. Igor Jesus.' : 'Gol do Corinthians! Yuri Alberto, aos 58 minutos. Corinthians 1, Botafogo 0.' }),
  };
  const set = (k) => { cur = states[k](); emitState(cur); };
  window.TimaoDev = {
    show() { document.getElementById('boot')?.classList.add('hidden'); document.getElementById('hud')?.classList.remove('hidden'); },
    pre: () => set('pre'), live: () => set('live'), post: () => set('post'), idle: () => set('idle'),
    goal: () => window.jarvis.timao.testGoal({}),
    against: () => window.jarvis.timao.testGoal({ against: true }),
    prematch: () => emitEvent({ kind: 'prematch_10', match: base(), decisive: { is: true, reasons: ['Briga contra o rebaixamento', 'Reta final do Brasileirão'] }, simulated: true }),
    fulltime: () => emitEvent({ kind: 'fulltime', match: base(), score: { cor: 2, opp: 0 }, result: 'V', simulated: true }),
    rival: () => emitEvent({ kind: 'rival_goal', rival: { name: 'Grêmio', score: '0-1', vs: 'Bahia', good: true } }),
  };
}

// No modo de pré-visualização (sem o Electron), o app.js pode falhar antes de chamar init — inicia sozinho.
if (MOCK) setTimeout(() => { init({}); window.TimaoDev?.show(); }, 300);
