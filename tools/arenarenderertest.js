'use strict';
const assert = require('assert');
const api = require('../public/js/regular-arena');
let clock = 0, next = 1;
const frames = new Map();
global.window = {
  performance: { now: () => clock },
  requestAnimationFrame(fn) { const id = next++; frames.set(id, fn); return id; },
  cancelAnimationFrame(id) { frames.delete(id); }
};
function node() {
  return {
    textContent: '', disabled: false, style: { transform: '', values: {}, setProperty(k,v){this.values[k]=v;} },
    classList: { values: new Set(), toggle(k,v){if(v)this.values.add(k);else this.values.delete(k);} }
  };
}
const nodes = {};
for (const id of ['#myhptext','#enemyhptext','#ect','#bs','#bg','#bpb','#sk0','#sk1','#sk2','#sk3','#skl0','#skl1','#skl2','#skl3','[data-ra="my-hp"]','[data-ra="enemy-hp"]','[data-ra="enemy-charge"]']) nodes[id]=node();
const panel = { querySelector: (s) => nodes[s] || null };
const view = api.mount(panel);
assert(view, 'renderer mounts');
view.update({ch:.5,ech:.25},{myHpText:'80/100',enemyHpText:'40/80',myHpRatio:.8,enemyHpRatio:.5,guardText:'Block',guardProgress:100,potionText:'Potion',potionProgress:100,skills:[{text:'Rage',disabled:false}]});
assert.strictEqual(nodes['#myhptext'].textContent,'80/100');
assert.strictEqual(nodes['[data-ra="my-hp"]'].style.transform,'scaleX(0.8000)');
assert.strictEqual(nodes['#skl0'].textContent,'Rage');
assert.strictEqual(nodes['#sk0'].disabled,false);
const first=[...frames.entries()][0];frames.delete(first[0]);clock=250;first[1](250);
assert.strictEqual(nodes['#bs'].style.values['--p'],'55.00');
assert.strictEqual(nodes['[data-ra="enemy-charge"]'].style.transform,'scaleX(0.3000)');
view.destroy();
assert.strictEqual(frames.size,0);
console.log('Regular arena renderer tests: 8 checks passed.');
