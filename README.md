# J.A.R.V.I.S. — dashboard pessoal

Painel estilo HUD do Homem de Ferro que abre junto com o Windows, cumprimenta o Vitor e pergunta:
**vai jogar ou fazer outra coisa?** Jogar abre o [Blade Dash](../blade-dash/BLADE_DASH.md).

## O que tem
- Abertura animada com saudação falada ("Olá, Vitor") e a pergunta jogar / outra coisa / continuar o último jogo.
- **Corinthians:** posição, pontos, últimos 5 jogos, próximo jogo com contagem regressiva, alerta de Z4, mini tabela e notícias (ESPN + Google Notícias).
- **Feed de notícias:** tecnologia, geopolítica, mundo, geek, games, Timão.
- **Modo jogo:** último jogo do Blade Dash com capa, botão continuar, recentes, abrir o Blade Dash.
- **Música:** trilha do dia (rock/emo/rock BR) com links YouTube/Spotify e rádio online por gênero.
- Clima (cidade detectada pela internet), cotações (dólar, euro, bitcoin), CPU/RAM/discos.
- **Claude integrado:** briefing de abertura e chat. Usa o **Claude Code instalado** (`claude -p`), ou seja, o seu plano — sem chave de API.

## Rodar
```
npm start
```
Atalho global: **Ctrl + Alt + J**.

## Início automático
```
npm run autostart:on    # grava "Jarvis" em HKCU\...\Run e desliga o início automático do Blade Dash
npm run autostart:off
npm run shortcut        # recria o atalho "Jarvis" na Área de Trabalho
```
Também dá para ligar/desligar em ⚙ Configurações.

## Arquivos
- `src/main/` — Electron: `main.js` (janela, IPC, início automático), `feeds.js` (dados da internet), `games.js` (Blade Dash), `claude.js` (Claude Code headless), `config.js`.
- `src/renderer/` — interface (`index.html`, `css/hud.css`, `js/app.js`, `js/music.js`).
- Configurações do usuário: `%APPDATA%\jarvis\config.json`.

## Fontes de dados (grátis, sem chave)
ESPN (futebol), Google Notícias RSS, Open-Meteo (clima), ipwho.is (cidade), AwesomeAPI (cotações), radio-browser.info (rádios).

Inspirações: [Ali120B/jarvis](https://github.com/Ali120B/jarvis), [Axshatt/VirtualAssistant](https://github.com/Axshatt/VirtualAssistant), [NandaKumar876/VirtualAssistant](https://github.com/NandaKumar876/VirtualAssistant).
