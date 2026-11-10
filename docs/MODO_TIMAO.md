# Modo Timão — contrato entre o processo principal e a interface

Acompanha os jogos do Corinthians ao vivo (ESPN, sem chave). O backend (`src/main/timao.js`) consulta,
detecta lances e manda eventos; a interface (`src/renderer/js/timao.js` + `css/timao.css`) mostra placar,
animações, sirene e voz.

## Fontes (ESPN)
- Próximos jogos: `site/v2/sports/soccer/{liga}/teams/874/schedule?fixture=true` (ligas em `config.timaoLeagues`, padrão `["bra.1"]`).
- Placar/relógio da rodada: `site/v2/sports/soccer/{liga}/scoreboard` (todos os jogos — usado no radar do Z4).
- Lances/estatísticas: `site/v2/sports/soccer/{liga}/summary?event={id}` → `header.competitions[0]` (status, placar),
  `keyEvents[]` (`type.text`: Kickoff, Goal, Goal - Header, Penalty - Scored, Own Goal, Yellow Card, Red Card, Substitution,
  Halftime, Start 2nd Half, End Regular Time…; `clock.displayValue` "58'"; `team.displayName`; `participants[].athlete.displayName`
  [autor, assistência]; `scoringPlay`), `boxscore.teams[].statistics[]` (possessionPct, totalShots, shotsOnTarget, wonCorners,
  yellowCards, redCards, foulsCommitted, saves).

## Ritmo das consultas
| Fase | Quando | Consulta |
|---|---|---|
| `idle` | sem jogo nas próximas 70 min | agenda a cada 10 min |
| `pre` | ≤ 70 min do início | scoreboard a cada 60 s |
| `live` / `halftime` | jogo rolando | scoreboard 15 s + summary 20 s |
| `post` | até 2 h após o fim | summary a cada 5 min, depois `idle` |

## IPC
Interface → principal (`ipcRenderer.invoke`, via `window.jarvis.timao.*`):
- `timao:get` → estado atual (`TimaoState`).
- `timao:simulate` `{ speed? }` → replay acelerado de um jogo já terminado (padrão: Corinthians 2×0 Mirassol, evento `401841295`),
  começando com o alerta de “faltam 10 min”. 1 minuto de jogo ≈ 2 s (`speed` = segundos por minuto). `simulated: true` no estado.
- `timao:stopSim`.
- `timao:testGoal` `{ against? }` → dispara só um evento de gol (para testar a animação/sirene).

Principal → interface (`webContents.send`, via `window.jarvis.timao.onState(cb)` / `onEvent(cb)`):

### `timao:state` — `TimaoState`
```js
{
  phase: 'idle'|'pre'|'live'|'halftime'|'post',
  simulated: false,
  updatedAt: 1794100000000,
  minutesToKickoff: 42,              // só em 'pre'/'idle' com jogo agendado
  match: {
    id, league: 'bra.1', leagueName: 'Brasileirão', date: ISO,
    isHome: true, venue: 'Neo Química Arena', broadcasts: ['Premiere'],
    clock: "67'", period: 2, statusDetail: '2º tempo',
    cor: { name: 'Corinthians', short: 'COR', logo, score: 1 },
    opp: { name: 'Botafogo',   short: 'BOT', logo, score: 0 },
  } | null,
  stats: { cor: { possession, shots, shotsOnTarget, corners, yellow, red, saves }, opp: { … } } | null,
  events: [ { type: 'goal'|'own_goal'|'penalty_goal'|'yellow'|'red'|'sub'|'kickoff'|'halftime'|'second_half'|'fulltime'|'var',
              minute: "58'", team: 'cor'|'opp'|null, player, assist, text } ],   // mais recente por último
  decisive: { is: true, reasons: ['Briga contra o rebaixamento', 'Reta final do Brasileirão'] },
  standing: { rank: 17, points: 37, size: 20 },             // tabela antes do jogo
  projected: { rank: 16, points: 40 } | null,                // “se terminasse agora”
  radar: [ { id, name, short, logo, rank, points, live: true, score: '1-0', vs: 'Bahia', clock: "60'",
             projectedPoints: 41, threat: true } ],          // concorrentes diretos (Z4 ±3 pts)
}
```

### `timao:event` — `TimaoEvent`
```js
{ kind: 'goal_for'|'goal_against'|'kickoff'|'halftime'|'second_half'|'fulltime'|'red_for'|'red_against'
        |'prematch_60'|'prematch_10'|'rival_goal'|'var',
  match: { cor, opp, clock },          // mesmo formato de state.match (resumido)
  minute: "58'", player: 'Matheus Bidu', assist: 'Mateuzinho',
  score: { cor: 1, opp: 0 },
  result: 'V'|'E'|'D',                 // só em fulltime
  decisive: { is, reasons },           // em prematch_*
  rival: { name, score, vs, good: true },   // só em rival_goal (good = bom pro Timão)
  say: 'Gol do Corinthians! Matheus Bidu, aos 58 minutos.',   // frase sugerida para a voz (pt-BR)
  simulated: false }
```

## Regras
- **Jogo decisivo:** Z4 ou a ≤ 3 pts dele; ≤ 5 rodadas para o fim; clássico (Palmeiras, São Paulo, Santos); mata-mata (liga ≠ `bra.1`).
- **Alertas pré-jogo:** `prematch_60` em todo jogo; `prematch_10` só em jogo decisivo (cada um no máximo uma vez por partida).
- **Gol:** detectado pela mudança de placar (o `summary` completa autor/minuto; se ainda não tiver, manda sem autor e não repete).
  Gol anulado (placar diminui) → evento `var`.
- **Janela minimizada:** notificação do Windows + `flashFrame`; só traz o Jarvis pra frente se `config.timaoPopup` (padrão `false` — não atrapalhar o FC 26).
- **Radar:** não inclui o adversário do próprio jogo do Corinthians (o jogo dele já é o nosso).
- **Gol contra:** a ESPN marca o lance no time de quem fez; no evento, `team` = quem se beneficiou.
- **Abrir no meio do jogo:** o primeiro snapshot de um jogo já em andamento vira linha de base silenciosa (não repete gols antigos).
- **Testes:** `node scripts/timao-test.js` (lógica pura, replay do 2×0 no Mirassol, sem Electron) e
  `node_modules/electron/dist/electron.exe scripts/timao-electron-test.js` (simulador + testGoal dentro do Electron, janela falsa).
- Configurações novas: `timaoSiren` (true), `timaoPopup` (false), `timaoVoice` (true), `timaoLeagues` (["bra.1"]).
