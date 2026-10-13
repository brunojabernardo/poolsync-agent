'use strict';

// CONSTRÓI O PoolSyncAgent.exe, com o logótipo redondo do PoolSync.
//
//   npm run build        → dist/PoolSyncAgent.exe
//
// Porque é que isto não é uma linha de `pkg`: o pkg não sabe pôr ícones. Quem
// os põe é o `rcedit`, e a ordem é que é o truque.
//
// ⚠️ O ÍCONE VAI NA BASE, E NÃO NO FIM. Correr o rcedit sobre o .exe já
// empacotado ESTRAGA-O: o pkg deixa a aplicação colada depois da última secção
// do ficheiro, e o rcedit reescreve o PE e deita essa cauda fora — o executável
// encolhe 5 MB e morre com «Pkg: Error reading from file». Experimentado a
// 13/10/2026. O que se faz é pôr o ícone no binário BASE do Node (que é um .exe
// normal) e empacotar por cima dele.
//
// ⚠️ E O pkg CONFERE O HASH DA BASE que tem na cache: uma base alterada é
// deitada fora e descarregada outra vez («Binary hash does NOT match.
// Re-fetching...»). Por isso a base não se toca na cache: descarrega-se para
// aqui com o `pkg-fetch` e diz-se ao pkg onde está, pelo `PKG_NODE_PATH` — que
// é o caminho por onde ele aceita uma base sem a conferir.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const RAIZ = __dirname;
const DIST = path.join(RAIZ, 'dist');
const BASE_DIR = path.join(DIST, 'base');
const ICONE = path.join(RAIZ, 'icone.ico');
const SAIDA = path.join(DIST, 'PoolSyncAgent.exe');
const ALVO = 'node22-win-x64';

// O rcedit é um programa do Windows. Em Linux/macOS precisava de Wine, e a
// release é construída num runner Windows: aqui diz-se porquê em vez de
// rebentar com um erro de permissões.
const noWindows = process.platform === 'win32';

// ⚠️ SEM `shell: true`. A pasta deste projeto tem um espaço no nome
// («OneDrive - CESAE») e, por uma shell, o caminho parte-se ao meio: o
// pkg-fetch chegou a escrever a base em `C:\Users\bruno\OneDrive\`. Sem shell,
// os argumentos vão como são.
function corre(cmd, args, opts) {
  console.log('→ ' + path.basename(cmd) + ' ' + args.map((a) => (a.includes(' ') ? '"' + a + '"' : a)).join(' '));
  execFileSync(cmd, args, Object.assign({ stdio: 'inherit', cwd: RAIZ }, opts));
}

// Os comandos chamam-se pelo ficheiro deles, e não pelo `npx`: o npx é outra
// shell pelo meio, com as mesmas aspas para perder.
const cli = (pacote) => path.join(RAIZ, 'node_modules', pacote, 'lib-es5', 'bin.js');

fs.mkdirSync(DIST, { recursive: true });

// 1. A base do Node, para uma pasta nossa (não a cache do pkg).
corre(process.execPath, [cli('@yao-pkg/pkg-fetch'),
  '--node-range', 'node22', '--platform', 'win', '--arch', 'x64', '--output', BASE_DIR]);
const base = fs.readdirSync(BASE_DIR).map((f) => path.join(BASE_DIR, f)).find((f) => /node-v/.test(f));
if (!base) throw new Error('o pkg-fetch nao deixou nenhuma base em ' + BASE_DIR);

// 2. O ícone e o nome, na base.
if (noWindows && fs.existsSync(ICONE)) {
  const rcedit = path.join(RAIZ, 'node_modules', 'rcedit', 'bin', 'rcedit-x64.exe');
  if (!fs.existsSync(rcedit)) throw new Error('falta o rcedit (npm install)');
  corre(rcedit, [
    base,
    '--set-icon', ICONE,
    '--set-version-string', 'ProductName', 'PoolSync Agent',
    '--set-version-string', 'CompanyName', 'PoolSync',
    '--set-version-string', 'FileDescription', 'PoolSync Agent - liga o OBS ao PoolSync',
    '--set-version-string', 'LegalCopyright', 'PoolSync - MIT',
  ]);
} else {
  console.log('(sem icone: ' + (noWindows ? 'falta o icone.ico' : 'o rcedit so corre no Windows') + ')');
}

// 3. E empacotar POR CIMA dessa base.
corre(process.execPath, [cli('@yao-pkg/pkg'), '.', '--targets', ALVO, '--output', SAIDA], {
  env: Object.assign({}, process.env, { PKG_NODE_PATH: base }),
});

const mb = (fs.statSync(SAIDA).size / 1024 / 1024).toFixed(1);
console.log('\nfeito: ' + path.relative(RAIZ, SAIDA) + ' (' + mb + ' MB)');
