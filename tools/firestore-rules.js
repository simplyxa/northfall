// Управление правилами Firestore из CI (через Firebase Admin, ключ — FIREBASE_SERVICE_ACCOUNT).
//   node tools/firestore-rules.js show     — имя действующего набора правил (для отката)
//   node tools/firestore-rules.js lock     — запретить ВСЁ клиентам (после переезда данные живут в Neon)
//   node tools/firestore-rules.js restore  — вернуть правила из firestore.rules (откат)
'use strict';
const fs = require('fs'), path = require('path');
const admin = require('../netlify/lib/fb');
(async () => {
  const mode = process.argv[2];
  const sr = admin.securityRules();
  if (mode === 'show') {
    const rs = await sr.getFirestoreRuleset();
    console.log('действует набор правил:', rs.name.split('/').pop(), '| создан', rs.createTime, '| длина', rs.source[0].content.length);
  } else if (mode === 'lock' || mode === 'restore') {
    const src = mode === 'lock'
      ? "rules_version = '2';\nservice cloud.firestore {\n  match /databases/{database}/documents {\n    match /{document=**} { allow read, write: if false; }\n  }\n}\n"
      : fs.readFileSync(path.join(__dirname, '..', 'firestore.rules'), 'utf8');
    const rs = await sr.releaseFirestoreRulesetFromSource(src);
    const cur = await sr.getFirestoreRuleset();
    console.log(mode + ': применён набор', cur.name.split('/').pop(), '| длина', cur.source[0].content.length);
  } else { console.error('режим: show | lock | restore'); process.exit(2); }
  process.exit(0);
})().catch(e => { console.error('ОШИБКА:', e.code || '', e.message); process.exit(1); });
