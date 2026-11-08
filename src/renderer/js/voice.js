// J.A.R.V.I.S. — voz: fala (voz "Daniel" com efeito), escuta ("Jarvis…") e roteador de comandos.
// Fala com o processo principal via window.jarvis.voice; usa window.JarvisActions (exposto por app.js).
const J = window.jarvis;
const A = () => window.JarvisActions || {};
const $ = (s) => document.querySelector(s);

let getCfg = () => ({});
let helperOk = false;      // JarvisVoice.exe respondeu
let dictation = null;      // null = desconhecido; false = só comandos (ditado online desativado no Windows)
let listening = 'off';     // 'off' | 'wake' | 'once'
let fromVoice = false;     // a pergunta atual veio da voz → responder falando

// ============================================================
// Fala
// ============================================================
let ctx = null;
const queue = [];
let speaking = false;
let currentSrc = null;   // áudio tocando agora (para poder interromper)
let epoch = 0;           // muda a cada interrupção: falas antigas que chegarem depois são descartadas

function clean(text) {
  return String(text || '')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[*_`#>~|]/g, '')
    .replace(/\[(.*?)\]\(.*?\)/g, '$1')
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 600);
}

function audioCtx() {
  if (!ctx) ctx = new AudioContext();
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

function b64ToBuf(dataUrl) {
  const b64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  const bin = atob(b64);
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u.buffer;
}

// Cadeia "J.A.R.V.I.S.": passa-alta, compressor, chorus/flanger curtinho e leve abertura estéreo.
function playProcessed(buffer) {
  const ac = audioCtx();
  return new Promise((resolve) => {
    const src = ac.createBufferSource();
    src.buffer = buffer;
    const hp = ac.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 120;
    const presence = ac.createBiquadFilter(); presence.type = 'peaking'; presence.frequency.value = 3200; presence.gain.value = 3; presence.Q.value = 0.9;
    const comp = ac.createDynamicsCompressor(); comp.threshold.value = -20; comp.ratio.value = 3; comp.attack.value = 0.005; comp.release.value = 0.15;
    const out = ac.createGain(); out.gain.value = 1;
    const analyser = ac.createAnalyser(); analyser.fftSize = 512;

    // seco
    const dry = ac.createGain(); dry.gain.value = 0.82;
    // molhado: dois delays curtos (L/R) modulados por LFO → brilho metálico sutil
    const merger = ac.createChannelMerger(2);
    const mk = (time, ch) => {
      const d = ac.createDelay(0.05); d.delayTime.value = time;
      const fb = ac.createGain(); fb.gain.value = 0.28;
      const g = ac.createGain(); g.gain.value = 0.22;
      d.connect(fb); fb.connect(d);
      d.connect(g); g.connect(merger, 0, ch);
      return d;
    };
    const dl = mk(0.011, 0), dr = mk(0.017, 1);
    const lfo = ac.createOscillator(); lfo.frequency.value = 0.35;
    const lfoGain = ac.createGain(); lfoGain.gain.value = 0.0015;
    lfo.connect(lfoGain); lfoGain.connect(dl.delayTime); lfoGain.connect(dr.delayTime);

    src.connect(hp); hp.connect(presence); presence.connect(comp);
    comp.connect(dry); dry.connect(out);
    comp.connect(dl); comp.connect(dr); merger.connect(out);
    out.connect(analyser); analyser.connect(ac.destination);

    const data = new Uint8Array(analyser.fftSize);
    let raf = 0;
    const meter = () => {
      analyser.getByteTimeDomainData(data);
      let sum = 0;
      for (const v of data) { const x = (v - 128) / 128; sum += x * x; }
      const lvl = Math.min(1, Math.sqrt(sum / data.length) * 4);
      document.documentElement.style.setProperty('--voice-level', lvl.toFixed(3));
      raf = requestAnimationFrame(meter);
    };
    currentSrc = src;
    src.onended = () => {
      if (currentSrc === src) currentSrc = null;
      cancelAnimationFrame(raf);
      lfo.stop();
      document.documentElement.style.setProperty('--voice-level', '0');
      setTimeout(() => { try { out.disconnect(); merger.disconnect(); } catch {} }, 400);
      resolve();
    };
    lfo.start();
    src.start();
    meter();
  });
}

function speakBrowser(text) {
  return new Promise((resolve) => {
    if (!('speechSynthesis' in window)) return resolve();
    const go = () => {
      const vs = speechSynthesis.getVoices().filter((v) => /^pt/i.test(v.lang));
      if (!vs.length) return resolve();
      const v = vs.find((x) => /daniel|antonio/i.test(x.name)) || vs.find((x) => /BR/i.test(x.lang)) || vs[0];
      const u = new SpeechSynthesisUtterance(text);
      u.voice = v; u.lang = v.lang; u.rate = 1.02; u.pitch = 0.9;
      u.onend = u.onerror = () => resolve();
      speechSynthesis.speak(u);
    };
    if (speechSynthesis.getVoices().length) go();
    else speechSynthesis.addEventListener('voiceschanged', go, { once: true });
  });
}

async function speakOne(text) {
  const my = epoch;
  document.body.classList.add('speaking');
  try {
    if (helperOk) {
      try {
        const url = await J.voice.speak(text);
        const buf = await audioCtx().decodeAudioData(b64ToBuf(url));
        if (my !== epoch) return; // foi interrompido enquanto sintetizava
        await playProcessed(buf);
        return;
      } catch (e) { console.warn('voz Daniel falhou, usando a do navegador:', e.message); }
    }
    await speakBrowser(text);
  } finally {
    document.body.classList.remove('speaking');
  }
}

// Fala (em fila). Resolve quando terminar de falar este texto.
export function speak(text) {
  const t = clean(text);
  if (!t) return Promise.resolve();
  return new Promise((resolve) => {
    queue.push({ t, resolve });
    pump();
  });
}
async function pump() {
  if (speaking) return;
  speaking = true;
  while (queue.length) {
    const { t, resolve } = queue.shift();
    try { await speakOne(t); } catch {}
    resolve();
  }
  speaking = false;
}
export function isSpeaking() { return speaking; }

// Cala o Jarvis na hora: para o áudio atual e descarta o que estava na fila.
export function stopSpeaking() {
  epoch++;
  while (queue.length) queue.shift().resolve();
  try { currentSrc?.stop(); } catch {}
  currentSrc = null;
  try { if ('speechSynthesis' in window) speechSynthesis.cancel(); } catch {}
  document.body.classList.remove('speaking');
  document.documentElement.style.setProperty('--voice-level', '0');
}
export function speechEpoch() { return epoch; }

// Bipe curto de "pronto para ouvir"
export function chirp() {
  try {
    const ac = audioCtx();
    const o = ac.createOscillator(), g = ac.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(880, ac.currentTime);
    o.frequency.exponentialRampToValueAtTime(1560, ac.currentTime + 0.12);
    g.gain.setValueAtTime(0.0001, ac.currentTime);
    g.gain.exponentialRampToValueAtTime(0.18, ac.currentTime + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + 0.22);
    o.connect(g); g.connect(ac.destination);
    o.start(); o.stop(ac.currentTime + 0.25);
  } catch {}
}

// ============================================================
// Interface: status, botão do microfone, legenda
// ============================================================
function setStatus() {
  const pill = $('#voiceStatus');
  const mic = $('#btnMic');
  if (!pill) return;
  let txt, cls;
  if (!helperOk) { txt = 'voz offline'; cls = 'off'; }
  else if (listening === 'once') { txt = 'ouvindo…'; cls = 'live'; }
  else if (listening === 'wake') { txt = 'diga “Jarvis”'; cls = 'wake'; }
  else { txt = 'voz pronta'; cls = 'idle'; }
  pill.textContent = txt;
  pill.className = 'voice-status ' + cls;
  pill.title = dictation === false
    ? 'Só comandos fixos. Para perguntas livres por voz, ative “Reconhecimento de fala online” em Configurações do Windows › Privacidade › Fala.'
    : 'Ctrl+Alt+Espaço para falar';
  if (mic) mic.classList.toggle('on', listening === 'once');
}

let toastTimer = 0;
export function toast(text, kind = 'heard') {
  let t = $('#voiceToast');
  if (!t) { t = document.createElement('div'); t.id = 'voiceToast'; document.body.appendChild(t); }
  t.className = 'show ' + kind;
  t.textContent = text;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = ''), 4500);
}

export function listenOnce() {
  if (!helperOk) { toast('Voz indisponível — o ajudante JarvisVoice não está rodando.', 'err'); return; }
  const wasSpeaking = speaking || !!currentSrc;
  stopSpeaking();
  if (listening === 'once') return;
  listening = 'once'; setStatus();
  chirp();
  // pequena pausa para o fim da fala/bipe não ser captado pelo microfone
  setTimeout(() => J.voice.cmd('once').catch(() => {}), wasSpeaking ? 250 : 120);
}

export function setWake(on) {
  if (!helperOk) return;
  J.voice.cmd(on ? 'wake' : 'stop').catch(() => {});
}

// ============================================================
// Roteador de comandos
// ============================================================
const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[.,!?;:]/g, ' ').replace(/\s+/g, ' ').trim();
const stripWake = (s) => s.replace(/^(ei |ola |oi |e ai |fala )?jarvis( acorda)?\b\s*/, '').trim();

const NEWS_KEYS = [
  [/tecnolog/, 'tech', 'tecnologia'], [/geopolit/, 'geo', 'geopolítica'], [/mundo|internaciona/, 'world', 'mundo'],
  [/geek|nerd/, 'geek', 'mundo geek'], [/games?|jogos/, 'games', 'games'], [/tima|corinth/, 'timao', 'Timão'],
];

const ordinal = (n) => `${n}º`;
function footballSpeech() {
  const f = A().football?.();
  if (!f || !f.standing) return 'Ainda estou sem os dados do Timão, senhor.';
  const s = f.standing;
  const size = f.size || 20;
  let txt = `O Corinthians está em ${ordinal(s.rank)} lugar, com ${s.points} pontos em ${s.played} jogos: ${s.wins} vitórias, ${s.ties} empates e ${s.losses} derrotas.`;
  if (s.rank >= size - 3) {
    const out = (f.table || []).find((t) => t.rank === size - 4);
    txt += out ? ` Estamos na zona de rebaixamento, a ${Math.max(0, out.points - s.points + 1)} ponto${out.points - s.points + 1 === 1 ? '' : 's'} de sair.` : ' Estamos na zona de rebaixamento.';
  }
  const n = f.next?.[0];
  if (n) {
    const d = new Date(n.date);
    const quando = d.toLocaleString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
    txt += ` O próximo jogo é contra o ${n.opponent}, ${n.home ? 'em casa' : 'fora'}, ${quando}.`;
  }
  return txt;
}
function weatherSpeech() {
  const w = A().weather?.();
  if (!w?.current) return 'Ainda não tenho a previsão do tempo, senhor.';
  const c = w.current;
  const desc = document.querySelector('.w-now .desc')?.textContent || '';
  let txt = `Em ${w.place}, agora faz ${Math.round(c.temperature_2m)} graus${desc ? ', ' + desc.toLowerCase() : ''}, sensação de ${Math.round(c.apparent_temperature)}.`;
  const d = w.daily;
  if (d?.temperature_2m_max) {
    txt += ` Hoje a máxima é ${Math.round(d.temperature_2m_max[0])} e a mínima ${Math.round(d.temperature_2m_min[0])}, com ${d.precipitation_probability_max?.[0] ?? 0} por cento de chance de chuva.`;
  }
  return txt;
}

async function newsSpeech(k, label) {
  A().showNews?.(k);
  let items = [];
  try { items = (await A().getNews?.(k)) || []; } catch {}
  if (!items.length) return `Não consegui carregar as notícias de ${label} agora.`;
  return `Principais manchetes de ${label}: ` + items.slice(0, 3).map((n, i) => `${i + 1}. ${n.title}.`).join(' ');
}

const THANKS = [
  'Sempre às ordens, senhor. É para isso que existo… além de julgar silenciosamente suas playlists.',
  'Disponha. Vou fingir que foi fácil.',
  'Por nada, senhor. Mais alguma coisa antes que eu volte a monitorar a tabela do Brasileirão com ansiedade?',
];

// Executa um comando falado. Retorna true se tratou localmente.
export async function handle(textRaw) {
  const t = stripWake(norm(textRaw));
  const act = A();
  const say = (s) => speak(s);
  if (!t) return false;

  if (/(abr\w* (o )?blade|vamos jogar|quero jogar|modo jogo|hora de jogar)/.test(t)) {
    say('Abrindo o Blade Dash. Bom jogo, senhor.');
    act.choosePlay ? act.choosePlay() : act.openBladeDash?.();
    return true;
  }
  if (/continua\w* (o )?(ultimo )?jogo/.test(t)) {
    const name = await act.continueLast?.();
    say(name ? `Retomando ${name}.` : 'Não encontrei um jogo recente, senhor.');
    return true;
  }
  if (/(para|parar|pausa|pausar|desliga|desligar)( a)? (musica|radio|som)/.test(t)) {
    act.stopRadio?.();
    say('Silêncio restaurado.');
    return true;
  }
  const rad = t.match(/(toca|tocar|toque|liga|ligar|bota|coloca|poe)( (a|um|uma))? ?(radio|musica|som)?( de)? ?(rock|emo|punk|metal|pagode|sertanejo|alternativ\w*)?/);
  if (rad && (rad[4] || rad[6]) && /^(toca|tocar|toque|liga|ligar|bota|coloca|poe)/.test(t)) {
    const tag = (rad[6] || 'rock').replace(/^alternativ\w*/, 'alternative');
    const name = await act.playRadio?.(tag);
    say(name ? `Tocando ${name}.` : `Não achei uma rádio de ${tag} no ar agora.`);
    return true;
  }
  if (/noticia|manchete/.test(t)) {
    const hit = NEWS_KEYS.find(([re]) => re.test(t)) || [null, 'tech', 'tecnologia'];
    say(await newsSpeech(hit[1], hit[2]));
    return true;
  }
  if (/corinth|timao|tabela|brasileirao/.test(t)) { act.enter?.(); say(footballSpeech()); return true; }
  if (/(previsao|tempo|clima|vai chover|temperatura)/.test(t) && t.split(' ').length <= 6) { say(weatherSpeech()); return true; }
  if (/(trilha|sugere|sugestao|recomenda)\w*( uma)? ?(musica|som)?/.test(t) && /musica|trilha|som/.test(t)) {
    const tr = act.track?.();
    say(tr?.band ? `Sugestão do dia: ${tr.song}, de ${tr.band}.` : 'Hoje fico devendo a sugestão, senhor.');
    return true;
  }
  if (/briefing|resumo do dia/.test(t)) {
    say('Um momento, vou montar o briefing.');
    const txt = await act.briefing?.();
    if (txt) say(txt);
    return true;
  }
  if (/minimiz|esconde/.test(t)) { say('Estarei por aqui.'); setTimeout(() => act.minimize?.(), 900); return true; }
  if (/^(obrigad|valeu|brigad)/.test(t)) { say(THANKS[Math.floor(Math.random() * THANKS.length)]); return true; }
  return false;
}

// Pergunta livre → Claude (aparece no chat) e a resposta é falada.
async function askClaude(text) {
  if (!A().ask) return;
  fromVoice = true;
  const my = epoch;
  try {
    const answer = await A().ask(text);
    if (answer && my === epoch) await speak(answer);
  } catch (e) {
    speak('Não consegui falar com o Claude agora.');
  } finally { fromVoice = false; }
}

export function cameFromVoice() { return fromVoice; }

// ============================================================
// Eventos do ajudante
// ============================================================
let wakeBusy = false;
async function onEvent(ev) {
  switch (ev.type) {
    case 'ready':
      helperOk = true;
      if (getCfg().voiceCommands !== false) setWake(true);
      break;
    case 'unavailable':
      helperOk = false;
      console.warn('[voz]', ev.message);
      break;
    case 'state':
      listening = ev.listening;
      break;
    case 'mode':
      if (dictation !== false && !ev.dictation) toast('Ditado livre desativado no Windows — entendo só os comandos.', 'info');
      dictation = !!ev.dictation;
      break;
    case 'ptt':
      listenOnce();
      break;
    case 'wake': {
      if (wakeBusy || isSpeaking()) break;
      wakeBusy = true;
      try {
        toast(`“${ev.text}”`);
        const rest = stripWake(norm(ev.text));
        if (rest) { await handle(rest); }
        else {
          chirp();
          await speak('Pois não?');
          listenOnce();
        }
      } finally { wakeBusy = false; }
      break;
    }
    case 'heard': {
      if (ev.dictation === false) dictation = false;
      if (!ev.text) { toast(ev.confidence === 'Timeout' ? 'Não ouvi nenhum comando.' : 'Não entendi, senhor.', 'err'); break; }
      toast(`“${ev.text}”`);
      // só “Jarvis” → responde e ouve o comando
      if (!stripWake(norm(ev.text))) { chirp(); await speak('Pois não?'); listenOnce(); break; }
      const done = await handle(ev.text);
      if (!done) {
        if (dictation === false) speak('Por enquanto só entendo comandos, senhor. Para conversar por voz, ative o reconhecimento de fala online do Windows.');
        else askClaude(ev.text);
      }
      break;
    }
    case 'error':
      console.warn('[voz]', ev.message);
      break;
  }
  setStatus();
}

export async function init({ cfg }) {
  getCfg = cfg;
  J.voice.onEvent(onEvent);
  try { helperOk = await J.voice.available(); } catch { helperOk = false; }
  // o ajudante já foi iniciado pelo processo principal; se o "ready" já passou, liga a escuta mesmo assim
  if (helperOk && getCfg().voiceCommands !== false) setTimeout(() => listening === 'off' && setWake(true), 1500);
  const mic = $('#btnMic');
  if (mic) mic.onclick = () => listenOnce();
  setStatus();
}
