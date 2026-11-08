// Gerencia o ajudante de voz (voice/bin/JarvisVoice.exe): fala com a voz "Daniel" e reconhece comandos.
// Se o .exe não existir (ainda não compilado: npm run build:voice), a interface cai para a voz do navegador.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { ipcMain, app } = require('electron');

const EXE = path.resolve(__dirname, '..', '..', 'voice', 'bin', 'JarvisVoice.exe');
let child = null;
let getWin = () => null;
let restarts = 0;
let wantWake = false;
let quitting = false;
let buf = '';
let seq = 0;
const pendingSpeak = new Map(); // id → { resolve, reject, timer }

function send(ev) {
  const w = getWin();
  if (w && !w.isDestroyed()) w.webContents.send('voice:event', ev);
}

function write(obj) {
  if (!child || !child.stdin.writable) return false;
  child.stdin.write(JSON.stringify(obj) + '\n');
  return true;
}

// Log de diagnóstico: %APPDATA%\jarvis\voice.log (só eventos de voz, sem áudio)
function log(msg) {
  try {
    const file = path.join(app.getPath('userData'), 'voice.log');
    try { if (fs.statSync(file).size > 512 * 1024) fs.renameSync(file, file + '.old'); } catch {}
    fs.appendFileSync(file, `${new Date().toISOString()} ${msg}\n`);
  } catch {}
}

function onLine(line) {
  let ev;
  try { ev = JSON.parse(line); } catch { log('[stdout] ' + line); return; }
  if (ev.type !== 'spoken') log(line);
  if (ev.type === 'debug') return;
  if (ev.type === 'spoken' || (ev.type === 'error' && ev.id)) {
    const p = pendingSpeak.get(ev.id);
    if (p) {
      pendingSpeak.delete(ev.id);
      clearTimeout(p.timer);
      if (ev.type === 'error') return p.reject(new Error(ev.message));
      try {
        const data = fs.readFileSync(ev.file);
        fs.unlink(ev.file, () => {});
        p.resolve('data:audio/wav;base64,' + data.toString('base64'));
      } catch (e) { p.reject(e); }
    }
    return;
  }
  if (ev.type === 'ready') restarts = 0;
  send(ev);
}

function start() {
  if (child || quitting) return;
  if (!fs.existsSync(EXE)) { send({ type: 'unavailable', message: 'JarvisVoice.exe não encontrado (rode npm run build:voice)' }); return; }
  child = spawn(EXE, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (l) onLine(l); }
  });
  child.stderr.on('data', (d) => { console.warn('[voice]', String(d).trim()); log('[stderr] ' + String(d).trim()); });
  child.on('error', (e) => send({ type: 'error', message: e.message }));
  child.on('exit', (code) => {
    child = null; buf = '';
    for (const [, p] of pendingSpeak) { clearTimeout(p.timer); p.reject(new Error('ajudante de voz parou')); }
    pendingSpeak.clear();
    if (quitting) return;
    send({ type: 'state', listening: 'off' });
    if (restarts < 3) {
      const delay = 1000 * 2 ** restarts++;
      setTimeout(() => { start(); if (wantWake) write({ cmd: 'wake' }); }, delay);
    } else {
      send({ type: 'unavailable', message: `ajudante de voz caiu (código ${code})` });
    }
  });
}

function init(winGetter) {
  getWin = winGetter;
  ipcMain.handle('voice:cmd', (_e, cmd) => {
    if (!['wake', 'once', 'stop'].includes(cmd)) return { ok: false, error: 'comando inválido' };
    if (cmd === 'wake') wantWake = true;
    if (cmd === 'stop') wantWake = false;
    start();
    log('[cmd] ' + cmd);
    return { ok: write({ cmd }), data: !!child };
  });
  ipcMain.handle('voice:speak', async (_e, text) => {
    try {
      start();
      if (!child) throw new Error('voz indisponível');
      const id = 's' + Date.now() + '_' + seq++;
      const url = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pendingSpeak.delete(id); reject(new Error('tempo esgotado ao sintetizar')); }, 20000);
        pendingSpeak.set(id, { resolve, reject, timer });
        write({ cmd: 'speak', id, text: String(text).slice(0, 1200) });
      });
      return { ok: true, data: url };
    } catch (e) { return { ok: false, error: e.message }; }
  });
  ipcMain.handle('voice:available', () => ({ ok: true, data: fs.existsSync(EXE) }));
  start();
}

function stop() {
  quitting = true;
  if (child) { try { write({ cmd: 'quit' }); child.kill(); } catch {} child = null; }
}

module.exports = { init, stop, send };
