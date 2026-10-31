const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');
const { buildNormalizer } = require('./lib/teamNames');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'data');
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT);

const normalizeTeam = buildNormalizer(ROOT);

function load(name) {
  return parse(fs.readFileSync(path.join(ROOT, name), 'utf8'), {
    columns: true, skip_empty_lines: true, trim: true,
  });
}

// ---------- 1. Clean results.csv into the master match table ----------
const rawResults = load('results.csv');
let dropped = 0;
const matches = [];
for (const r of rawResults) {
  if (r.home_score === '' || r.home_score === 'NA' || r.away_score === '' || r.away_score === 'NA') {
    // includes the 4 rows with genuinely missing scores AND the 4 unplayed
    // 2026 quarterfinals -- both get excluded from the "played matches" table.
    dropped++;
    continue;
  }
  const home_team = normalizeTeam(r.home_team);
  const away_team = normalizeTeam(r.away_team);
  const home_score = Number(r.home_score);
  const away_score = Number(r.away_score);
  matches.push({
    date: r.date,
    year: Number(r.date.slice(0, 4)),
    home_team,
    away_team,
    home_score,
    away_score,
    goal_diff: home_score - away_score,
    outcome: home_score > away_score ? 'H' : (home_score < away_score ? 'A' : 'D'),
    tournament: r.tournament,
    is_world_cup: r.tournament === 'FIFA World Cup',
    is_wc_qualifier: r.tournament === 'FIFA World Cup qualification',
    neutral: r.neutral === 'TRUE',
    city: r.city,
    country: r.country,
  });
}
console.log(`results.csv: ${rawResults.length} rows -> ${matches.length} usable matches (${dropped} dropped: missing/unplayed scores)`);

// unplayed 2026 fixtures, kept separately -- this IS the prediction target
const upcoming2026 = rawResults
  .filter(r => (r.home_score === '' || r.home_score === 'NA') && r.date.startsWith('2026') && r.tournament === 'FIFA World Cup')
  .map(r => ({ date: r.date, home_team: normalizeTeam(r.home_team), away_team: normalizeTeam(r.away_team) }));
console.log(`Unplayed 2026 World Cup fixtures (our prediction target): ${upcoming2026.length}`);
console.log(upcoming2026);

fs.writeFileSync(path.join(OUT, 'matches_clean.csv'),
  toCsv(matches, ['date','year','home_team','away_team','home_score','away_score','goal_diff','outcome','tournament','is_world_cup','is_wc_qualifier','neutral','city','country']));
fs.writeFileSync(path.join(OUT, 'upcoming_2026.json'), JSON.stringify(upcoming2026, null, 2));

// ---------- 2. WorldCups.csv (1930-2014) tournament summary, name-normalized ----------
const rawWcups = load('WorldCups.csv');
const tournaments = rawWcups.map(r => ({
  year: Number(r.Year),
  hosts: normalizeHostField(r.Country),
  winner: normalizeTeam(r.Winner),
  runnerUp: normalizeTeam(r['Runners-Up']),
  third: normalizeTeam(r.Third),
  fourth: normalizeTeam(r.Fourth),
  goalsScored: Number(r.GoalsScored),
  qualifiedTeams: Number(r.QualifiedTeams),
}));

function normalizeHostField(country) {
  // 2002 is the only multi-host entry pre-2026 ("Korea/Japan")
  if (country.includes('/')) return country.split('/').map(c => normalizeTeam(c.trim() === 'Korea' ? 'Korea Republic' : c.trim()));
  return [normalizeTeam(country)];
}

// ---------- 3. Derive 2018 & 2022 tournament results from results.csv ----------
// WorldCups.csv stops at 2014. Rather than hand-type facts, derive them the
// same way a bracket resolves: within a completed WC year, the Final is the
// last-dated match; the match dated just before it (within a few days) is
// the third-place playoff. Knockout draws go to penalties, so consult
// shootouts.csv rather than assuming the higher scorer won (this matters:
// the 2022 final was a 3-3 draw that Argentina won on penalties).
const rawShootouts = load('shootouts.csv');
function resolveWinner(m) {
  if (m.home_score !== m.away_score) {
    return m.home_score > m.away_score
      ? { winner: m.home_team, loser: m.away_team }
      : { winner: m.away_team, loser: m.home_team };
  }
  const so = rawShootouts.find(r => r.date === m.date &&
    normalizeTeam(r.home_team) === m.home_team && normalizeTeam(r.away_team) === m.away_team);
  if (!so) throw new Error(`Drawn knockout match with no shootout record: ${m.date} ${m.home_team} v ${m.away_team}`);
  const winner = normalizeTeam(so.winner);
  const loser = winner === m.home_team ? m.away_team : m.home_team;
  return { winner, loser };
}

for (const year of [2018, 2022]) {
  const yearMatches = matches
    .filter(m => m.is_world_cup && m.year === year)
    .sort((a, b) => a.date.localeCompare(b.date));
  const final = yearMatches[yearMatches.length - 1];
  const thirdPlace = yearMatches[yearMatches.length - 2];
  const { winner, loser: runnerUp } = resolveWinner(final);
  const { winner: third, loser: fourth } = resolveWinner(thirdPlace);
  const hostsByYear = { 2018: ['Russia'], 2022: ['Qatar'] }; // official hosts, not inferable from match data
  tournaments.push({
    year, hosts: hostsByYear[year], winner, runnerUp, third, fourth,
    goalsScored: null, qualifiedTeams: 32,
    derived: true,
  });
  console.log(`Derived ${year}: winner=${winner}, runnerUp=${runnerUp}, third=${third}, fourth=${fourth}`);
}

tournaments.sort((a, b) => a.year - b.year);
fs.writeFileSync(path.join(OUT, 'wc_tournaments.json'), JSON.stringify(tournaments, null, 2));
console.log(`\nWrote ${tournaments.length} tournament summaries (1930-2022) to data/wc_tournaments.json`);

// ---------- helpers ----------
function toCsv(rows, cols) {
  const esc = v => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(','), ...rows.map(r => cols.map(c => esc(r[c])).join(','))].join('\n');
}
