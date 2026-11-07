// Ограничение частоты запросов — token bucket, без внешних зависимостей.
//
// Почему не по IP: за одним мобильным оператором (CGNAT) может сидеть
// сотня игроков, и жёсткий лимит по IP отрубил бы им сохранения.
// Поэтому авторизованных режем по uid (после проверки токена),
// а по IP — только мусорный трафик без токена.
'use strict';

function makeLimiter(opts) {
  const buckets = new Map();
  const cap = opts.cap;            // сколько запросов пропускаем за раз (запас на всплеск)
  const perSec = opts.perSec;      // сколько запросов в секунду восстанавливаем

  function prune() {
    const now = Date.now();
    for (const [k, b] of buckets) if (now - b.t > 600000) buckets.delete(k);
  }
  const tm = setInterval(prune, 60000);
  if (tm.unref) tm.unref();

  // true — можно, false — лимит исчерпан
  function hit(key) {
    const now = Date.now();
    let b = buckets.get(key);
    if (!b) { b = { n: cap, t: now }; buckets.set(key, b); }
    b.n = Math.min(cap, b.n + ((now - b.t) / 1000) * perSec);
    b.t = now;
    if (b.n < 1) return false;
    b.n -= 1;
    return true;
  }
  // через сколько секунд появится ещё один запрос (для Retry-After)
  hit.retryAfter = key => {
    const b = buckets.get(key);
    if (!b) return 1;
    return Math.max(1, Math.ceil((1 - b.n) / perSec));
  };
  return hit;
}

module.exports = { makeLimiter };
