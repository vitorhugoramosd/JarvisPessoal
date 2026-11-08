// J.A.R.V.I.S. — processo principal do Electron
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const { app, BrowserWindow, ipcMain, shell, globalShortcut } = require('electron');

const config = require('./config');
const feeds = require('./feeds');
const games = require('./games');
const claude = require('./claude');
const voice = require('./voice');

const APP_DIR = path.resolve(__dirname, '..', '..');
const RUN_VALUE = 'Jarvis';
let win = null;

// ---------- Início automático (HKCU\...\Run) ----------
function autostartCommand() {
  // Caminhos com espaço e acento ("Área de Trabalho"): cada parte entre aspas.
  return `"${process.execPath}" "${APP_DIR}" --autostart`;
}
function setAutostart(on) {
  return new Promise((resolve) => {
    const args = on
      ? ['add', games.RUN_KEY, '/v', RUN_VALUE, '/t', 'REG_SZ', '/d', autostartCommand(), '/f']
      : ['delete', games.RUN_KEY, '/v', RUN_VALUE, '/f'];
    execFile('reg', args, { windowsHide: true }, (err) => resolve(!err));
  });
}
function getAutostart() {
  return new Promise((resolve) => {
    execFile('reg', ['query', games.RUN_KEY, '/v', RUN_VALUE], { windowsHide: true }, (err) => resolve(!err));
  });
}

// ---------- Linha de comando utilitária ----------
if (process.argv.includes('--install-autostart') || process.argv.includes('--remove-autostart')) {
  const on = process.argv.includes('--install-autostart');
  app.whenReady().then(async () => {
    const ok = await setAutostart(on);
    if (on) { try { games.disableBladeDashAutostart(); } catch {} }
    console.log(on ? 'Início automático do Jarvis: LIGADO' : 'Início automático do Jarvis: DESLIGADO', ok ? '(ok)' : '(falhou)');
    app.quit();
  });
} else {
  start();
}

function start() {
  // No teste automático usa outra pasta de dados, para rodar mesmo com o Jarvis já aberto.
  if (process.env.JARVIS_SMOKE) app.setPath('userData', path.join(process.env.JARVIS_SMOKE, 'userdata'));
  if (!app.requestSingleInstanceLock()) { app.quit(); return; }
  app.on('second-instance', () => showWindow());

  app.whenReady().then(() => {
    createWindow();
    voice.init(() => win);
    globalShortcut.register('Control+Alt+J', () => {
      if (win && win.isVisible() && win.isFocused() && !win.isMinimized()) win.minimize();
      else showWindow();
    });
    // Aperte para falar com o Jarvis (de qualquer lugar)
    globalShortcut.register('Control+Alt+Space', () => { showWindow(); voice.send({ type: 'ptt' }); });
    // Garante que só o Jarvis abre no início do Windows (o Blade Dash abre pelo botão "Jogar").
    if (process.argv.includes('--autostart')) { try { games.disableBladeDashAutostart(); } catch {} }
  });
  app.on('will-quit', () => { globalShortcut.unregisterAll(); voice.stop(); });
  app.on('window-all-closed', () => app.quit());
}

function showWindow() {
  if (!win) return createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function createWindow() {
  const cfg = config.load();
  win = new BrowserWindow({
    width: 1600, height: 900, minWidth: 1100, minHeight: 700,
    frame: false, show: false, backgroundColor: '#02070d',
    fullscreen: !!cfg.fullscreen, title: 'J.A.R.V.I.S.',
    icon: path.join(APP_DIR, 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false,
      additionalArguments: process.argv.includes('--autostart') ? ['--jarvis-autostart'] : [],
    },
  });
  win.removeMenu();
  win.loadFile(path.join(APP_DIR, 'src', 'renderer', 'index.html'));
  win.once('ready-to-show', () => { if (!cfg.fullscreen) win.maximize(); win.show(); });
  win.on('closed', () => (win = null));
  // Links externos vão para o navegador padrão
  win.webContents.setWindowOpenHandler(({ url }) => { openSafe(url); return { action: 'deny' }; });
  if (process.env.JARVIS_SMOKE) smokeTest(process.env.JARVIS_SMOKE);
}

// Teste automático: JARVIS_SMOKE=<pasta> npm start → salva prints + erros do console e fecha.
function smokeTest(dir) {
  const fs = require('fs');
  fs.mkdirSync(dir, { recursive: true });
  const logs = [];
  win.webContents.on('console-message', (_e, level, msg, line, src) => logs.push(`[${level}] ${msg} (${src}:${line})`));
  const shot = (name) => win.webContents.capturePage().then((img) => fs.writeFileSync(path.join(dir, name), img.toPNG()));
  const js = (code) => win.webContents.executeJavaScript(code, true).catch((e) => logs.push('[exec] ' + e.message));
  setTimeout(() => shot('1-boot.png'), 3500);
  setTimeout(() => js("document.getElementById('btnOther')?.click() || document.getElementById('bootSkip')?.click()"), 4500);
  setTimeout(() => shot('2-hud.png'), 14000);
  setTimeout(async () => {
    await js("document.querySelector('#newsTabs [data-k=geek]')?.click()");
    await js("import('./js/voice.js').then(m => m.speak('Teste de voz do Jarvis.')).then(() => console.log('voice-smoke: fala ok'))");
    await js("const i=document.getElementById('chatInput'); i.value='Em uma frase: quem é o maior ídolo da história do Corinthians?'; document.getElementById('chatForm').requestSubmit()");
  }, 15000);
  setTimeout(async () => {
    await shot('3-hud-later.png');
    fs.writeFileSync(path.join(dir, 'console.txt'), logs.join('\n'));
    app.quit();
  }, 40000);
}

function openSafe(url) {
  if (/^(https?:|spotify:)/i.test(url)) shell.openExternal(url);
}

// ---------- Estatísticas do sistema ----------
let lastCpu = os.cpus();
function cpuPercent() {
  const now = os.cpus();
  let idle = 0, total = 0;
  now.forEach((c, i) => {
    const p = lastCpu[i]?.times || c.times;
    const d = Object.keys(c.times).reduce((s, k) => s + (c.times[k] - p[k]), 0);
    total += d; idle += c.times.idle - p.idle;
  });
  lastCpu = now;
  return total ? Math.round(100 * (1 - idle / total)) : 0;
}
let diskCache = { at: 0, list: [] };
function disks() {
  if (Date.now() - diskCache.at < 60000) return Promise.resolve(diskCache.list);
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-Command',
      'Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" | Select-Object DeviceID,Size,FreeSpace | ConvertTo-Json -Compress'],
    { windowsHide: true, timeout: 8000 }, (err, out) => {
      try {
        let j = JSON.parse(out); if (!Array.isArray(j)) j = [j];
        diskCache = { at: Date.now(), list: j.map((d) => ({ id: d.DeviceID, size: d.Size, free: d.FreeSpace })) };
      } catch {}
      resolve(diskCache.list);
    });
  });
}

// ---------- IPC ----------
const safe = (fn) => async (_e, ...a) => {
  try { return { ok: true, data: await fn(...a) }; }
  catch (e) { return { ok: false, error: e.message || String(e) }; }
};

ipcMain.handle('config:get', safe(async () => ({ ...config.load(), autostart: await getAutostart() })));
ipcMain.handle('config:set', safe(async (patch) => {
  if ('autostart' in patch) { await setAutostart(!!patch.autostart); delete patch.autostart; }
  if ('fullscreen' in patch && win) win.setFullScreen(!!patch.fullscreen);
  return { ...config.save(patch), autostart: await getAutostart() };
}));

ipcMain.handle('news', safe((kind) => feeds.news(kind)));
ipcMain.handle('football', safe(() => { const c = config.load(); return feeds.football(c.teamId, c.league); }));
ipcMain.handle('weather', safe(() => feeds.weather(config.load().location)));
ipcMain.handle('quotes', safe(() => feeds.quotes()));
ipcMain.handle('radio', safe((t, c) => feeds.radio(t, c)));

ipcMain.handle('system', safe(async () => ({
  cpu: cpuPercent(), cpuModel: os.cpus()[0]?.model?.trim(), cores: os.cpus().length,
  memTotal: os.totalmem(), memFree: os.freemem(), uptime: os.uptime(),
  host: os.hostname(), user: os.userInfo().username, platform: `${os.type()} ${os.release()}`,
  disks: await disks(),
})));

ipcMain.handle('games:summary', safe(() => games.summary()));
ipcMain.handle('games:launch', safe((id) => { games.launchGame(id); setTimeout(() => win?.minimize(), 800); return true; }));
ipcMain.handle('games:bladedash', safe(() => { games.openBladeDash(config.load().bladeDashDir); setTimeout(() => win?.minimize(), 1200); return true; }));

ipcMain.handle('claude:ask', safe((prompt, opts) => claude.ask(prompt, config.load(), opts || {})));
ipcMain.handle('claude:reset', safe(() => claude.reset()));

ipcMain.handle('open', safe((url) => openSafe(url)));
ipcMain.handle('win', safe((cmd) => {
  if (!win) return;
  if (cmd === 'minimize') win.minimize();
  if (cmd === 'close') win.close();
  if (cmd === 'fullscreen') win.setFullScreen(!win.isFullScreen());
}));
