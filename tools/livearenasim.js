// Безопасная симуляция Live Arena без Firestore, реальных аккаунтов и онлайн-игроков.
// Запуск: node tools/livearenasim.js
'use strict';
const A = require('../server/arena');
let passed = 0, failed = 0;
function check(label, condition, details='') {
  if (condition) { passed++; console.log('  ✓ '+label); }
  else { failed++; console.error('  ✗ '+label+(details?' — '+details:'')); }
}
const NOW = 1794153600000; // фиксированное время для повторяемых тестов
const DAY = A.dayNum(NOW), SEASON = A.season(NOW);
function seed(dr=1000,dn=0,dw=0) {
  return {rating:1000,srat:0,sid:SEASON,atk:10,atkt:NOW,dr,dn,dw,_ar:{d:DAY}};
}
function run(win, a=seed(), b=seed()) {
  const result=A.scoreDuel({sim_admin:{lv:20},sim_lanky:{lv:18}},win,{sim_admin:a,sim_lanky:b},NOW);
  if(!result)throw new Error('scoreDuel returned null');
  // Имитируем точную форму записи, которую server/duel.js сохраняет в Firestore.
  const saved={};
  for(const id of ['sim_admin','sim_lanky']) saved[id]={
    ...({rating:1000,srat:0,sid:SEASON,atk:10,atkt:NOW}),
    dr:result[id].dr,dn:result[id].dn,dw:result[id].dw,_ar:{d:DAY}
  };
  return {result,saved};
}
console.log('\nNorthfall — изолированная симуляция Live Arena\n');
{
 const {result,saved}=run('sim_admin');
 check('победа: победителю начислен рейтинг',result.sim_admin.dr>1000);
 check('победа: проигравшему рейтинг снижен',result.sim_lanky.dr<1000);
 check('победа: счётчики боёв увеличились у обоих',result.sim_admin.dn===1&&result.sim_lanky.dn===1);
 check('победа: победа записана только победителю',result.sim_admin.dw===1&&result.sim_lanky.dw===0);
 const reload=A.readState(saved.sim_admin,NOW);
 check('перезагрузка: рейтинг победителя сохраняется',reload.dr===result.sim_admin.dr&&reload.dn===1&&reload.dw===1);
}
{
 const {result,saved}=run('sim_lanky');
 check('поражение: рейтинг проигравшего снижен',result.sim_admin.dr<1000);
 check('поражение: победитель получил победу',result.sim_lanky.dw===1);
 check('перезагрузка после поражения: счётчики сохранены',A.readState(saved.sim_admin,NOW).dn===1);
}
{
 const {result,saved}=run('draw');
 check('ничья: рейтинг обоих не изменился',result.sim_admin.dr===1000&&result.sim_lanky.dr===1000);
 check('ничья: бой учтён обоим, побед нет',result.sim_admin.dn===1&&result.sim_lanky.dn===1&&result.sim_admin.dw===0&&result.sim_lanky.dw===0);
 check('перезагрузка после ничьей: состояние сохранено',A.readState(saved.sim_lanky,NOW).dn===1);
}
{
 const {saved}=run('sim_admin',seed(1325,7,5),seed(1180,4,2));
 const next=A.readState(saved.sim_admin,NOW+86400000);
 check('новые сутки: дневной рейтинг сбрасывается штатно',next.dr===1000&&next.dn===0&&next.dw===0);
 const same=A.readState(saved.sim_admin,NOW);
 check('в те же сутки: сохранённый рейтинг не сбрасывается',same.dr!==1000&&same.dn===8&&same.dw===6);
}
{
 const malformed=A.scoreDuel({a:{lv:1},b:{lv:1},c:{lv:1}},'a',{},NOW);
 check('повреждённый бой с тремя участниками не засчитывается',malformed===null);
}
console.log('\n  пройдено: '+passed+', провалено: '+failed+'\n');
process.exit(failed?1:0);
