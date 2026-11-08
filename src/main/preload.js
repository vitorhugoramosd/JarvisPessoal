const { contextBridge, ipcRenderer } = require('electron');

const call = (ch, ...a) => ipcRenderer.invoke(ch, ...a).then((r) => {
  if (!r || !r.ok) throw new Error(r?.error || 'erro');
  return r.data;
});

contextBridge.exposeInMainWorld('jarvis', {
  getConfig: () => call('config:get'),
  setConfig: (patch) => call('config:set', patch),
  news: (kind) => call('news', kind),
  football: () => call('football'),
  weather: () => call('weather'),
  quotes: () => call('quotes'),
  radio: (tag, country) => call('radio', tag, country),
  system: () => call('system'),
  games: () => call('games:summary'),
  launchGame: (id) => call('games:launch', id),
  openBladeDash: () => call('games:bladedash'),
  ask: (prompt, opts) => call('claude:ask', prompt, opts),
  resetChat: () => call('claude:reset'),
  open: (url) => call('open', url),
  win: (cmd) => call('win', cmd),
  voice: {
    cmd: (c) => call('voice:cmd', c),
    speak: (text) => call('voice:speak', text),
    available: () => call('voice:available'),
    onEvent: (cb) => ipcRenderer.on('voice:event', (_e, ev) => cb(ev)),
  },
  isAutostart: process.argv.includes('--jarvis-autostart'),
});
