const fs = require('fs');
const path = require('path');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const { COLORS, drawWrappedText, drawBarChartVertical, drawTable } = require('./lib/pdfDraw');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'data');
const predictions = JSON.parse(fs.readFileSync(path.join(OUT, 'predictions.json'), 'utf8'));

async function main() {
  const doc = await PDFDocument.create();
  doc.setTitle('World Cup 2026 Predictions');
  doc.setAuthor('World Cup 2026 Predictor');
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  const PAGE_W = 595, PAGE_H = 842, MARGIN = 40;
  const page = doc.addPage([PAGE_W, PAGE_H]);

  // ---- header band ----
  const headerH = 108;
  page.drawRectangle({ x: 0, y: PAGE_H - headerH, width: PAGE_W, height: headerH, color: COLORS.headerBg });
  page.drawText('World Cup 2026 Predictions', { x: MARGIN, y: PAGE_H - 46, size: 24, font: bold, color: COLORS.headerText });
  page.drawText('Who is most likely to win it from here', { x: MARGIN, y: PAGE_H - 68, size: 12, font, color: rgb(0.8, 0.82, 0.88) });
  const dateStr = new Date().toISOString().slice(0, 10);
  page.drawText(`Generated ${dateStr}`, { x: MARGIN, y: PAGE_H - 88, size: 9, font, color: rgb(0.65, 0.68, 0.76) });

  let y = PAGE_H - headerH - 28;

  // ---- context line ----
  y = drawWrappedText(page, 'The tournament has reached the quarterfinal stage. Only the 8 teams still in the draw have a realistic chance of winning; every other team below has already been eliminated.', {
    x: MARGIN, y, font, size: 10.5, maxWidth: PAGE_W - 2 * MARGIN, lineHeight: 14, color: COLORS.muted,
  });
  y -= 16;

  // ---- ranked table ----
  const contenders = predictions.contenders.map(c => ({ team: c.team, status: 'Quarterfinalist', pct: c.p_win_title * 100 }));
  const contenderNames = new Set(contenders.map(c => c.team));
  const eliminatedRanked = predictions.allTeamsRfPretournament
    .filter(r => !contenderNames.has(r.team))
    .sort((a, b) => (b.rf_top4_prob_pretournament ?? 0) - (a.rf_top4_prob_pretournament ?? 0))
    .slice(0, 7)
    .map(r => ({ team: r.team, status: 'Eliminated', pct: 0 }));

  const tableRows = [...contenders, ...eliminatedRanked];

  page.drawText('Ranked by win probability', { x: MARGIN, y, size: 13, font: bold, color: COLORS.ink });
  y -= 22;

  const colWidths = [40, 190, 150, 135];
  y = drawTable(page, {
    x: MARGIN, y, colWidths,
    headers: ['#', 'Team', 'Status', 'Win probability'],
    rows: tableRows.map((r, i) => [String(i + 1), r.team, r.status, r.pct > 0 ? `${r.pct.toFixed(1)}%` : '0.0%']),
    font, boldFont: bold, fontSize: 9.5, rowHeight: 17.5,
  });

  y -= 26;

  // ---- bar chart: top 10 probabilities ----
  const top10 = [...contenders, ...eliminatedRanked].slice(0, 10);
  drawBarChartVertical(page, {
    x: MARGIN, y, width: PAGE_W - 2 * MARGIN, height: 170,
    labels: top10.map(t => t.team), values: top10.map(t => t.pct),
    font, boldFont: bold, color: COLORS.blue, maxValue: 30,
    title: 'Top 10 win probabilities',
  });

  // ---- footer ----
  page.drawLine({ start: { x: MARGIN, y: 46 }, end: { x: PAGE_W - MARGIN, y: 46 }, thickness: 0.5, color: COLORS.rule });
  page.drawText('Based on 50,000 simulated completions of the actual remaining bracket, using a team-strength model fit on 30,000+ historical matches (1872-2026).', {
    x: MARGIN, y: 32, size: 7.5, font, color: COLORS.faint,
  });
  page.drawText('Full methodology: see "World Cup 2026 - Methodology & Analysis.pdf"', { x: MARGIN, y: 20, size: 7.5, font, color: COLORS.faint });

  const bytes = await doc.save();
  const outPath = path.join(ROOT, 'World Cup 2026 Predictions.pdf');
  fs.writeFileSync(outPath, bytes);
  console.log(`Wrote ${outPath}`);
}

main().catch(e => { console.error(e); process.exit(1); });
