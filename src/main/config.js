// Configurações do Jarvis: padrões + o que o usuário salvou em %APPDATA%\jarvis\config.json
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const DEFAULTS = {
  userName: 'Vitor',
  voice: true,            // fala a saudação ao abrir
  voiceCommands: true,    // fica ouvindo a palavra "Jarvis"
  autoBriefing: true,     // pede ao Claude um briefing ao abrir (usa o seu plano)
  askOnStart: true,       // pergunta "jogar ou outra coisa?" ao abrir
  fullscreen: false,
  location: null,         // { name, lat, lon } — vazio = detectar pela internet
  teamId: '874',          // Corinthians na ESPN
  league: 'bra.1',
  bladeDashDir: path.join(process.env.USERPROFILE || 'C:\\Users\\vitor', 'OneDrive', 'Área de Trabalho', 'Projetos', 'blade-dash'),
};

function file() {
  return path.join(app.getPath('userData'), 'config.json');
}

function load() {
  try {
    return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(file(), 'utf8')) };
  } catch {
    return { ...DEFAULTS };
  }
}

function save(patch) {
  const next = { ...load(), ...patch };
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  const tmp = file() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8');
  fs.renameSync(tmp, file());
  return next;
}

module.exports = { load, save, DEFAULTS };
