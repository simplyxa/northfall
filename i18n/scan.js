// Находит в собранной странице все русские тексты: строки и куски шаблонов в скриптах, текст и атрибуты в разметке.
'use strict';
const acorn = require('./acorn.cjs'), walk = require('./walk.cjs');
const CYR = /[А-Яа-яЁё]/;
function scripts(html) {
  const out = [], re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi; let m;
  while ((m = re.exec(html))) {
    const attrs = m[1]; if (/\bsrc=/.test(attrs)) continue;
    const json = /application\/(ld\+)?json/.test(attrs);
    out.push({ start: m.index + m[0].indexOf('>') + 1, code: m[2], json });
  }
  return out;
}
function scan(html) {
  const units = []; // {s,e,kind,key,ctx}
  const sc = scripts(html);
  for (const S of sc) {
    if (S.json) { // JSON-LD: строки JSON
      const re = /"((?:[^"\\]|\\.)*)"/g; let m;
      while ((m = re.exec(S.code))) if (CYR.test(m[1])) units.push({ s: S.start + m.index, e: S.start + m.index + m[0].length, kind: 'json', key: JSON.parse(m[0]) });
      continue;
    }
    let ast;
    try { ast = acorn.parse(S.code, { ecmaVersion: 'latest', sourceType: 'script', allowReturnOutsideFunction: true, allowAwaitOutsideFunction: true }); }
    catch (e) { throw new Error('parse fail at ' + S.start + ': ' + e.message); }
    walk.fullAncestor(ast, (node, st, anc) => {
      const par = anc[anc.length - 2];
      if (node.type === 'Literal' && typeof node.value === 'string' && CYR.test(node.value)) {
        let ctx = '';
        if (par && par.type === 'Property' && par.key === node && !par.computed) ctx = 'key';
        else if (par && par.type === 'BinaryExpression' && /^[!=]==?$/.test(par.operator)) ctx = 'cmp';
        else if (par && par.type === 'SwitchCase') ctx = 'case';
        units.push({ s: S.start + node.start, e: S.start + node.end, kind: 'str', q: S.code[node.start], key: node.value, ctx });
      } else if ((node.type === 'Property' || node.type === 'PropertyDefinition') && !node.computed && node.key && node.key.type === 'Literal' && typeof node.key.value === 'string' && CYR.test(node.key.value)) {
        // ключи объектов вида {'Лесной волк': …} acorn-walk сам не обходит
        units.push({ s: S.start + node.key.start, e: S.start + node.key.end, kind: 'str', q: S.code[node.key.start], key: node.key.value, ctx: 'key' });
      } else if (node.type === 'TemplateElement' && CYR.test(node.value.raw)) {
        units.push({ s: S.start + node.start, e: S.start + node.end, kind: 'tpl', key: node.value.raw, ctx: '' });
      }
    });
  }
  // разметка вне скриптов и стилей: текст между тегами и атрибуты
  const skip = []; { const re = /<(script|style)\b[\s\S]*?<\/\1>/gi; let m; while ((m = re.exec(html))) skip.push([m.index, m.index + m[0].length]); }
  const inSkip = p => skip.some(([a, b]) => p >= a && p < b);
  { const re = />([^<>]*[А-Яа-яЁё][^<>]*)</g; let m; while ((m = re.exec(html))) if (!inSkip(m.index)) { const t = m[1]; const a = t.match(/^\s*/)[0].length, b = t.match(/\s*$/)[0].length; units.push({ s: m.index + 1 + a, e: m.index + 1 + t.length - b, kind: 'html', key: t.slice(a, t.length - b) }); } }
  { const re = /\s(content|title|alt|aria-label|placeholder)="([^"]*[А-Яа-яЁё][^"]*)"/g; let m; while ((m = re.exec(html))) if (!inSkip(m.index)) { const off = m.index + m[0].indexOf('"') + 1; units.push({ s: off, e: off + m[2].length, kind: 'attr', key: m[2] }); } }
  units.sort((a, b) => a.s - b.s);
  return units;
}
module.exports = { scan, CYR };
if (require.main === module) {
  const html = require('fs').readFileSync(process.argv[2], 'utf8'), U = scan(html);
  const uniq = new Map(); for (const u of U) { const k = u.key; const x = uniq.get(k) || { n: 0, kinds: new Set(), ctx: new Set() }; x.n++; x.kinds.add(u.kind); if (u.ctx) x.ctx.add(u.ctx); uniq.set(k, x); }
  console.log('units', U.length, 'unique', uniq.size, 'chars', [...uniq.keys()].reduce((a, k) => a + k.length, 0));
  const by = {}; for (const u of U) by[u.kind + (u.ctx ? ':' + u.ctx : '')] = (by[u.kind + (u.ctx ? ':' + u.ctx : '')] || 0) + 1; console.log(by);
  for (const [k, x] of uniq) if (x.ctx.size) console.log([...x.ctx].join(','), JSON.stringify(k).slice(0, 80));
}
