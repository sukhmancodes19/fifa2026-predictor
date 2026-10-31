const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');

const ROOT = path.join(__dirname, '..');

function loadCsv(name) {
  const raw = fs.readFileSync(path.join(ROOT, name), 'utf8');
  return parse(raw, { columns: true, skip_empty_lines: true, trim: true });
}

function inspect(name) {
  const rows = loadCsv(name);
  const cols = rows.length ? Object.keys(rows[0]) : [];
  console.log('='.repeat(70));
  console.log(name);
  console.log('='.repeat(70));
  console.log(`Rows: ${rows.length}`);
  console.log(`Columns (${cols.length}): ${cols.join(', ')}`);

  // missing value counts per column (empty string, null, or literal 'NA')
  const missing = {};
  for (const c of cols) missing[c] = 0;
  for (const row of rows) {
    for (const c of cols) {
      const v = row[c];
      if (v === undefined || v === null || v === '' || v === 'NA' || v === 'N/A') {
        missing[c]++;
      }
    }
  }
  console.log('\nMissing values per column:');
  for (const c of cols) {
    if (missing[c] > 0) console.log(`  ${c}: ${missing[c]} (${(100 * missing[c] / rows.length).toFixed(1)}%)`);
  }
  if (Object.values(missing).every(v => v === 0)) console.log('  (none)');

  console.log('\nSample row:');
  console.log(rows[0]);
  console.log();
  return rows;
}

const wcMatches = inspect('WorldCupMatches.csv');
const wcPlayers = inspect('WorldCupPlayers.csv');
const wcups = inspect('WorldCups.csv');
const results = inspect('results.csv');
const formerNames = inspect('former_names.csv');

// A few extra checks that matter for later steps
console.log('='.repeat(70));
console.log('EXTRA CHECKS');
console.log('='.repeat(70));

// WorldCupMatches has known duplicate/blank rows in the Kaggle version
const blankYear = wcMatches.filter(r => !r.Year || r.Year.trim() === '').length;
console.log(`WorldCupMatches rows with blank Year: ${blankYear}`);

const uniqueYears = [...new Set(wcMatches.map(r => r.Year).filter(Boolean))].sort();
console.log(`WorldCupMatches distinct tournament years: ${uniqueYears.join(', ')}`);

const resultsYears = results.map(r => Number(r.date.slice(0, 4)));
console.log(`results.csv date range: ${Math.min(...resultsYears)} - ${Math.max(...resultsYears)}`);

const tournaments = [...new Set(results.map(r => r.tournament))];
const wcTournamentNames = tournaments.filter(t => /world cup/i.test(t));
console.log(`results.csv tournament labels matching "World Cup": ${JSON.stringify(wcTournamentNames)}`);

console.log(`\nWorldCups.csv Winner value counts:`);
const winnerCounts = {};
for (const r of wcups) winnerCounts[r.Winner] = (winnerCounts[r.Winner] || 0) + 1;
console.log(winnerCounts);
