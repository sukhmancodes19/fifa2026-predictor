const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');
const { RandomForestClassifier } = require('ml-random-forest');
const { computeElo } = require('./lib/elo');
const { trainLogReg, sigmoid } = require('./lib/logreg');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'data');

function loadCsv(name, root = OUT) {
  return parse(fs.readFileSync(path.join(root, name), 'utf8'), { columns: true, skip_empty_lines: true, trim: true });
}

// ============================================================
// PART A -- pairwise match model: P(team A beats team B)
// Trained on every decisive (non-drawn) historical match. This is what
// drives the bracket simulation, since knockout matches always produce
// a winner (draws go to penalties).
// ============================================================
const rawMatches = loadCsv('matches_clean.csv').map(r => ({
  ...r, home_score: Number(r.home_score), away_score: Number(r.away_score),
  is_world_cup: r.is_world_cup === 'true', neutral: r.neutral === 'true', year: Number(r.year),
})).sort((a, b) => a.date.localeCompare(b.date));

const { ratings: currentElo, matchesWithElo } = computeElo(rawMatches);

const decisive = matchesWithElo.filter(m => m.home_score !== m.away_score);
const X = decisive.map(m => [m.home_elo_pre - m.away_elo_pre, m.neutral ? 0 : 1]);
const y = decisive.map(m => (m.home_score > m.away_score ? 1 : 0));

// 80/20 chronological-agnostic random split
const idx = [...X.keys()];
for (let i = idx.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1));[idx[i], idx[j]] = [idx[j], idx[i]]; }
const splitAt = Math.floor(idx.length * 0.8);
const trainIdx = idx.slice(0, splitAt), testIdx = idx.slice(splitAt);
const Xtrain = trainIdx.map(i => X[i]), ytrain = trainIdx.map(i => y[i]);
const Xtest = testIdx.map(i => X[i]), ytest = testIdx.map(i => y[i]);

console.log('='.repeat(70));
console.log('PART A: pairwise match-outcome logistic regression');
console.log('='.repeat(70));
console.log(`Training on ${Xtrain.length} decisive matches, testing on ${Xtest.length}`);

const logreg = trainLogReg(Xtrain, ytrain, { epochs: 500, lr: 0.5 });

function evaluate(predictFn, Xs, ys) {
  let correct = 0, logLoss = 0;
  for (let i = 0; i < Xs.length; i++) {
    const p = Math.min(Math.max(predictFn(Xs[i]), 1e-9), 1 - 1e-9);
    if ((p >= 0.5 ? 1 : 0) === ys[i]) correct++;
    logLoss += -(ys[i] * Math.log(p) + (1 - ys[i]) * Math.log(1 - p));
  }
  return { accuracy: correct / Xs.length, logLoss: logLoss / Xs.length };
}

const logregEval = evaluate(row => logreg.predict(row), Xtest, ytest);
const eloBaselineEval = evaluate(row => 1 / (1 + Math.pow(10, -(row[0] + row[1] * 60) / 400)), Xtest, ytest);

console.log(`Fitted logistic regression -- accuracy: ${(logregEval.accuracy * 100).toFixed(1)}%, log-loss: ${logregEval.logLoss.toFixed(3)}`);
console.log(`Raw Elo formula baseline   -- accuracy: ${(eloBaselineEval.accuracy * 100).toFixed(1)}%, log-loss: ${eloBaselineEval.logLoss.toFixed(3)}`);
console.log(`Standardized coefficients: elo_diff=${logreg.weightsStandardized[0].toFixed(3)}, home_advantage=${logreg.weightsStandardized[1].toFixed(3)}, bias=${logreg.bias.toFixed(3)}`);
console.log(`(theoretical Elo slope on standardized elo_diff would be roughly ${(Math.LN10 / 400 * logreg.std[0]).toFixed(3)} -- close values validate that Elo is already well-calibrated on this data)`);

// ============================================================
// PART B -- random forest on tournament-level data: P(team reaches top 4)
// Cross-check using the richer feature set (pedigree, form, host) rather
// than just Elo, evaluated with permutation importance for explainability.
// ============================================================
console.log('\n' + '='.repeat(70));
console.log('PART B: random forest -- does a team reach the semifinals?');
console.log('='.repeat(70));

const FEATURES = ['elo', 'form_ppg_10', 'form_gd_10', 'all_time_win_rate', 'wc_titles', 'wc_finals', 'wc_top4', 'wc_appearances', 'is_host'];
const trainingRows = loadCsv('tournament_training_set.csv').map(r => {
  const row = {};
  for (const k of Object.keys(r)) row[k] = ['team'].includes(k) ? r[k] : Number(r[k]);
  return row;
});

const rfX = trainingRows.map(r => FEATURES.map(f => r[f]));
const rfY = trainingRows.map(r => r.reached_top4);

const rfIdx = [...rfX.keys()];
for (let i = rfIdx.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1));[rfIdx[i], rfIdx[j]] = [rfIdx[j], rfIdx[i]]; }
const rfSplit = Math.floor(rfIdx.length * 0.8);
const rfTrainIdx = rfIdx.slice(0, rfSplit), rfTestIdx = rfIdx.slice(rfSplit);

const rf = new RandomForestClassifier({ seed: 42, maxFeatures: 0.7, replacement: true, nEstimators: 300 });
rf.train(rfTrainIdx.map(i => rfX[i]), rfTrainIdx.map(i => rfY[i]));

const rfTestX = rfTestIdx.map(i => rfX[i]);
const rfTestY = rfTestIdx.map(i => rfY[i]);
const rfPreds = rf.predict(rfTestX);
const rfAcc = rfPreds.reduce((a, p, i) => a + (p === rfTestY[i] ? 1 : 0), 0) / rfPreds.length;
const majorityBaseline = 1 - rfTestY.reduce((a, v) => a + v, 0) / rfTestY.length;
console.log(`Test accuracy: ${(rfAcc * 100).toFixed(1)}% (majority-class baseline: ${(majorityBaseline * 100).toFixed(1)}%, n_test=${rfTestY.length})`);

// accuracy is a weak signal on an 18%-positive class -- check whether the
// model actually separates classes by probability, not just hard label
const rfProbs = rf.predictProbability(rfTestX, 1);
const avgProbPos = rfProbs.filter((_, i) => rfTestY[i] === 1).reduce((a, b) => a + b, 0) / Math.max(1, rfTestY.filter(v => v === 1).length);
const avgProbNeg = rfProbs.filter((_, i) => rfTestY[i] === 0).reduce((a, b) => a + b, 0) / Math.max(1, rfTestY.filter(v => v === 0).length);
console.log(`Mean predicted P(top4) for actual top-4 teams: ${(avgProbPos * 100).toFixed(1)}% vs actual non-top-4 teams: ${(avgProbNeg * 100).toFixed(1)}% (n_pos=${rfTestY.filter(v=>v===1).length}, n_neg=${rfTestY.filter(v=>v===0).length})`);

// permutation importance: shuffle one feature column at a time, measure accuracy drop
function permutationImportance() {
  const importances = {};
  for (let fi = 0; fi < FEATURES.length; fi++) {
    const shuffled = rfTestX.map(row => [...row]);
    const col = shuffled.map(row => row[fi]);
    for (let i = col.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1));[col[i], col[j]] = [col[j], col[i]]; }
    shuffled.forEach((row, i) => { row[fi] = col[i]; });
    const preds = rf.predict(shuffled);
    const acc = preds.reduce((a, p, i) => a + (p === rfTestY[i] ? 1 : 0), 0) / preds.length;
    importances[FEATURES[fi]] = rfAcc - acc;
  }
  return importances;
}
const importances = permutationImportance();
const rankedImportances = Object.entries(importances).sort((a, b) => b[1] - a[1]);
console.log('\nPermutation importance (accuracy drop when feature is shuffled):');
console.table(Object.fromEntries(rankedImportances.map(([f, v]) => [f, (v * 100).toFixed(2) + 'pp'])));

// ============================================================
// PART C -- apply RF to the full 2026 field (pre-tournament snapshot)
// ============================================================
const teamFeatures2026 = JSON.parse(fs.readFileSync(path.join(OUT, 'team_features_2026.json'), 'utf8'));
const rfPretournament = teamFeatures2026.map(f => ({
  team: f.team,
  rf_top4_prob_pretournament: rf.predictProbability([FEATURES.map(k => f[k])], 1)[0] ?? 0,
}));

// ============================================================
// PART D -- Monte Carlo bracket simulation from the actual quarterfinals
// ============================================================
console.log('\n' + '='.repeat(70));
console.log('PART D: Monte Carlo simulation of the remaining bracket');
console.log('='.repeat(70));

const upcoming = JSON.parse(fs.readFileSync(path.join(OUT, 'upcoming_2026.json'), 'utf8'));
console.log('Quarterfinals (from the actual, already-drawn bracket):', upcoming.map(m => `${m.home_team} v ${m.away_team}`));

// Standard bracket convention: QF1/QF2 winners meet in one semifinal,
// QF3/QF4 winners meet in the other. This pairing isn't explicitly labeled
// in the data, so it's an assumption -- flagged clearly in the writeup.
const qf = upcoming.map(m => [m.home_team, m.away_team]);
const semiPairing = [[0, 1], [2, 3]];

function pWin(teamA, teamB) {
  const eloDiff = (currentElo[teamA] ?? 1500) - (currentElo[teamB] ?? 1500);
  return logreg.predict([eloDiff, 0]); // neutral venue for all remaining matches
}

const N = 50000;
const champCount = {}, finalCount = {}, semiCount = {};
for (const [a, b] of qf) { champCount[a] = 0; champCount[b] = 0; finalCount[a] = 0; finalCount[b] = 0; semiCount[a] = 0; semiCount[b] = 0; }

function playMatch(a, b) {
  return Math.random() < pWin(a, b) ? a : b;
}

for (let sim = 0; sim < N; sim++) {
  const qfWinners = qf.map(([a, b]) => playMatch(a, b));
  qfWinners.forEach(w => semiCount[w]++);
  const semiWinners = semiPairing.map(([i, j]) => playMatch(qfWinners[i], qfWinners[j]));
  semiWinners.forEach(w => finalCount[w]++);
  const champion = playMatch(semiWinners[0], semiWinners[1]);
  champCount[champion]++;
}

const contenders = Object.keys(champCount).map(team => ({
  team,
  currentElo: Math.round(currentElo[team] ?? 1500),
  p_reach_semifinal: semiCount[team] / N,
  p_reach_final: finalCount[team] / N,
  p_win_title: champCount[team] / N,
  rf_top4_prob_pretournament: rfPretournament.find(r => r.team === team)?.rf_top4_prob_pretournament ?? null,
}));
contenders.sort((a, b) => b.p_win_title - a.p_win_title);

console.log(`\nSimulated ${N} completions of the bracket from the quarterfinal stage:\n`);
console.table(contenders.map(c => ({
  team: c.team, elo: c.currentElo,
  'P(reach SF)': (c.p_reach_semifinal * 100).toFixed(1) + '%',
  'P(reach final)': (c.p_reach_final * 100).toFixed(1) + '%',
  'P(win title)': (c.p_win_title * 100).toFixed(1) + '%',
})));

fs.writeFileSync(path.join(OUT, 'predictions.json'), JSON.stringify({
  bracket: { quarterfinals: qf, semiPairingAssumption: 'QF1/QF2 winners meet; QF3/QF4 winners meet' },
  simulations: N,
  contenders,
  allTeamsRfPretournament: rfPretournament.sort((a, b) => (b.rf_top4_prob_pretournament ?? 0) - (a.rf_top4_prob_pretournament ?? 0)),
  modelDiagnostics: {
    logreg: { ...logregEval, coefficients: { elo_diff: logreg.weightsStandardized[0], home_advantage: logreg.weightsStandardized[1], bias: logreg.bias } },
    eloBaseline: eloBaselineEval,
    randomForest: { accuracy: rfAcc, majorityBaseline, permutationImportance: importances },
  },
}, null, 2));
console.log('\nWrote data/predictions.json');
