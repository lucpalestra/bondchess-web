// Extrai as cifras (nomes dos acordes) de um PDF quando elas são texto dentro do arquivo.
// Salva em cifras/<id>.txt no formato ChordPro, uma linha por sistema da partitura.
// O app usa isso para o Modo Cifra e o desenho dos acordes.
//
// Uso:  node tools/extrair-cifras.mjs pdfs/she.pdf [--force]
// Precisa de: npm install --save-dev pdfjs-dist@4.10.38

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHORD =
  /^[A-G][#b♯♭]?(m|maj|min|dim|aug|sus|M|°|º|ø|\+|-)?\d{0,2}(\(?[#b+-]?\d{1,2}\)?)*(sus\d?)?(\/[A-G][#b♯♭]?)?$/;

// Raiz do acorde sozinha e pedaços que costumam vir separados no PDF
// (o "7" e o "4" em sobrescrito, o "m" depois de um acidente desenhado como figura).
const ROOT = /^[A-G][#b♯♭]?$/;
const SUFFIX = /^(m|M|min|maj|maj7|7M|sus|sus2|sus4|dim|dim7|aug|º|°|ø|\+|-|\d{1,2}|\(?[#b+-]?\d{1,2}\)?|m\d{1,2}|\/[A-G][#b]?)$/;

// Junta "A"+"7" -> "A7", "Gsus"+"4" -> "Gsus4". Se houver um vão entre a raiz e o resto
// (ex.: "B" … "m"), provavelmente tem um ♭/♯ desenhado como figura: marca como incerto.
// items: { str, x, y, w } com y crescendo para cima.
export function mergeFragments(items) {
  const used = new Set();
  const tokens = [];
  const sorted = items.map((it, i) => ({ ...it, i })).sort((a, b) => a.x - b.x);
  for (const it of sorted) {
    if (used.has(it.i)) continue;
    const str = it.str.trim();
    if (!CHORD.test(str) && !ROOT.test(str)) continue;
    let chord = str;
    let end = it.x + it.w;
    let uncertain = false;
    for (;;) {
      const next = sorted.find(
        (o) =>
          !used.has(o.i) &&
          o.i !== it.i &&
          SUFFIX.test(o.str.trim()) &&
          o.x >= end - 1.5 &&
          o.x <= end + 6 &&
          o.y >= it.y - 2 &&
          o.y <= it.y + 10
      );
      if (!next || !CHORD.test(chord + next.str.trim())) break;
      if (next.x - end > 2.5) uncertain = true;
      chord += next.str.trim();
      end = next.x + next.w;
      used.add(next.i);
    }
    used.add(it.i);
    tokens.push({ x: it.x, y: it.y, chord: chord.replace(/♯/g, '#').replace(/♭/g, 'b'), uncertain });
  }
  return tokens;
}

// Padrão completo do acorde (aceita 7+ e 7M da notação brasileira).
const CHORD_FULL =
  /^[A-G][#b]?(m|maj|min|dim|aug|sus|M|°|º|ø|\+|-)?\d{0,2}(\+|M)?(\(?[#b+-]?\d{1,2}\)?)*(sus\d?)?(\/[A-G][#b]?)?$/;
const FRAG = /^[0-9A-Za-z#b()+\-\/°ºø]+$/;

// Junta os pedaços de cada acorde, inclusive o ♭/♯ que vem como figura da fonte musical
// (é por isso que o extrator antigo lia "B" no lugar de "Bb").
export function readChords(words, accidentals) {
  const items = [
    ...words.map((w) => ({ ...w, str: w.str.trim() })),
    ...accidentals.map((a) => ({ str: a.code === 0x62 ? 'b' : '#', x: a.x, y: a.y, w: a.w || 4.5, acc: true })),
  ].sort((a, b) => a.x - b.x);
  const used = new Set();
  const out = [];
  items.forEach((it, i) => {
    if (used.has(i) || it.acc || !/^[A-G]/.test(it.str) || !FRAG.test(it.str)) return;
    const parts = [i];
    let end = it.x + it.w;
    for (;;) {
      const j = items.findIndex(
        (o, k) => !used.has(k) && !parts.includes(k) && FRAG.test(o.str) && o.x >= end - 1.5 && o.x <= end + 4 && o.y >= it.y - 3 && o.y <= it.y + 10
      );
      if (j < 0) break;
      parts.push(j);
      end = items[j].x + items[j].w;
    }
    // o maior começo que forma um acorde válido
    for (let n = parts.length; n >= 1; n--) {
      const str = parts.slice(0, n).map((k) => items[k].str).join('');
      if (CHORD_FULL.test(str)) {
        parts.slice(0, n).forEach((k) => used.add(k));
        // "D79" no PDF é o 7 com a 9ª em sobrescrito: D7(9). "F7+9" vira F7+(9).
        const norm = str.replace(/^([A-G][#b]?m?)(7\+?|7M)([#b+]?\d{1,2})(\/[A-G][#b]?)?$/, '$1$2($3)$4');
        const complex = /[()+]|7M|\d{2}/.test(norm);
        out.push({ chord: norm, x: it.x, y: it.y, complex });
        return;
      }
    }
  });
  return out;
}


// A fonte musical (Maestro/Sonata do Finale) é a que tem mais claves e barras.
// Dela vêm os ♭/♯ desenhados como figura ao lado do nome do acorde.
export function musicFontOf(items) {
  const score = {};
  for (const it of items) {
    const code = it.str.codePointAt(0) & 0xff;
    if ([0x26, 0x6c, 0x3d, 0xc7, 0xcf].includes(code) && [...it.str].length <= 4) score[it.fontName] = (score[it.fontName] || 0) + 1;
  }
  const best = Object.entries(score).sort((a, b) => b[1] - a[1])[0];
  return best && best[1] >= 20 ? best[0] : null;
}

export async function extractChords(pdfPath) {
  let pdfjs;
  try {
    pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  } catch {
    throw new Error('falta o pdfjs-dist. Rode: npm install --save-dev pdfjs-dist@4.10.38');
  }
  const data = new Uint8Array(fs.readFileSync(pdfPath));
  const doc = await pdfjs.getDocument({ data, disableFontFace: true, verbosity: 0 }).promise;

  const rows = [];
  let nearTitle = 0;
  const uncertain = [];
  const complexList = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const height = page.view[3] - page.view[1];
    const content = await page.getTextContent();
    const raw = content.items.filter((i) => i.str && i.str.trim());
    const mf = musicFontOf(raw);
    const items = [];
    const glyphs = [];
    for (const item of raw) {
      const str = item.str.trim();
      const [x, y] = [item.transform[4], item.transform[5]];
      if (mf && item.fontName === mf) {
        const cw = (item.width || 0) / Math.max(1, [...item.str].length);
        for (const ch of item.str) glyphs.push({ code: ch.codePointAt(0) & 0xff, x, y, w: cw });
        continue;
      }
      // Um item pode trazer mais de uma palavra separada por espaço.
      const parts = str.split(/\s+/);
      const step = (item.width || 0) / Math.max(1, parts.length);
      parts.forEach((part, i) => items.push({ str: part, x: x + i * step, y, w: step }));
    }
    let tokens;
    if (mf) {
      // PDF do Finale: lê o ♭/♯ desenhado e a notação 7+/(9). Fora das pautas = altura dos acordes.
      const staves = glyphs.filter((g) => g.code === 0x26 || g.code === 0x3f).map((g) => g.y);
      const acc = glyphs.filter((g) => (g.code === 0x62 || g.code === 0x23) && !staves.some((sy) => Math.abs(g.y - sy) <= 22));
      tokens = readChords(items, acc).map((t) => ({ ...t, uncertain: false }));
    } else tokens = mergeFragments(items);
    for (const t of tokens) {
      // Faixa do título/créditos na 1ª página: conta para avisar, pode ser falso acorde.
      if (p === 1 && t.y > height * 0.86) nearTitle++;
      if (t.uncertain) uncertain.push(t.chord);
      if (t.complex) complexList.push(t.chord);
    }
    // De cima para baixo (no PDF o y cresce para cima), agrupando quem está na mesma altura.
    tokens.sort((a, b) => b.y - a.y || a.x - b.x);
    for (const t of tokens) {
      const row = rows.length && rows[rows.length - 1];
      if (row && row.page === p && Math.abs(row.y - t.y) < 4) row.items.push(t);
      else rows.push({ page: p, y: t.y, items: [t] });
    }
  }
  for (const r of rows) r.items.sort((a, b) => a.x - b.x);
  const out = rows.map((r) => r.items.map((t) => t.chord));
  out.nearTitle = nearTitle;
  out.uncertain = uncertain;
  out.complex = complexList;
  return out;
}

// Contagem de acordes não prova que estão certos. Aponta o que merece conferência.
function review(rows) {
  const all = rows.flat();
  const distinct = [...new Set(all)];
  const warnings = [];
  if (rows.uncertain && rows.uncertain.length) {
    warnings.push(`provável ♭/♯ não lido em: ${rows.uncertain.join(', ')} (o acidente está desenhado como figura no PDF)`);
    warnings.push('neste PDF, acordes sem acidente (ex.: E, D, A) também podem ser Eb, Db, Ab: compare com o PDF');
  }
  if (rows.complex && rows.complex.length)
    warnings.push(`notação de bossa/jazz (7+, (9), 13…): ${[...new Set(rows.complex)].join(', ')}: o ♭/♯ já foi lido, confira só as tensões`);
  if (rows.nearTitle) warnings.push(`${rows.nearTitle} "acorde(s)" na área do título: podem ser texto, confira o começo`);
  const singles = rows.filter((r) => r.length === 1).length;
  if (rows.length >= 4 && singles / rows.length > 0.5) warnings.push('muitas linhas com 1 acorde só: a ordem pode ter misturado');
  const odd = distinct.filter((c) => /\d{2}|\(.*\(|\/.*\//.test(c));
  if (odd.length) warnings.push(`acordes incomuns: ${odd.join(', ')}`);
  if (distinct.length > 20) warnings.push(`${distinct.length} acordes diferentes: muito para uma lead sheet, confira`);
  return { distinct, warnings };
}

const hasLyricsText = (text) =>
  text
    .split(/\r?\n/)
    .some((l) => !l.trim().startsWith('#') && !/^\s*\{.*\}\s*$/.test(l) && /[a-zA-ZÀ-ÿ]{2,}/.test(l.replace(/\[[^\]]+\]/g, '')));

// Espalha as linhas de acordes do PDF sobre as linhas da letra, na ordem (como o letra.mjs).
async function mergeIntoLyrics(pdfPath, out, existing) {
  const id = path.basename(pdfPath, path.extname(pdfPath));
  const rows = await extractChords(pdfPath);
  const total = rows.reduce((n, r) => n + r.length, 0);
  if (total < 4) return { id, status: 'mantida' };
  const place = (line, chords) => {
    const words = line.split(' ');
    const outW = words.slice();
    chords.forEach((c, k) => {
      const w = Math.min(words.length - 1, Math.round((k * words.length) / chords.length));
      const m = outW[w].match(/^((?:\[[^\]]+\])*)([\s\S]*)$/);
      outW[w] = `${m[1]}[${c}]${m[2]}`;
    });
    return outW.join(' ');
  };
  let r = 0;
  const lines = existing.split(/\r?\n/).map((l) => {
    const isLyric = l.trim() && !l.trim().startsWith('#') && !/^\s*\{.*\}\s*$/.test(l);
    if (!isLyric || r >= rows.length) return l;
    return place(l, rows[r++]);
  });
  let text = lines.join('\r\n');
  if (!/\{status:/i.test(text)) text = text.replace(/^(\{title:[^}]*\}\r?\n)/i, '$1{status: extraida}\r\n');
  else text = text.replace(/\{status:[^}]*\}/i, '{status: extraida}');
  fs.copyFileSync(out, out.replace(/\.txt$/, '.antes.bak'));
  fs.writeFileSync(out, text);
  const { distinct, warnings } = review(rows);
  warnings.unshift(`a letra já existia: juntei ${Math.min(r, rows.length)} linha(s) de acordes por cima dela (backup em cifras/${id}.antes.bak)`);
  return { id, status: 'ok', total, lines: rows.length, distinct, warnings };
}

export async function writeCifra(pdfPath, { force = false } = {}) {
  const id = path.basename(pdfPath, path.extname(pdfPath));
  const out = path.join(root, 'cifras', `${id}.txt`);
  if (fs.existsSync(out)) {
    const existing = fs.readFileSync(out, 'utf8');
    const auto = /\{status:\s*extraida\s*\}/i.test(existing) || existing.includes('{c: lida do PDF');
    // Nunca sobrescreve cifra revisada por você, nem uma que já tenha letra (nem com --force).
    const realChords = existing
      .split(/\r?\n/)
      .filter((l) => !l.trim().startsWith('#') && !/^\s*\{.*\}\s*$/.test(l))
      // só conta acorde de verdade: [Refrão], [Intro] e [2x] de site de letra não valem
      .some((l) => /\[[A-G][#b]?(?:m|maj|min|dim|aug|sus|M|°|º|ø|\+|-)?\d{0,2}(?:\+|M|°|º)?(?:\(?[#b+\-]?\d{1,2}[+\-]?(?:\/[#b+\-]?\d{1,2}[+\-]?)*\)?)*(?:sus\d?)?(?:\/\d{1,2}[+\-]?)?(?:\/[A-G][#b]?)?\]/.test(l));
    // Letra que chegou ANTES do PDF (só letra, sem nenhum acorde): junta os acordes por cima,
    // sem mudar uma palavra da letra, com backup.
    if (hasLyricsText(existing) && !realChords) return mergeIntoLyrics(pdfPath, out, existing);
    if (!auto || hasLyricsText(existing)) return { id, status: 'mantida' };
    if (!force) return { id, status: 'ja-extraida' };
  }
  const rows = await extractChords(pdfPath);
  const total = rows.reduce((n, r) => n + r.length, 0);
  if (total < 4) return { id, status: 'sem-texto', total };
  const { distinct, warnings } = review(rows);
  const title = id.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  const body = [
    `{title: ${title}}`,
    '{status: extraida}',
    '{c: lida do PDF automaticamente, confira}',
    '# Acordes extraídos do PDF, uma linha por linha da partitura.',
    '# Para colocar a letra: node tools/fabrica.js --cifra ' + id,
    '',
    ...rows.map((r) => r.map((c) => `[${c}]`).join('   ')),
    '',
  ].join('\r\n');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, body);
  return { id, status: 'ok', total, lines: rows.length, distinct, warnings };
}

// Uso direto pela linha de comando
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const files = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const force = process.argv.includes('--force');
  for (const f of files) {
    try {
      const r = await writeCifra(f, { force });
      const msg = {
        ok: `extraída (a conferir): ${r.total} acordes, ${r.lines} linhas, ${r.distinct && r.distinct.length} diferentes`,
        mantida: 'revisada por você ou com letra: mantive como está',
        'ja-extraida': 'já extraída antes, mantive',
        'sem-texto': 'sem cifra em texto (PDF é imagem): use --cifra para digitar',
      }[r.status];
      console.log(`CIFRA ${msg}`);
      for (const w of r.warnings || []) console.log(`  ⚠️ ${w}`);
    } catch (e) {
      console.log(`CIFRA ${path.basename(f)}: ❌ ${e.message}`);
    }
  }
}
