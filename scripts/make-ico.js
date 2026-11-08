// Empacota assets/icon.png (256x256) em assets/icon.ico (ICO com PNG embutido, aceito desde o Windows Vista).
const fs = require('fs'), path = require('path');
const png = fs.readFileSync(path.join(__dirname, '..', 'assets', 'icon.png'));
const h = Buffer.alloc(22);
h.writeUInt16LE(0, 0); h.writeUInt16LE(1, 2); h.writeUInt16LE(1, 4); // header: 1 imagem
h[6] = 0; h[7] = 0; h[8] = 0; h[9] = 0;                               // 256x256 (0 = 256)
h.writeUInt16LE(1, 10); h.writeUInt16LE(32, 12);                       // planos, bpp
h.writeUInt32LE(png.length, 14); h.writeUInt32LE(22, 18);              // tamanho, offset
fs.writeFileSync(path.join(__dirname, '..', 'assets', 'icon.ico'), Buffer.concat([h, png]));
console.log('assets/icon.ico ok');
