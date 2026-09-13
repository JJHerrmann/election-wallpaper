// Generates static, individually-crawlable pages for every rated Senate and
// Governor race (senate/<state>/, governor/<state>/, plus a hub index for each
// chamber) from the same live-*.json this pipeline already produces. The main
// index.html is a single-URL JS app -- Google can only ever rank one page for
// it. Real per-race URLs let each state's race independently match its own
// search query ("ohio senate race 2026 polls") instead of everything competing
// for one generic homepage ranking.
//
// Run: node scripts/generate_race_pages.js (also called from fetch_live_data.js
// after each refresh, so these regenerate daily/on-alert alongside live-*.json).

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const ROOT_DIR = path.join(__dirname, '..');
const SITE_URL = 'https://election.rook.works';

const STATE_NAMES = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California',
  CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware', DC: 'District of Columbia',
  FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois',
  IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana',
  ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota',
  MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada',
  NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York',
  NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon',
  PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota',
  TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia',
  WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming',
};

function statusLabel(status) {
  return status.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

const METHODOLOGY_HTML = `
  <h2>How this rating works</h2>
  <p>This rating is a <strong>consensus of published forecaster ratings</strong> (Cook Political
  Report, Sabato's Crystal Ball, Inside Elections, RealClearPolitics, Silver Bulletin, Race to
  the WH, and others), scraped from Wikipedia's own aggregation of those forecasters'
  published calls -- it is not a raw poll average. Forecaster consensus moves more slowly and
  more conservatively than day-to-day polling: it takes a sustained, decisive shift for
  institutional raters to move a race's category, especially in a state with a strong partisan
  lean either way. If the "Latest poll" figure above disagrees with the rating category, that's
  normal, not a data error -- see the live map's methodology note for more on why the two can
  diverge.</p>`;

function footerHtml() {
  return `
  <footer class="site-footer">
    <p>A <a href="https://rook.works">Rookworks</a> project. Data via Wikipedia's aggregated
    forecaster ratings, refreshed daily. <a href="https://dispatch.rook.works">Read the blog</a>
    &middot; <a href="${SITE_URL}/">Back to the live map</a></p>
  </footer>`;
}

function headHtml({ title, description, canonical }) {
  return `<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}" />
<link rel="canonical" href="${esc(canonical)}" />
<meta name="robots" content="index, follow" />
<meta property="og:type" content="website" />
<meta property="og:url" content="${esc(canonical)}" />
<meta property="og:title" content="${esc(title)}" />
<meta property="og:description" content="${esc(description)}" />
<meta name="twitter:card" content="summary" />
<meta name="twitter:title" content="${esc(title)}" />
<meta name="twitter:description" content="${esc(description)}" />
<meta name="theme-color" content="#0b1220" />
<link rel="stylesheet" href="/content.css" />`;
}

function candidateCardHtml(cand, bestPoll) {
  if (!cand) return '<div class="candidate-card"><div class="name">TBD</div></div>';
  const pct = bestPoll && bestPoll.candidatePcts && cand.party ? bestPoll.candidatePcts[cand.party] : null;
  return `<div class="candidate-card" data-party="${esc(cand.party)}">
    ${cand.imageUrl ? `<img src="${esc(cand.imageUrl)}" alt="${esc(cand.name)}" loading="lazy" />` : ''}
    <div class="name">${esc(cand.name)}</div>
    <div class="party">${esc(cand.party || '?')}${cand.isIncumbent ? ' &middot; Incumbent' : ''}</div>
    ${pct != null ? `<div class="pct">${pct.toFixed(1)}%</div>` : ''}
  </div>`;
}

function renderRacePage(mode, race, allRacesForState) {
  const stateName = STATE_NAMES[race.state] || race.state;
  const modeLabel = mode === 'senate' ? 'Senate' : 'Governor';
  const [c1, c2] = race.candidates || [];
  const vsLine = c1 && c2 ? `${c1.name} vs. ${c2.name}` : 'Full field TBD';
  const title = `${stateName} 2026 ${modeLabel} Race: ${vsLine} — Live Forecast`;

  const pollLine = race.bestPoll
    ? `Latest poll: ${race.bestPoll.leaderParty}+${race.bestPoll.margin} (${race.bestPoll.source}, ${race.bestPoll.date}).`
    : 'No independent poll average available for this race yet.';
  const description = `Live 2026 ${stateName} ${modeLabel.toLowerCase()} race: rated ${statusLabel(race.status)} `
    + `(consensus of ${race.raterCount || 0} published forecaster ratings). ${vsLine}. ${pollLine} Updated daily.`;

  const canonical = `${SITE_URL}/${mode}/${race.state.toLowerCase()}/`;

  const holdPickup = race.incumbentParty && race.leaderParty
    ? (race.leaderParty === race.incumbentParty ? `${race.incumbentParty} hold` : `${race.leaderParty} pickup`)
    : null;

  return `<!doctype html>
<html lang="en">
<head>
${headHtml({ title, description, canonical })}
</head>
<body>
<main>
  <a class="back-link" href="${SITE_URL}/${mode}/">&larr; All 2026 ${modeLabel} races</a>
  <h1>${esc(stateName)} 2026 ${esc(modeLabel)} Race</h1>
  <span class="status-badge fill-${esc(race.status)}">${esc(statusLabel(race.status))}</span>

  <div class="candidates">
    ${candidateCardHtml(c1, race.bestPoll)}
    ${candidateCardHtml(c2, race.bestPoll)}
  </div>

  <div class="detail-box">
    <p>Rated <strong>${esc(statusLabel(race.status))}</strong> &mdash; consensus of ${race.raterCount || 0} published forecaster ratings.</p>
    ${race.incumbentParty ? `<p>Currently held by: <strong>${esc(race.incumbentParty)}</strong>${holdPickup ? ` (projected ${esc(holdPickup)})` : ''}</p>` : ''}
    ${race.bestPoll ? `<p>Latest poll: <strong>${esc(race.bestPoll.leaderParty)}+${esc(race.bestPoll.margin)}</strong> pts &mdash; ${esc(race.bestPoll.source)} (${esc(race.bestPoll.date)})</p>` : ''}
    <p class="dim">Election day: November 3, 2026.</p>
  </div>

  ${METHODOLOGY_HTML}

  <p><a href="${SITE_URL}/?mode=${mode}">See ${esc(stateName)} highlighted on the live interactive map &rarr;</a></p>
</main>
${footerHtml()}
</body>
</html>
`;
}

function renderHubPage(mode, races) {
  const modeLabel = mode === 'senate' ? 'Senate' : 'Governor';
  const rated = races.filter((r) => r.status !== 'no-race').sort((a, b) => (STATE_NAMES[a.state] || a.state).localeCompare(STATE_NAMES[b.state] || b.state));
  const title = `2026 ${modeLabel} Race Ratings — All ${rated.length} States | Live Forecast`;
  const description = `Every rated 2026 US ${modeLabel.toLowerCase()} race, one page per state: candidates, forecaster consensus rating, and latest poll. Updated daily from aggregated forecaster ratings.`;
  const canonical = `${SITE_URL}/${mode}/`;

  const items = rated.map((r) => {
    const stateName = STATE_NAMES[r.state] || r.state;
    return `<li><a href="${SITE_URL}/${mode}/${r.state.toLowerCase()}/">${esc(stateName)}</a><span class="status-badge fill-${esc(r.status)}">${esc(statusLabel(r.status))}</span></li>`;
  }).join('\n    ');

  return `<!doctype html>
<html lang="en">
<head>
${headHtml({ title, description, canonical })}
</head>
<body>
<main>
  <a class="back-link" href="${SITE_URL}/">&larr; Live interactive map</a>
  <h1>2026 ${esc(modeLabel)} Race Ratings</h1>
  <p>All ${rated.length} rated 2026 US ${modeLabel.toLowerCase()} races, from a consensus of published
  forecaster ratings (Cook, Sabato, Inside Elections, Silver Bulletin, and others), refreshed daily.</p>
  <ul class="race-list">
    ${items}
  </ul>
</main>
${footerHtml()}
</body>
</html>
`;
}

function writePage(relPath, html) {
  const fullPath = path.join(ROOT_DIR, relPath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, html);
}

function generateForMode(mode) {
  const data = JSON.parse(fs.readFileSync(path.join(DATA_DIR, `live-${mode}.json`), 'utf8'));
  const rated = data.races.filter((r) => r.status !== 'no-race');
  for (const race of rated) {
    writePage(`${mode}/${race.state.toLowerCase()}/index.html`, renderRacePage(mode, race, rated));
  }
  writePage(`${mode}/index.html`, renderHubPage(mode, data.races));
  return rated.map((r) => `${SITE_URL}/${mode}/${r.state.toLowerCase()}/`);
}

function updateSitemap(urls) {
  const today = new Date().toISOString().slice(0, 10);
  const allUrls = [SITE_URL + '/', `${SITE_URL}/senate/`, `${SITE_URL}/governor/`, ...urls];
  const body = allUrls.map((u) => `  <url>\n    <loc>${esc(u)}</loc>\n    <lastmod>${today}</lastmod>\n    <changefreq>daily</changefreq>\n    <priority>${u === SITE_URL + '/' ? '1.0' : '0.7'}</priority>\n  </url>`).join('\n');
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>\n`;
  fs.writeFileSync(path.join(ROOT_DIR, 'sitemap.xml'), xml);
}

function main() {
  const senateUrls = generateForMode('senate');
  const govUrls = generateForMode('governor');
  updateSitemap([...senateUrls, ...govUrls]);
  console.log(`  generated ${senateUrls.length} senate pages + ${govUrls.length} governor pages, sitemap updated`);
}

if (require.main === module) main();
module.exports = { main };
