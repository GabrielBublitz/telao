// Filtro do git (clean/smudge) que mantém dados sensíveis fora do repositório.
//   clean  (ao commitar):          valor real -> <MARCADOR>
//   smudge (ao fazer checkout):    <MARCADOR> -> valor real
// Os pares ficam em .sensitive.local (fora do git). Sem esse arquivo, o filtro não altera nada.
// Em arquivos .html o marcador é gravado como &lt;MARCADOR&gt; para não virar uma tag HTML.
// Instalação: scripts\setup-git-filter.ps1
import fs from 'node:fs';
import path from 'node:path';

const [mode, file = ''] = process.argv.slice(2);
const input = fs.readFileSync(0);

function loadPairs() {
  try {
    return fs
      .readFileSync(path.join(process.cwd(), '.sensitive.local'), 'utf8')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#') && l.includes('='))
      .map((l) => {
        const i = l.indexOf('=');
        return { value: l.slice(0, i).trim(), tag: l.slice(i + 1).trim() };
      })
      .filter((p) => p.value && p.tag)
      .sort((a, b) => b.value.length - a.value.length); // "10.0.0.12" antes de "10.0.0.1"
  } catch {
    return [];
  }
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Valores que terminam/começam com dígito não podem casar dentro de números maiores (ex.: .1 em .124).
const bounded = (s) => `${/^\d/.test(s) ? '(?<![\\d.])' : ''}${escapeRe(s)}${/\d$/.test(s) ? '(?![\\d])' : ''}`;

const pairs = loadPairs();
if (!pairs.length || (mode !== 'clean' && mode !== 'smudge')) {
  process.stdout.write(input);
  process.exit(0);
}

let text = input.toString('utf8');
const html = /\.html?$/i.test(file);
const shown = (tag) => (html ? tag.replace(/</g, '&lt;').replace(/>/g, '&gt;') : tag);

for (const { value, tag } of pairs) {
  if (mode === 'clean') text = text.replace(new RegExp(bounded(value), 'g'), shown(tag));
  else text = text.split(shown(tag)).join(value);
}
process.stdout.write(text);
