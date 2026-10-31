const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'data');

const rows = parse(fs.readFileSync(path.join(OUT, 'tournament_training_set.csv'), 'utf8'), {
  columns: true, skip_empty_lines: true, trim: true,
}).map(r => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, ['team'].includes(k) ? v : Number(v)])));

function pearson(xs, ys) {
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0, dx2 = 0, dy2 = 0;
  for (let i = 0; i < n; i++) { const dx = xs[i] - mx, dy = ys[i] - my; num += dx * dy; dx2 += dx * dx; dy2 += dy * dy; }
  return num / Math.sqrt(dx2 * dy2);
}

const FEATURES = ['elo', 'form_ppg_10', 'form_gd_10', 'all_time_win_rate', 'wc_titles', 'wc_finals', 'wc_top4', 'wc_appearances', 'is_host'];
const TARGETS = ['won', 'reached_final', 'reached_top4'];

console.log('='.repeat(70));
console.log('CORRELATION: feature vs tournament outcome (Pearson r, n=' + rows.length + ')');
console.log('='.repeat(70));
const corrTable = {};
for (const f of FEATURES) {
  corrTable[f] = {};
  for (const t of TARGETS) {
    corrTable[f][t] = pearson(rows.map(r => r[f]), rows.map(r => r[t]));
  }
}
console.table(Object.fromEntries(FEATURES.map(f => [f, {
  won: corrTable[f].won.toFixed(3), reached_final: corrTable[f].reached_final.toFixed(3), reached_top4: corrTable[f].reached_top4.toFixed(3),
}])));

// Group averages: champions vs finalists(non-champ) vs top4(non-finalist) vs eliminated-earlier
function groupOf(r) {
  if (r.won) return 'Champion';
  if (r.reached_final) return 'Runner-up';
  if (r.reached_top4) return 'Semifinalist (3rd/4th)';
  return 'Eliminated earlier';
}
const groups = {};
for (const r of rows) {
  const g = groupOf(r);
  if (!groups[g]) groups[g] = [];
  groups[g].push(r);
}
console.log('\n' + '='.repeat(70));
console.log('AVERAGE FEATURE VALUES BY OUTCOME GROUP');
console.log('='.repeat(70));
const groupOrder = ['Champion', 'Runner-up', 'Semifinalist (3rd/4th)', 'Eliminated earlier'];
const groupAverages = {};
for (const g of groupOrder) {
  const rs = groups[g] || [];
  groupAverages[g] = { n: rs.length };
  for (const f of FEATURES) groupAverages[g][f] = rs.length ? rs.reduce((a, r) => a + r[f], 0) / rs.length : 0;
}
console.table(Object.fromEntries(groupOrder.map(g => [g, {
  n: groupAverages[g].n,
  elo: groupAverages[g].elo.toFixed(0),
  form_ppg_10: groupAverages[g].form_ppg_10.toFixed(2),
  all_time_win_rate: groupAverages[g].all_time_win_rate.toFixed(2),
  wc_titles: groupAverages[g].wc_titles.toFixed(2),
  is_host: groupAverages[g].is_host.toFixed(2),
}])));

// Host advantage: base rate check
const hostRows = rows.filter(r => r.is_host === 1);
const nonHostRows = rows.filter(r => r.is_host === 0);
const hostWinRate = hostRows.reduce((a, r) => a + r.won, 0) / hostRows.length;
const nonHostWinRate = nonHostRows.reduce((a, r) => a + r.won, 0) / nonHostRows.length;
const hostTop4Rate = hostRows.reduce((a, r) => a + r.reached_top4, 0) / hostRows.length;
const nonHostTop4Rate = nonHostRows.reduce((a, r) => a + r.reached_top4, 0) / nonHostRows.length;
console.log('\n' + '='.repeat(70));
console.log('HOST NATION ADVANTAGE');
console.log('='.repeat(70));
console.log(`Hosts: ${hostRows.length} team-tournaments | win rate ${(hostWinRate*100).toFixed(1)}% | top-4 rate ${(hostTop4Rate*100).toFixed(1)}%`);
console.log(`Non-hosts: ${nonHostRows.length} team-tournaments | win rate ${(nonHostWinRate*100).toFixed(1)}% | top-4 rate ${(nonHostTop4Rate*100).toFixed(1)}%`);
console.log(`Host teams (${hostRows.map(r=>r.year+' '+r.team).join(', ')})`);

const eda = { corrTable, groupAverages, host: { hostWinRate, nonHostWinRate, hostTop4Rate, nonHostTop4Rate, hostCount: hostRows.length, nonHostCount: nonHostRows.length } };
fs.writeFileSync(path.join(OUT, 'eda_summary.json'), JSON.stringify(eda, null, 2));
console.log('\nWrote data/eda_summary.json');
