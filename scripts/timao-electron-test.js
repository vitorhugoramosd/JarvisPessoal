// Roda o simulador do Modo Timão dentro do Electron (notificações reais desligadas: janela "focada").
//   node_modules/electron/dist/electron.exe scripts/timao-electron-test.js
const path = require('path');
const { app } = require('electron');
app.setPath('userData', path.join(app.getPath('temp'), 'jarvis-timao-test'));
const timao = require('../src/main/timao');
const fakeWin = {
  isDestroyed: () => false, isMinimized: () => false, isVisible: () => true, isFocused: () => true, flashFrame() {}, show() {},
  webContents: { send: (ch, p) => {
    if (ch === 'timao:event') console.log('EVENT', p.kind.padEnd(13), p.minute || '', p.player || '', p.score ? `${p.score.cor}x${p.score.opp}` : '', p.rival ? JSON.stringify(p.rival) : '', '|', p.say);
    if (ch === 'timao:state' && (p.phase !== last.phase || p.match?.clock === "60'")) { last = p; console.log('STATE', p.phase, p.match?.clock, p.match ? `${p.match.cor.score}x${p.match.opp.score}` : '', 'decisivo:', p.decisive.reasons.join('/'), 'proj:', JSON.stringify(p.projected), 'radar:', p.radar.map((r) => `${r.short} ${r.score || '-'} ${r.clock || ''}`).join(', '), 'stats:', p.stats ? `posse ${p.stats.cor.possession} chutes ${p.stats.cor.shots}` : '-'); }
  } },
};
let last = {};
app.whenReady().then(async () => {
  timao.init(() => fakeWin, () => ({}));
  setTimeout(async () => {
    console.log('--- estado real:', JSON.stringify({ phase: timao.getState().phase, match: timao.getState().match && `${timao.getState().match.opp.name} ${timao.getState().match.date}`, mins: timao.getState().minutesToKickoff, decisive: timao.getState().decisive }));
    console.log('--- simulação', JSON.stringify(await timao.simulate({ speed: 0.03 })));
  }, 8000);
  setTimeout(() => { console.log("--- testGoal"); timao.testGoal({}); }, 22000);
  setTimeout(() => app.quit(), 33000);
});
