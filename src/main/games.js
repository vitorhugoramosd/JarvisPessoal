// Integração com o Blade Dash: abrir o launcher, ler a biblioteca e lançar o último jogo.
const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');
const { shell } = require('electron');

const BD_DATA = path.join(process.env.APPDATA || '', 'blade-dash');
const LIB = path.join(BD_DATA, 'library.json');
const COVERS = path.join(BD_DATA, 'covers');
const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';

function readLib() {
  try { return JSON.parse(fs.readFileSync(LIB, 'utf8')); } catch { return null; }
}

function dataUrl(file) {
  try {
    const ext = path.extname(file).slice(1).toLowerCase() || 'jpg';
    return `data:image/${ext === 'jpg' ? 'jpeg' : ext};base64,${fs.readFileSync(file).toString('base64')}`;
  } catch { return null; }
}

function coverFor(game, lib, kind) {
  const o = lib.overrides?.[game.id] || {};
  if (kind === 'cover' && o.customCover && fs.existsSync(o.customCover)) return dataUrl(o.customCover);
  const [src, ...rest] = game.id.split(':');
  const native = rest.join(':');
  const suffix = kind === 'hero' ? '_hero' : '';
  for (const base of [`${src}_${native}`, `${src}_${native.replace(/[^A-Za-z0-9-]/g, '_')}`]) {
    const local = dataUrl(path.join(COVERS, `${base}${suffix}.jpg`));
    if (local) return local;
  }
  if (src === 'steam') {
    return `https://cdn.cloudflare.steamstatic.com/steam/apps/${native}/${kind === 'hero' ? 'library_hero.jpg' : 'library_600x900.jpg'}`;
  }
  return null;
}

function allGames(lib) {
  const custom = (lib.custom || []).map((c) => ({
    id: c.id, source: 'custom', name: c.name,
    launch: { type: 'exe', target: c.exePath, args: c.args || '' },
    lastPlayed: 0, playtimeMinutes: 0,
  }));
  return [...(lib.cache || []), ...custom]
    .filter((g) => !(lib.overrides?.[g.id]?.hidden))
    .map((g) => {
      const st = lib.stats?.[g.id] || {};
      return {
        ...g,
        name: lib.overrides?.[g.id]?.customName || g.name,
        favorite: !!lib.overrides?.[g.id]?.favorite,
        lastPlayed: Math.max(g.lastPlayed || 0, st.lastPlayed || 0),
        playtimeMinutes: Math.max(g.playtimeMinutes || 0, st.playtimeMinutes || 0),
      };
    });
}

function summary() {
  const lib = readLib();
  if (!lib) return { available: false };
  const games = allGames(lib);
  const byLast = [...games].sort((a, b) => b.lastPlayed - a.lastPlayed);
  const last = byLast[0] && byLast[0].lastPlayed ? byLast[0] : null;
  const top = [...games].sort((a, b) => b.playtimeMinutes - a.playtimeMinutes).slice(0, 4);
  const pack = (g) => g && ({
    id: g.id, name: g.name, source: g.source, lastPlayed: g.lastPlayed, playtimeMinutes: g.playtimeMinutes,
    cover: coverFor(g, lib, 'cover'),
  });
  return {
    available: true,
    total: games.length,
    last: last ? { ...pack(last), hero: coverFor(last, lib, 'hero') } : null,
    recent: byLast.filter((g) => g.lastPlayed).slice(1, 4).map(pack),
    top: top.map((g) => ({ name: g.name, playtimeMinutes: g.playtimeMinutes })),
    bySource: games.reduce((m, g) => ((m[g.source] = (m[g.source] || 0) + 1), m), {}),
  };
}

function launchGame(id) {
  const lib = readLib();
  const g = lib && allGames(lib).find((x) => x.id === id);
  if (!g) throw new Error('Jogo não encontrado na biblioteca do Blade Dash');
  const { type, target, args } = g.launch || {};
  if (type === 'uri') return shell.openExternal(target);
  if (type === 'appx') return spawn('explorer.exe', [target], { detached: true, stdio: 'ignore' }).unref();
  if (type === 'exe') {
    const a = args ? args.split(' ').filter(Boolean) : [];
    if (/\.(lnk|url|bat)$/i.test(target)) return shell.openPath(target);
    return spawn(target, a, { cwd: path.dirname(target), detached: true, stdio: 'ignore' }).unref();
  }
  throw new Error('Tipo de lançamento desconhecido: ' + type);
}

// O Jarvis é quem abre no início agora — garante que o Blade Dash não abra sozinho junto.
function disableBladeDashAutostart() {
  execFile('reg', ['delete', RUN_KEY, '/v', 'Blade Dash', '/f'], { windowsHide: true }, () => {});
  const lib = readLib();
  if (lib && lib.settings && lib.settings.autostart !== false) {
    lib.settings.autostart = false;
    const tmp = LIB + '.jarvis.tmp';
    fs.writeFileSync(tmp, JSON.stringify(lib, null, 2), 'utf8');
    fs.renameSync(tmp, LIB);
  }
}

function openBladeDash(dir) {
  const exe = path.join(dir, 'node_modules', 'electron', 'dist', 'electron.exe');
  if (!fs.existsSync(exe)) throw new Error('Blade Dash não encontrado em ' + dir);
  try { disableBladeDashAutostart(); } catch {}
  spawn(exe, [dir], { detached: true, stdio: 'ignore', cwd: dir }).unref();
}

module.exports = { summary, launchGame, openBladeDash, disableBladeDashAutostart, RUN_KEY };
