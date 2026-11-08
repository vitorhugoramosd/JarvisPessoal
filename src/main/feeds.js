// Busca de dados na internet (tudo grátis, sem chave de API). Roda no processo principal (sem CORS).
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) JarvisDashboard/0.1';
const cache = new Map();

async function getText(url, ttlMs = 10 * 60 * 1000) {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < ttlMs) return hit.body;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 12000);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.text();
    cache.set(url, { at: Date.now(), body });
    return body;
  } finally {
    clearTimeout(t);
  }
}
const getJSON = async (url, ttl) => JSON.parse(await getText(url, ttl));

// ---------- RSS (parser simples, sem dependências) ----------
function decode(s = '') {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .trim();
}
function tag(xml, name) {
  const m = xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`));
  return m ? decode(m[1]) : '';
}
function parseRss(xml, limit = 12) {
  const items = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const it = m[1];
    let title = tag(it, 'title');
    let source = tag(it, 'source');
    // Google News coloca " - Fonte" no fim do título
    if (source && title.endsWith(' - ' + source)) title = title.slice(0, -(source.length + 3));
    items.push({ title, link: tag(it, 'link'), date: tag(it, 'pubDate'), source });
    if (items.length >= limit) break;
  }
  return items;
}

const GN = 'hl=pt-BR&gl=BR&ceid=BR:pt-419';
const NEWS = {
  tech: `https://news.google.com/rss/headlines/section/topic/TECHNOLOGY?${GN}`,
  geo: `https://news.google.com/rss/search?q=${encodeURIComponent('geopolítica OR "relações internacionais" OR OTAN OR ONU when:2d')}&${GN}`,
  world: `https://news.google.com/rss/headlines/section/topic/WORLD?${GN}`,
  geek: `https://news.google.com/rss/search?q=${encodeURIComponent('(Marvel OR DC OR "Star Wars" OR anime OR mangá OR Netflix OR HBO OR trailer OR nerd) -futebol -Brasileirão when:2d')}&${GN}`,
  games: `https://news.google.com/rss/search?q=${encodeURIComponent('(lançamento jogo OR PlayStation OR Xbox OR Steam OR Nintendo) when:2d')}&${GN}`,
  timao: `https://news.google.com/rss/search?q=${encodeURIComponent('Corinthians when:2d')}&${GN}`,
};

async function news(kind) {
  const url = NEWS[kind];
  if (!url) return [];
  return parseRss(await getText(url, 15 * 60 * 1000));
}

// ---------- Futebol (ESPN) ----------
function eventInfo(e, teamId) {
  const c = e.competitions?.[0] || {};
  const comp = c.competitors || [];
  const me = comp.find((x) => x.team?.id === teamId) || {};
  const op = comp.find((x) => x.team?.id !== teamId) || {};
  const score = (x) => (x.score?.displayValue ?? x.score ?? null);
  const done = c.status?.type?.completed;
  let result = null;
  if (done) {
    const a = +score(me), b = +score(op);
    result = a > b ? 'V' : a < b ? 'D' : 'E';
  }
  return {
    date: e.date,
    home: me.homeAway === 'home',
    opponent: op.team?.displayName || op.team?.name || '?',
    opponentLogo: op.team?.logos?.[0]?.href || op.team?.logo || null,
    myScore: score(me), opScore: score(op),
    venue: c.venue?.fullName || '',
    league: e.league?.name || e.seasonType?.name || '',
    done, result,
  };
}

async function football(teamId = '874', league = 'bra.1') {
  const base = `https://site.api.espn.com/apis/site/v2/sports/soccer/${league}/teams/${teamId}`;
  const [sched, fix, table] = await Promise.allSettled([
    getJSON(`${base}/schedule`, 10 * 60 * 1000),
    getJSON(`${base}/schedule?fixture=true`, 10 * 60 * 1000),
    getJSON(`https://site.api.espn.com/apis/v2/sports/soccer/${league}/standings`, 10 * 60 * 1000),
  ]);
  const out = { team: null, last: [], next: [], standing: null, table: [] };
  if (sched.status === 'fulfilled') {
    const t = sched.value.team || {};
    out.team = { name: t.displayName, logo: t.logo || `https://a.espncdn.com/i/teamlogos/soccer/500/${teamId}.png`, summary: t.standingSummary, record: t.recordSummary };
    out.last = (sched.value.events || [])
      .map((e) => eventInfo(e, teamId)).filter((e) => e.done)
      .sort((a, b) => new Date(b.date) - new Date(a.date)).slice(0, 5);
  }
  if (fix.status === 'fulfilled') {
    out.next = (fix.value.events || [])
      .map((e) => eventInfo(e, teamId)).filter((e) => !e.done)
      .sort((a, b) => new Date(a.date) - new Date(b.date)).slice(0, 3);
  }
  if (table.status === 'fulfilled') {
    const entries = table.value.children?.[0]?.standings?.entries || [];
    const stat = (en, n) => en.stats.find((s) => s.name === n)?.value;
    out.table = entries.map((en) => ({
      id: en.team.id, name: en.team.shortDisplayName || en.team.displayName,
      rank: stat(en, 'rank'), points: stat(en, 'points'), played: stat(en, 'gamesPlayed'),
      wins: stat(en, 'wins'), ties: stat(en, 'ties'), losses: stat(en, 'losses'),
      gd: stat(en, 'pointDifferential'),
    })).sort((a, b) => a.rank - b.rank);
    out.standing = out.table.find((x) => x.id === teamId) || null;
    out.size = out.table.length;
  }
  return out;
}

// ---------- Clima (Open-Meteo) + localização ----------
async function locate() {
  try {
    const j = await getJSON('https://ipwho.is/', 6 * 60 * 60 * 1000);
    if (j.success) return { name: j.city, lat: j.latitude, lon: j.longitude };
  } catch {}
  return { name: 'São Paulo', lat: -23.55, lon: -46.63 };
}

async function weather(loc) {
  loc = loc || (await locate());
  const u = `https://api.open-meteo.com/v1/forecast?latitude=${loc.lat}&longitude=${loc.lon}` +
    '&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m,is_day' +
    '&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code&timezone=auto&forecast_days=4';
  const j = await getJSON(u, 15 * 60 * 1000);
  return { place: loc.name, current: j.current, daily: j.daily };
}

// ---------- Cotações ----------
async function quotes() {
  const j = await getJSON('https://economia.awesomeapi.com.br/json/last/USD-BRL,EUR-BRL,BTC-BRL', 5 * 60 * 1000);
  return Object.values(j).map((q) => ({ code: q.code, bid: +q.bid, pct: +q.pctChange }));
}

// ---------- Rádios (radio-browser.info) ----------
async function radio(tagName = 'rock', country = '') {
  const qs = new URLSearchParams({ tag: tagName, order: 'clickcount', reverse: 'true', hidebroken: 'true', limit: '30' });
  if (country) qs.set('countrycode', country);
  const list = await getJSON(`https://de1.api.radio-browser.info/json/stations/search?${qs}`, 60 * 60 * 1000);
  const seen = new Set();
  return list
    .filter((s) => s.url_resolved && /^https:/.test(s.url_resolved) && /mp3|aac/i.test(s.codec || 'mp3'))
    .filter((s) => (seen.has(s.name.trim().toLowerCase()) ? false : seen.add(s.name.trim().toLowerCase())))
    .slice(0, 10)
    .map((s) => ({ name: s.name.trim(), url: s.url_resolved, country: s.countrycode, tags: s.tags, favicon: s.favicon, bitrate: s.bitrate }));
}

module.exports = { news, football, weather, quotes, radio, locate };
