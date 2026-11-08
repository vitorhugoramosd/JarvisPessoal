// Conversa com o Claude usando o Claude Code instalado na máquina (modo headless "claude -p").
// Usa o login/plano do próprio Claude Code — sem chave de API.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { app } = require('electron');

let sessionId = null;

function claudeExe() {
  const home = process.env.USERPROFILE || '';
  for (const p of [path.join(home, '.local', 'bin', 'claude.exe'), path.join(home, '.local', 'bin', 'claude')]) {
    if (fs.existsSync(p)) return p;
  }
  return 'claude';
}

function workdir() {
  const d = path.join(app.getPath('userData'), 'claude-workspace');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function persona(cfg) {
  const now = new Date().toLocaleString('pt-BR', { dateStyle: 'full', timeStyle: 'short' });
  return [
    `Você é J.A.R.V.I.S., o assistente pessoal do ${cfg.userName}, rodando num dashboard no PC dele.`,
    'Fale sempre em português do Brasil, com o tom do JARVIS dos filmes: educado, espirituoso, confiante, um toque de ironia britânica. Pode chamá-lo de "senhor" às vezes, sem exagero.',
    'Seja conciso: respostas curtas (até ~6 frases) a menos que ele peça detalhes. Texto puro, sem tabelas; listas curtas com "-" são ok.',
    `Sobre o ${cfg.userName}: torcedor fanático do Corinthians; gosto musical eclético (do Spotify dele): principalmente rock alternativo, emo e metalcore (Linkin Park, Pierce the Veil, Bring Me The Horizon, System of a Down, Muse, Metallica, The Strokes, Oasis, Beatles, Red Hot Chili Peppers, Guns N' Roses, Charlie Brown Jr., Fresno), mas também pagode (Péricles, Menos é Mais, Belo), sertanejo e country, pop/eletrônica (Avicii, Imagine Dragons, Twenty One Pilots, The Weeknd) e rap/trap (Kanye, Haikaiss); fã de How I Met Your Mother e La La Land; gamer (EA FC 26, Star Wars Jedi, Assassin's Creed, The Last of Us, Minecraft, LEGO Star Wars); desenvolvedor de software (.NET/C#); se interessa por tecnologia, geopolítica e cultura geek. Mora em Joinville/SC.`,
    'Para fatos atuais (placares, notícias, preços), use a busca na web quando disponível e diga se não tiver certeza.',
    `Agora é ${now}.`,
  ].join('\n');
}

function ask(prompt, cfg, { fresh = false, allowWeb = true, timeoutMs = 180000 } = {}) {
  if (fresh) sessionId = null;
  return new Promise((resolve, reject) => {
    const args = ['-p', '--output-format', 'json', '--append-system-prompt', persona(cfg),
      '--disallowedTools', 'Bash', 'Edit', 'Write', 'NotebookEdit', 'Task'];
    if (allowWeb) args.push('--allowedTools', 'WebSearch', 'WebFetch');
    if (sessionId) args.push('--resume', sessionId);
    const child = spawn(claudeExe(), args, { cwd: workdir(), windowsHide: true, env: process.env });
    let out = '', err = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('O Claude demorou demais para responder.')); }, timeoutMs);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => { clearTimeout(timer); reject(new Error('Não achei o Claude Code instalado (' + e.message + ')')); });
    child.on('close', (code) => {
      clearTimeout(timer);
      try {
        const j = JSON.parse(out.trim().split('\n').pop());
        if (j.session_id) sessionId = j.session_id;
        if (j.is_error) return reject(new Error(j.result || 'Erro do Claude'));
        resolve({ text: j.result || '', sessionId });
      } catch {
        reject(new Error((err || out || `claude saiu com código ${code}`).slice(0, 400)));
      }
    });
    child.stdin.end(prompt);
  });
}

function reset() { sessionId = null; }

module.exports = { ask, reset };
