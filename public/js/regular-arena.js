(function (root) {
  'use strict';
  const clamp = (v) => Math.max(0, Math.min(1, Number(v) || 0));
  const text = (el, value) => { if (el && el.textContent !== String(value)) el.textContent = String(value); };

  function mount(panel) {
    if (!panel) return null;
    const q = (s) => panel.querySelector(s);
    const el = {
      myHpText: q('#myhptext'), myHp: q('[data-ra="my-hp"]'),
      enemyHpText: q('#enemyhptext'), enemyHp: q('[data-ra="enemy-hp"]'),
      enemyChargeText: q('#ect'), enemyCharge: q('[data-ra="enemy-charge"]'),
      strike: q('#bs'), guard: q('#bg'), potion: q('#bpb'),
      skillButtons: [q('#sk0'), q('#sk1'), q('#sk2'), q('#sk3')],
      skillLabels: [q('#skl0'), q('#skl1'), q('#skl2'), q('#skl3')]
    };
    let state = null, receivedAt = 0, raf = 0, destroyed = false, lastEnemyPct = -1, lastStrikePct = -1;
    const now = () => root.performance && root.performance.now ? root.performance.now() : Date.now();
    const scale = (node, value) => { if (!node) return; const t = 'scaleX(' + clamp(value).toFixed(3) + ')'; if (node.__t !== t) { node.__t = t; node.style.transform = t; } };
    function frame(ts) {
      raf = 0;
      if (destroyed || !state) return;
      const elapsed = Math.max(0, Math.min(5000, ts - receivedAt)) / 1000;
      const playerCharge = clamp(state.ch + elapsed / 5);
      const enemyCharge = clamp(state.ech + elapsed / 5);
      if (el.strike) {
        // кнопку перерисовываем только при смене целого процента: conic-gradient дорогой, 60 раз в секунду не нужен
        const pp = Math.round(playerCharge * 100);
        if (pp !== lastStrikePct) {
          lastStrikePct = pp;
          el.strike.style.setProperty('--p', String(pp));
          el.strike.disabled = playerCharge < .2;
          el.strike.classList.toggle('full', playerCharge >= 1);
        }
      }
      scale(el.enemyCharge, enemyCharge);
      const pct = Math.round(enemyCharge * 100);
      if (pct !== lastEnemyPct) { text(el.enemyChargeText, pct + '%'); lastEnemyPct = pct; }
      raf = root.requestAnimationFrame(frame);
    }
    function update(s, ui) {
      if (destroyed || !s) return;
      state = { ch: clamp(s.ch), ech: clamp(s.ech) };
      receivedAt = now(); lastStrikePct = -1;
      text(el.myHpText, ui.myHpText);
      text(el.enemyHpText, ui.enemyHpText);
      scale(el.myHp, ui.myHpRatio);
      scale(el.enemyHp, ui.enemyHpRatio);
      if (el.guard) { text(el.guard, ui.guardText); el.guard.disabled = !!ui.guardDisabled; el.guard.classList.toggle('act', !!ui.guardActive); el.guard.style.setProperty('--p', String(ui.guardProgress)); }
      if (el.potion) { text(el.potion, ui.potionText); el.potion.disabled = !!ui.potionDisabled; el.potion.style.setProperty('--p', String(ui.potionProgress)); }
      for (let i = 0; i < el.skillButtons.length; i++) {
        const skill = ui.skills && ui.skills[i];
        const btn = el.skillButtons[i];
        if (!skill || !btn) continue;
        text(el.skillLabels[i], skill.text);
        btn.disabled = !!skill.disabled;
      }
      if (!raf) raf = root.requestAnimationFrame(frame);
    }
    function destroy() {
      destroyed = true; state = null;
      if (raf) root.cancelAnimationFrame(raf);
      raf = 0;
    }
    return { update, destroy, panel };
  }
  const api = { mount };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.NFRegularArena = api;
})(typeof window !== 'undefined' ? window : globalThis);
