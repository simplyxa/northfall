const admin = require('firebase-admin');
let initErr = null;

// Читает ключ сервисного аккаунта максимально терпимо: целый JSON, JSON в кавычках,
// base64, «умные» кавычки iPhone, настоящие переносы строк внутри ключа.
function readSA(raw) {
  let s = raw.trim();
  if (!s.startsWith('{') && /^[A-Za-z0-9+/=\s]+$/.test(s)) {
    try { s = Buffer.from(s, 'base64').toString('utf8').trim(); } catch (e) {}
  }
  if ((s.startsWith("'") && s.endsWith("'")) || (s.startsWith('"') && s.endsWith('"') && s[1] === '{')) s = s.slice(1, -1);
  s = s.replace(/[“”„«»″]/g, '"').replace(/[‘’]/g, "'").replace(/ /g, ' ');
  try { return JSON.parse(s); } catch (e) {}
  // запасной путь: достаём нужные поля по отдельности
  const get = (k) => { const m = s.match(new RegExp('"' + k + '"\\s*:\\s*"([^"]*)"')); return m ? m[1] : ''; };
  const pk = s.match(/-----BEGIN PRIVATE KEY-----[\s\S]*?-----END PRIVATE KEY-----/);
  const sa = { project_id: get('project_id'), client_email: get('client_email'), private_key: pk ? pk[0] : '' };
  if (sa.client_email && sa.private_key) return sa;
  const info = 'длина ' + s.length + ', начало «' + s.slice(0, 1) + '», конец «' + s.slice(-1) + '»'
    + (s.includes('BEGIN PRIVATE KEY') ? '' : ', нет BEGIN PRIVATE KEY')
    + (s.includes('END PRIVATE KEY') ? '' : ', нет END PRIVATE KEY')
    + (s.includes('client_email') ? '' : ', нет client_email');
  throw new Error('FIREBASE_SERVICE_ACCOUNT: не удалось прочитать ключ (' + info + ')');
}

if (!admin.apps.length) {
  try {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT || '';
    if (!raw.trim()) throw new Error('FIREBASE_SERVICE_ACCOUNT не задан');
    const sa = readSA(raw);
    sa.private_key = String(sa.private_key || '').replace(/\\n/g, '\n');
    // если переносы строк в ключе потерялись — восстанавливаем формат PEM
    const body = sa.private_key.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, '').replace(/\s+/g, '');
    if (body) sa.private_key = '-----BEGIN PRIVATE KEY-----\n' + body.match(/.{1,64}/g).join('\n') + '\n-----END PRIVATE KEY-----\n';
    if (!sa.client_email || !body) throw new Error('FIREBASE_SERVICE_ACCOUNT: нет client_email или private_key');
    admin.initializeApp({ credential: admin.credential.cert(sa), projectId: sa.project_id || undefined });
  } catch (e) { initErr = e.message; console.error('firebase init:', e.message); }
}
admin.initErr = () => initErr;
module.exports = admin;
