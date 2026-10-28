const admin = require('firebase-admin');
let initErr = null;
if (!admin.apps.length) {
  try {
    const raw = (process.env.FIREBASE_SERVICE_ACCOUNT || '').trim();
    if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT не задан');
    let sa;
    try { sa = JSON.parse(raw); } catch (e) { throw new Error('FIREBASE_SERVICE_ACCOUNT: текст не похож на JSON-файл целиком (проверь, что скопировано от { до })'); }
    if (sa.private_key) sa.private_key = sa.private_key.replace(/\\n/g, '\n');
    if (!sa.client_email || !sa.private_key) throw new Error('FIREBASE_SERVICE_ACCOUNT: нет client_email или private_key');
    admin.initializeApp({ credential: admin.credential.cert(sa) });
  } catch (e) { initErr = e.message; console.error('firebase init:', e.message); }
}
admin.initErr = () => initErr;
module.exports = admin;
