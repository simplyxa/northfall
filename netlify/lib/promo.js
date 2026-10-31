// Акция на золото: документ admin/promo-gold {mult, until}. Пишет администратор из игры, читает только сервер для начисления.
async function promoNow(db) {
  try {
    const sn = await db.collection('admin').doc('promo-gold').get();
    if (!sn.exists) return 1;
    const p = sn.data() || {}, m = +p.mult || 1;
    if (!(m > 1 && m <= 3) || !(+p.until > Date.now()) || (+p.from && +p.from > Date.now())) return 1;
    return Math.round(m * 100) / 100;
  } catch (e) { console.error('promo', e.message); return 1; }
}
module.exports = { promoNow };
