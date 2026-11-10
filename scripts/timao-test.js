// Teste do Modo Timão sem Electron: replay do Corinthians 2×0 Mirassol pelo mesmo diff do ao vivo.
//   node scripts/timao-test.js
const t = require('../src/main/timao');

(async () => {
  const sum = await t.getJSON(t.urls.summary('bra.1', t.SIM_EVENT));
  const table = t.parseStandings(await t.getJSON(t.urls.standings('bra.1')));
  const frames = t.buildSimFrames(sum);
  const tracker = t.createTracker();
  let ok = 0;
  const seen = [];
  for (const [i, f] of frames.entries()) {
    const snap = t.parseSummary(f.summary, 'bra.1');
    if (i === 0) snap.decisive = t.decisiveFor(snap, table);
    for (const e of tracker.process(snap)) {
      const line = `${snap.clock.padEnd(7)} ${e.kind.padEnd(13)} ${e.player || ''}${e.assist ? ` (assist. ${e.assist})` : ''} ${e.score.cor}x${e.score.opp}${e.result ? ' ' + e.result : ''}`;
      console.log(line, '→', t.say(e.kind, { ...snap, decisive: t.decisiveFor(snap, table) }, e));
      seen.push(e.kind + (e.player ? ':' + e.player : '') + (e.result ? ':' + e.result : ''));
    }
  }
  const last = t.parseSummary(frames.at(-1).summary, 'bra.1');
  console.log('\nplacar final:', last.cor.score, 'x', last.opp.score, '| stats posse', last.stats?.cor?.possession, '% chutes', last.stats?.cor?.shots);
  console.log('decisivo:', JSON.stringify(t.decisiveFor({ ...last, opp: { name: 'Botafogo' } }, table)));
  console.log('projeção com 2x0:', JSON.stringify(t.projectTable(table, last, [])));
  console.log('prematch_10:', t.say('prematch_10', { ...last, decisive: t.decisiveFor(last, table) }));

  // jogo já em andamento ao abrir o PC: não pode disparar gols antigos
  const tr2 = t.createTracker();
  const mid = t.parseSummary(frames.find((f) => f.summary.header.competitions[0].status.displayClock === "85'").summary, 'bra.1');
  const silent = tr2.process(mid);
  console.log('abrindo no 85\' (deve ser vazio):', JSON.stringify(silent));

  const want = ['kickoff', 'red_against:Bruno Santos', 'halftime', 'second_half', 'goal_for:Matheus Bidu', 'goal_for:Kaio', 'fulltime:V'];
  for (const w of want) if (seen.includes(w)) ok++; else console.log('FALTOU:', w);
  console.log(`\n${ok}/${want.length} eventos esperados`, ok === want.length && silent.length === 0 ? 'OK' : 'FALHOU');
  process.exit(ok === want.length && silent.length === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
