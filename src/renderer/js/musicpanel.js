// Painel de música: humores, trilha do dia, playlist do dia e playlists do Spotify do Vitor.
import { MOODS, PLAYLISTS, TRACKS } from './music.js';

const $ = (s) => document.querySelector(s);
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
const clear = (n) => { while (n.firstChild) n.removeChild(n.firstChild); return n; };
const dayOfYear = () => { const n = new Date(); return Math.floor((n - new Date(n.getFullYear(), 0, 0)) / 86400000); };

const KEY = 'jarvis.musicMood';
let mood = 'all';
let seed = dayOfYear();
let J = null;

const q = (t) => `${t.artist} ${t.song}`;
const ytUrl = (t) => `https://www.youtube.com/results?search_query=${encodeURIComponent(q(t))}`;
const spWeb = (t) => `https://open.spotify.com/search/${encodeURIComponent(q(t))}`;

// Abre no app do Spotify; se falhar, cai no Spotify web
function openSpotifyUri(uri, webFallback) {
  J.open(uri).catch(() => webFallback && J.open(webFallback));
}
const openTrackSpotify = (t) => openSpotifyUri(`spotify:search:${encodeURIComponent(q(t))}`, spWeb(t));
const openPlaylist = (p) => openSpotifyUri(`spotify:playlist:${p.id}`, `https://open.spotify.com/playlist/${p.id}`);

const tracks = () => (mood === 'all' ? TRACKS : TRACKS.filter((t) => t.mood === mood));
const lists = () => (mood === 'all' ? PLAYLISTS : PLAYLISTS.filter((p) => p.moods.includes(mood)));

function renderChips() {
  const nav = clear($('#moodChips'));
  for (const m of [{ id: 'all', label: 'Tudo' }, ...MOODS]) {
    const b = el('button', m.id === mood ? 'on' : null, m.label);
    b.onclick = () => setMood(m.id);
    nav.appendChild(b);
  }
}

function renderTrack() {
  const list = tracks();
  const box = clear($('#track'));
  if (!list.length) { box.appendChild(el('p', 'dim', 'Nada neste humor ainda.')); return; }
  const t = list[seed % list.length];
  const mlabel = MOODS.find((m) => m.id === t.mood)?.label || '';
  box.append(el('span', 'band', t.artist), el('b', 'song', t.song), el('p', 'why', `“${t.why}”`));
  const btns = el('div', 'links');
  const s = el('button', 'sp', '▶ Spotify'); s.onclick = () => openTrackSpotify(t);
  const y = el('button', 'yt', 'YouTube'); y.onclick = () => J.open(ytUrl(t));
  btns.append(s, y, el('span', 'moodtag', mlabel));
  box.appendChild(btns);
}

function renderPlaylistDay() {
  const box = clear($('#playlistDay'));
  const pl = lists().length ? lists() : PLAYLISTS;
  const p = pl[(seed * 3) % pl.length];
  const info = el('div', 'pd-info');
  info.append(el('small', 'pd-tag', 'Playlist do dia'), el('b', 'pd-name', p.name), el('span', 'pd-desc', p.desc));
  const b = el('button', 'sp', '▶ Tocar'); b.onclick = () => openPlaylist(p);
  box.append(info, b);
}

function renderMore() {
  const box = clear($('#moreTracks'));
  const list = tracks();
  if (list.length < 2) return;
  box.appendChild(el('small', 'dim', 'Também vale ouvir:'));
  const used = new Set([seed % list.length]);
  for (let i = 1; used.size <= Math.min(4, list.length - 1); i++) {
    const idx = (seed * 7 + i * 11) % list.length;
    if (used.has(idx)) { if (i > 50) break; continue; }
    used.add(idx);
    const t = list[idx];
    const it = el('div', 'item');
    const label = el('span');
    label.append(el('b', null, t.artist), ` — ${t.song}`);
    label.title = t.why;
    const s = el('button', 'sp', '▶'); s.title = 'Ouvir no Spotify'; s.onclick = () => openTrackSpotify(t);
    const y = el('button', 'yt', 'YT'); y.title = 'Ver no YouTube'; y.onclick = () => J.open(ytUrl(t));
    it.append(label, s, y);
    box.appendChild(it);
  }
}

function renderPlaylists() {
  const box = clear($('#playlists'));
  for (const p of lists()) {
    const b = el('button', 'pl', p.name);
    b.title = p.desc;
    b.onclick = () => openPlaylist(p);
    box.appendChild(b);
  }
  $('#plCount').textContent = `${lists().length} playlists`;
}

function renderAll() { renderChips(); renderTrack(); renderPlaylistDay(); renderMore(); renderPlaylists(); }

function setMood(id) {
  mood = id;
  try { localStorage.setItem(KEY, id); } catch {}
  renderAll();
}

export function initMusic(api) {
  J = api;
  try { const m = localStorage.getItem(KEY); if (m && (m === 'all' || MOODS.some((x) => x.id === m))) mood = m; } catch {}
  renderAll();
  $('#btnShuffle').onclick = () => { seed = Math.floor(Math.random() * 10000); renderTrack(); renderPlaylistDay(); renderMore(); };
}
