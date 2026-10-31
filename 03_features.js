const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');
const { computeElo } = require('./lib/elo');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'data');

const HOSTS_2026 = ['United States', 'Canada', 'Mexico'];

const rawMatches = parse(fs.readFileSync(path.join(OUT, 'matches_clean.csv'), 'utf8'), {
  columns: true, skip_empty_lines: true, trim: true,
}).map(r => ({
  ...r,
  home_score: Number(r.home_score),
  away_score: Number(r.away_score),
  is_world_cup: r.is_world_cup === 'true',
  neutral: r.neutral === 'true',
  year: Number(r.year),
})).sort((a, b) => a.date.localeCompare(b.date));

const tournaments = JSON.parse(fs.readFileSync(path.join(OUT, 'wc_tournaments.json'), 'utf8'));

function outcomeFor(team, m) {
  const isHome = m.home_team === team;
  const gf = isHome ? m.home_score : m.away_score;
  const ga = isHome ? m.away_score : m.home_score;
  const pts = gf > ga ? 3 : (gf === ga ? 1 : 0);
  return { gf, ga, pts };
}

// Compute the full feature set for every team, "as of" a given cutoff date
// (exclusive) -- i.e. using only matches strictly before the tournament in
// question started. This is what lets us build both (a) a historical
// training set of "pre-tournament strength -> how far did they go" and
// (b) the live snapshot for 2026.
function buildFeatures(cutoffDate, hostTeams) {
  const before = rawMatches.filter(m => m.date < cutoffDate);
  const elo = computeElo(before).ratings;

  const byTeam = new Map();
  for (const m of before) {
    for (const team of [m.home_team, m.away_team]) {
      if (!byTeam.has(team)) byTeam.set(team, []);
      byTeam.get(team).push(m);
    }
  }

  const priorTournaments = tournaments.filter(t => t.year < Number(cutoffDate.slice(0, 4)));

  const features = new Map();
  for (const [team, teamMatches] of byTeam) {
    const sorted = [...teamMatches].sort((a, b) => a.date.localeCompare(b.date));
    const last10 = sorted.slice(-10);
    const last20 = sorted.slice(-20);

    const agg = arr => {
      let pts = 0, gf = 0, ga = 0;
      for (const m of arr) { const o = outcomeFor(team, m); pts += o.pts; gf += o.gf; ga += o.ga; }
      return { ppg: arr.length ? pts / arr.length / 3 : 0, gdAvg: arr.length ? (gf - ga) / arr.length : 0 };
    };
    const form10 = agg(last10);
    const form20 = agg(last20);

    let W = 0, D = 0, L = 0;
    for (const m of sorted) { const o = outcomeFor(team, m); if (o.pts === 3) W++; else if (o.pts === 1) D++; else L++; }
    const allTimeWinRate = sorted.length ? W / sorted.length : 0;

    const titles = priorTournaments.filter(t => t.winner === team).length;
    const finals = priorTournaments.filter(t => t.winner === team || t.runnerUp === team).length;
    const top4 = priorTournaments.filter(t => [t.winner, t.runnerUp, t.third, t.fourth].includes(team)).length;
    const appearances = new Set(sorted.filter(m => m.is_world_cup).map(m => m.year)).size;

    features.set(team, {
      team,
      elo: elo[team] ?? 1500,
      form_ppg_10: form10.ppg,
      form_gd_10: form10.gdAvg,
      form_ppg_20: form20.ppg,
      all_time_win_rate: allTimeWinRate,
      matches_played_total: sorted.length,
      wc_titles: titles,
      wc_finals: finals,
      wc_top4: top4,
      wc_appearances: appearances,
      is_host: hostTeams.includes(team) ? 1 : 0,
    });
  }
  return features;
}

// ---------- A) Live snapshot for 2026 (cutoff = actual kickoff date) ----------
const CUTOFF_2026 = '2026-06-11';
const snapshot2026 = buildFeatures(CUTOFF_2026, HOSTS_2026);

// current in-tournament form: how each team has actually played in the 2026
// WC group stage + knockouts so far (real signal, not available pre-tournament)
const wc2026Matches = rawMatches.filter(m => m.is_world_cup && m.year === 2026);
const inTournamentForm = new Map();
for (const m of wc2026Matches) {
  for (const team of [m.home_team, m.away_team]) {
    if (!inTournamentForm.has(team)) inTournamentForm.set(team, { played: 0, pts: 0, gf: 0, ga: 0 });
    const o = outcomeFor(team, m);
    const acc = inTournamentForm.get(team);
    acc.played++; acc.pts += o.pts; acc.gf += o.gf; acc.ga += o.ga;
  }
}

const teams2026 = [...new Set(wc2026Matches.flatMap(m => [m.home_team, m.away_team]))].sort();
const featureRows2026 = teams2026.map(team => {
  const f = snapshot2026.get(team) || { team, elo: 1500, form_ppg_10: 0, form_gd_10: 0, form_ppg_20: 0, all_time_win_rate: 0, matches_played_total: 0, wc_titles: 0, wc_finals: 0, wc_top4: 0, wc_appearances: 0, is_host: HOSTS_2026.includes(team) ? 1 : 0 };
  const cur = inTournamentForm.get(team) || { played: 0, pts: 0, gf: 0, ga: 0 };
  return {
    ...f,
    wc2026_played: cur.played,
    wc2026_ppg: cur.played ? cur.pts / cur.played / 3 : 0,
    wc2026_goal_diff: cur.gf - cur.ga,
    wc2026_goals_for: cur.gf,
    wc2026_goals_against: cur.ga,
  };
});
featureRows2026.sort((a, b) => b.elo - a.elo);

fs.writeFileSync(path.join(OUT, 'team_features_2026.json'), JSON.stringify(featureRows2026, null, 2));
console.log(`Wrote features for ${featureRows2026.length} teams (2026 field) to data/team_features_2026.json`);
console.log('\nTop 10 by pre-tournament Elo:');
console.table(featureRows2026.slice(0, 10).map(f => ({ team: f.team, elo: Math.round(f.elo), form_ppg_10: f.form_ppg_10.toFixed(2), wc_titles: f.wc_titles, is_host: f.is_host })));

// ---------- B) Historical training set: one row per (year, team) 1930-2022 ----------
const trainingRows = [];
for (const t of tournaments) {
  const cutoff = `${t.year}-01-01`; // conservative: "start of tournament year" as pre-tournament cutoff
  const hostsForYear = t.hosts;
  const feats = buildFeatures(cutoff, hostsForYear);
  const participants = [...new Set(
    rawMatches.filter(m => m.is_world_cup && m.year === t.year).flatMap(m => [m.home_team, m.away_team])
  )];
  for (const team of participants) {
    const f = feats.get(team);
    if (!f) continue; // team with zero prior history (rare, e.g. debut nations) -- skip, can't feature them
    trainingRows.push({
      year: t.year,
      ...f,
      won: t.winner === team ? 1 : 0,
      reached_final: (t.winner === team || t.runnerUp === team) ? 1 : 0,
      reached_top4: [t.winner, t.runnerUp, t.third, t.fourth].includes(team) ? 1 : 0,
    });
  }
}
console.log(`\nBuilt historical training set: ${trainingRows.length} team-tournament rows across ${tournaments.length} tournaments`);

function toCsv(rows, cols) {
  return [cols.join(','), ...rows.map(r => cols.map(c => r[c]).join(','))].join('\n');
}
const cols = ['year','team','elo','form_ppg_10','form_gd_10','form_ppg_20','all_time_win_rate','matches_played_total','wc_titles','wc_finals','wc_top4','wc_appearances','is_host','won','reached_final','reached_top4'];
fs.writeFileSync(path.join(OUT, 'tournament_training_set.csv'), toCsv(trainingRows, cols));
console.log('Wrote data/tournament_training_set.csv');
