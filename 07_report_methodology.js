const fs = require('fs');
const path = require('path');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const { parse } = require('csv-parse/sync');
const {
  COLORS, drawWrappedText, drawBarChartVertical, drawBarChartHorizontal,
  drawTable, drawCodeBlock, drawBullets, newPage, drawSectionTitle,
} = require('./lib/pdfDraw');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'data');
const DOC_TITLE = 'World Cup 2026 - Methodology & Analysis';

const eda = JSON.parse(fs.readFileSync(path.join(OUT, 'eda_summary.json'), 'utf8'));
const predictions = JSON.parse(fs.readFileSync(path.join(OUT, 'predictions.json'), 'utf8'));
const matchesClean = parse(fs.readFileSync(path.join(OUT, 'matches_clean.csv'), 'utf8'), { columns: true, skip_empty_lines: true });
const trainingSet = parse(fs.readFileSync(path.join(OUT, 'tournament_training_set.csv'), 'utf8'), { columns: true, skip_empty_lines: true });
const wcTournaments = JSON.parse(fs.readFileSync(path.join(OUT, 'wc_tournaments.json'), 'utf8'));

async function main() {
  const doc = await PDFDocument.create();
  doc.setTitle(DOC_TITLE);
  doc.setAuthor('World Cup 2026 Predictor');
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const mono = await doc.embedFont(StandardFonts.Courier);

  const PAGE_W = 595, PAGE_H = 842, MARGIN = 40;
  let pageNum = 1;

  // ================= COVER =================
  const cover = doc.addPage([PAGE_W, PAGE_H]);
  cover.drawRectangle({ x: 0, y: 0, width: PAGE_W, height: PAGE_H, color: COLORS.headerBg });
  cover.drawText('World Cup 2026', { x: MARGIN, y: PAGE_H - 320, size: 30, font: bold, color: COLORS.headerText });
  cover.drawText('Methodology & Analysis', { x: MARGIN, y: PAGE_H - 356, size: 20, font, color: rgb(0.8, 0.82, 0.88) });
  cover.drawLine({ start: { x: MARGIN, y: PAGE_H - 380 }, end: { x: 220, y: PAGE_H - 380 }, thickness: 1.5, color: COLORS.blue });
  const coverDate = new Date().toISOString().slice(0, 10);
  cover.drawText(`Generated ${coverDate}`, { x: MARGIN, y: PAGE_H - 404, size: 10, font, color: rgb(0.65, 0.68, 0.76) });
  const coverLines = [
    'How the win-probability model behind "World Cup 2026 Predictions.pdf" was built:',
    'data sources, cleaning steps, engineered features, exploratory findings,',
    'model selection, validation, and known limitations.',
  ];
  let cy = PAGE_H - 440;
  for (const l of coverLines) { cover.drawText(l, { x: MARGIN, y: cy, size: 11, font, color: rgb(0.75, 0.77, 0.84) }); cy -= 16; }

  // ================= PAGE: DATA SOURCES =================
  let { page, y, width, margin } = newPage(doc, { docTitle: DOC_TITLE, pageNum: ++pageNum, font, boldFont: bold });
  y = drawSectionTitle(page, '1. Data sources and cleaning', { x: margin, y, font: bold });

  const sourceRows = [
    ['results.csv', '49,505', '1872-2026', 'Every international match, tagged by tournament. Primary match database - includes the actual 2026 World Cup through the Round of 16.'],
    ['WorldCups.csv', '20', '1930-2014', 'One row per tournament: winner, runner-up, 3rd/4th, host, goals scored.'],
    ['WorldCupMatches.csv', '852', '1930-2014', 'Per-match detail with stage labels. 3,720 of its rows were entirely blank (a known export artifact) and were discarded.'],
    ['shootouts.csv', '682', '1967-2026', 'Penalty shootout winners - needed because drawn knockout matches (e.g. the 2022 final) do not show a winner in the score alone.'],
    ['former_names.csv', '36', 'various', 'Country rename table (e.g. Dahomey -> Benin), used for name standardization.'],
  ];
  y = drawTable(page, {
    x: margin, y, colWidths: [95, 55, 65, 300],
    headers: ['File', 'Rows used', 'Date range', 'Role in the analysis'],
    rows: sourceRows, font, boldFont: bold, fontSize: 8.5, rowHeight: 22, zebra: true, wrapCols: [3],
  });
  y -= 20;

  y = drawWrappedText(page, 'Team names were inconsistent across files (e.g. "Germany FR" vs "Germany", "USA" vs "United States", scrape artifacts like \'rn">Bosnia and Herzegovina\'). A normalization module maps every historical name to its modern equivalent before any merging happens:', {
    x: margin, y, font, size: 10, maxWidth: width, lineHeight: 14,
  });
  y -= 6;
  y = drawCodeBlock(page, [
    'const MANUAL_ALIASES = {',
    "  'USA': 'United States', 'Germany FR': 'Germany',",
    "  'Korea Republic': 'South Korea', 'IR Iran': 'Iran', ...",
    '};',
    'function normalizeTeam(name) {',
    '  let n = name.trim().replace(/^rn">/, \'\');',
    '  return formerNames[n] || MANUAL_ALIASES[n] || n;',
    '}',
  ], { x: margin, y, width, font: mono });

  y = drawWrappedText(page, `Four rows in results.csv had missing scores and were dropped; the four unplayed 2026 quarterfinals were separated out as the prediction target rather than treated as missing data. Drawn knockout matches were resolved against shootouts.csv rather than assumed - this caught a real bug during development, where a naive "higher score wins" rule misattributed the 2022 final (a 3-3 draw) to France instead of Argentina, who won it on penalties.`, {
    x: margin, y, font, size: 9.5, maxWidth: width, lineHeight: 13, color: COLORS.muted,
  });

  // ================= PAGE: FEATURE ENGINEERING =================
  ({ page, y, width, margin } = newPage(doc, { docTitle: DOC_TITLE, pageNum: ++pageNum, font, boldFont: bold }));
  y = drawSectionTitle(page, '2. Feature engineering', { x: margin, y, font: bold });
  y = drawWrappedText(page, 'Every feature is computed "as of" a cutoff date using only matches before it, so the same code builds both the live 2026 snapshot and a historical training set (one row per team per tournament, 1930-2022) without leaking future information.', {
    x: margin, y, font, size: 9.5, maxWidth: width, lineHeight: 13, color: COLORS.muted,
  });
  y -= 10;

  y = drawBullets(page, [
    { label: 'Elo rating', text: 'A single continuously-updated strength number, computed match-by-match across the full 1872-2026 history (K=60 for World Cup matches, 40 for qualifiers/continental cups, 20 for friendlies; +60 rating points for the home side unless the match is neutral). Chosen because it compresses recent form, opposition quality, and margin of victory into one comparable number, and it can be updated live as the 2026 tournament itself progresses.' },
    { label: 'Recent form', text: 'Points-per-game and average goal difference over each team\'s last 10 and last 20 matches. Captures short-term momentum that a slow-moving Elo rating can miss.' },
    { label: 'All-time win rate', text: 'Win rate across a team\'s entire prior match history. A stable, long-run baseline to compare against short-term form.' },
    { label: 'World Cup pedigree', text: 'Prior titles, final appearances, top-4 finishes, and total tournament appearances. Included because knockout football is widely believed to reward experience under pressure differently than league form does.' },
    { label: 'Host advantage', text: 'A binary flag for the tournament\'s host nation(s) (USA/Canada/Mexico in 2026). Included as its own feature, separate from Elo\'s match-level home advantage, because hosting confers benefits across an entire tournament (crowd support, no travel, favorable scheduling) that a single-match adjustment does not fully capture.' },
    { label: 'In-tournament form (2026 only)', text: 'Goals, wins and points from the actual 2026 group stage and early knockouts. Not used in historical training (it doesn\'t exist pre-tournament) but folded into current Elo for the live bracket simulation, since it is real signal that a purely pre-tournament model would ignore.' },
  ], { x: margin, y, font, boldFont: bold, size: 9.5, maxWidth: width, lineHeight: 12.5, gap: 10 });

  // ================= PAGE: EDA =================
  ({ page, y, width, margin } = newPage(doc, { docTitle: DOC_TITLE, pageNum: ++pageNum, font, boldFont: bold }));
  y = drawSectionTitle(page, '3. Exploratory findings', { x: margin, y, font: bold });
  y = drawWrappedText(page, `Across ${trainingSet.length} team-tournament records (${wcTournaments.length} tournaments, 1930-2022), three patterns stood out.`, {
    x: margin, y, font, size: 9.5, maxWidth: width, lineHeight: 13, color: COLORS.muted,
  });
  y -= 6;

  const corrFeatures = Object.keys(eda.corrTable);
  const corrVals = corrFeatures.map(f => eda.corrTable[f].reached_top4);
  const order = corrFeatures.map((f, i) => [f, corrVals[i]]).sort((a, b) => b[1] - a[1]);
  y = drawBarChartHorizontal(page, {
    x: margin, y, width, height: 155,
    labels: order.map(o => o[0]), values: order.map(o => o[1]),
    font, boldFont: bold, color: COLORS.blue, maxValue: 0.3,
    title: 'Correlation with reaching the top 4 (Pearson r, n=' + trainingSet.length + ')',
  });

  const chartsTop = y;
  const groupOrder = ['Champion', 'Runner-up', 'Semifinalist (3rd/4th)', 'Eliminated earlier'];
  const yAfterElo = drawBarChartVertical(page, {
    x: margin, y: chartsTop, width: width * 0.55, height: 130,
    labels: groupOrder, values: groupOrder.map(g => eda.groupAverages[g].elo),
    font, boldFont: bold, color: COLORS.green, maxValue: 2000, valueSuffix: '',
    title: 'Avg. pre-tournament Elo by outcome',
  });

  const hostX = margin + width * 0.55 + 20;
  const yAfterHost = drawBarChartVertical(page, {
    x: hostX, y: chartsTop, width: width * 0.45 - 20, height: 130,
    labels: ['Hosts', 'Non-hosts'], values: [eda.host.hostWinRate * 100, eda.host.nonHostWinRate * 100],
    font, boldFont: bold, color: COLORS.amber, maxValue: 30,
    title: 'Host win rate vs. baseline',
  });
  y = Math.min(yAfterElo, yAfterHost) - 14;

  y = drawWrappedText(page, `Host nations have won the tournament ${(eda.host.hostWinRate * 100).toFixed(0)}% of the time vs. just ${(eda.host.nonHostWinRate * 100).toFixed(0)}% for everyone else - the single strongest effect found, larger than any form or rating metric. Tournament pedigree (prior finals/top-4s) correlated with future success roughly 3x more strongly than 10-game recent form, suggesting knockout football rewards a track record under pressure more than being "hot" going in.`, {
    x: margin, y, font, size: 9.5, maxWidth: width, lineHeight: 13, color: COLORS.muted,
  });

  // ================= PAGE: MODEL =================
  ({ page, y, width, margin } = newPage(doc, { docTitle: DOC_TITLE, pageNum: ++pageNum, font, boldFont: bold }));
  y = drawSectionTitle(page, '4. Model choice and validation', { x: margin, y, font: bold });

  y = drawWrappedText(page, 'Directly classifying "which team wins the whole tournament" from 22 historical tournaments gives one positive example per tournament - far too little signal for a classifier. Instead, the problem was split into a large-sample piece and a small-sample cross-check:', {
    x: margin, y, font, size: 9.5, maxWidth: width, lineHeight: 13, color: COLORS.muted,
  });
  y -= 8;

  y = drawBullets(page, [
    { label: 'Pairwise logistic regression', text: `predicts P(team A beats team B) from the Elo gap and a home-advantage flag, trained on ${matchesClean.filter(m => m.home_score !== m.away_score).length.toLocaleString()} decisive historical matches. This is the primary model - the one large enough to trust - and it drives the bracket simulation.` },
    { label: 'Random forest', text: `predicts P(team reaches the semifinal) from the fuller 9-feature set (Elo, form, win rate, pedigree, host flag), trained on ${trainingSet.length} team-tournament rows. Used as a cross-check and for feature-importance analysis, not as the primary probability source, given its much smaller training set.` },
    { label: 'Monte Carlo simulation', text: 'the tournament is not a blind field - it has an actual, already-drawn quarterfinal bracket. The logistic regression\'s win probabilities were used to simulate the remaining QF -> SF -> Final 50,000 times, with the winner tallied each time to get an empirical championship probability per team.' },
  ], { x: margin, y, font, boldFont: bold, size: 9.5, maxWidth: width, lineHeight: 12.5, gap: 10 });

  y -= 4;
  const d = predictions.modelDiagnostics;
  y = drawTable(page, {
    x: margin, y, colWidths: [200, 100, 100, 100],
    headers: ['Model', 'Accuracy', 'Log-loss', 'vs. baseline'],
    rows: [
      ['Logistic regression (match-level)', `${(d.logreg.accuracy * 100).toFixed(1)}%`, d.logreg.logLoss.toFixed(3), `Elo formula alone: ${(d.eloBaseline.accuracy * 100).toFixed(1)}%`],
      ['Random forest (tournament-level)', `${(d.randomForest.accuracy * 100).toFixed(1)}%`, '-', `Majority class: ${(d.randomForest.majorityBaseline * 100).toFixed(1)}%`],
    ],
    font, boldFont: bold, fontSize: 9, rowHeight: 24,
  });
  y -= 16;

  y = drawWrappedText(page, `The fitted logistic regression's Elo coefficient (${d.logreg.coefficients.elo_diff.toFixed(2)}, standardized) landed close to the theoretical slope implied by the Elo formula itself - a useful sanity check that Elo is already reasonably well-calibrated on this dataset, and that the extra fitting is adding a small, genuine improvement (accuracy and log-loss both improved slightly on held-out matches) rather than overfitting noise.`, {
    x: margin, y, font, size: 9.5, maxWidth: width, lineHeight: 13, color: COLORS.muted,
  });
  y -= 4;
  y = drawCodeBlock(page, [
    '// one gradient-descent step, standardized features',
    'const p = sigmoid(w0*eloDiffStd + w1*homeAdvStd + b);',
    'const err = p - actualHomeWin;    // actualHomeWin in {0,1}',
    'gradW[0] += err * eloDiffStd; gradW[1] += err * homeAdvStd;',
  ], { x: margin, y, width, font: mono });

  // ================= PAGE: LIMITATIONS =================
  ({ page, y, width, margin } = newPage(doc, { docTitle: DOC_TITLE, pageNum: ++pageNum, font, boldFont: bold }));
  y = drawSectionTitle(page, '5. Limitations', { x: margin, y, font: bold });

  y = drawBullets(page, [
    { label: 'Small tournament-level sample', text: `The random forest and the "pedigree beats form" finding rest on only ${trainingSet.length} team-tournament rows across ${wcTournaments.length} tournaments - enough to see a pattern, not enough to fully trust its precision. The match-level logistic regression is far better supported (30k+ matches).` },
    { label: 'No squad, injury, or suspension data', text: 'The model has no idea if a team\'s best player is injured or suspended for the quarterfinal. A late injury to a key player can swing a match far more than any historical feature here.' },
    { label: 'Bracket-pairing assumption', text: 'The data doesn\'t explicitly label which quarterfinal winners meet in which semifinal. The simulation assumes the conventional QF1/QF2 and QF3/QF4 pairing; if FIFA\'s actual draw differs, exact numbers would shift slightly (the overall ranking is unlikely to change much).' },
    { label: 'Draw/seeding luck is only partially modeled', text: 'The simulation starts from the real quarterfinal bracket, so luck in reaching that point (who a team avoided or faced in earlier rounds) is baked in rather than separately quantified.' },
    { label: 'Mixed historical eras', text: 'Elo is trained on matches from 1872 to 2026 - a very different sport in different eras. Ratings are internally consistent but the model does not explicitly account for football\'s evolving tactics, fitness levels, or competitiveness over 150 years.' },
    { label: 'Knockout football is genuinely random', text: 'A single deflection, red card, or refereeing decision can decide a one-off match. No amount of historical data removes this - the output is a calibrated probability, not a certainty, and the single best pre-tournament favorite still loses more often than it wins.' },
    { label: 'Neutral-venue assumption', text: 'All remaining 2026 matches were treated as neutral (no team is a co-host among the final 8) - reasonable here, but the model does not otherwise account for travel distance, altitude, or partisan crowds skewed toward one side even at a "neutral" venue.' },
  ], { x: margin, y, font, boldFont: bold, size: 9.5, maxWidth: width, lineHeight: 12.5, gap: 11 });

  const bytes = await doc.save();
  const outPath = path.join(ROOT, 'World Cup 2026 - Methodology & Analysis.pdf');
  fs.writeFileSync(outPath, bytes);
  console.log(`Wrote ${outPath} (${pageNum} pages)`);
}

main().catch(e => { console.error(e); process.exit(1); });
