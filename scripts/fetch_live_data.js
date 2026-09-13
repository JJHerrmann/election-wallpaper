// Pass 2 live-data puller. Sources (all free, no scraping-around-paywalls):
//  - Senate / Governor: Wikipedia's "Predictions" ratings tables (Cook, Inside
//    Elections, Sabato, Race to the WH, RCP, Fox, VoteHub, Silver Bulletin, etc.)
//    on the yearly "2026 United States Senate/gubernatorial elections" articles.
//    These are forecaster RATINGS, not raw polls -- treated and labeled as such.
//  - House: no district-level ratings are practical at state-map resolution, so
//    states are colored by real, current House delegation composition (from the
//    actively-maintained unitedstates/congress-legislators dataset), and the
//    summary card shows the real national generic-ballot polling average scraped
//    from the same Wikipedia article's "Opinion polling" section.
//  - President: no 2026 presidential race exists; left on bundled sample data.
//
// Run: node scripts/fetch_live_data.js
// Writes data/live-senate.json, data/live-governor.json, data/live-house.json.

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const DATA_DIR = path.join(__dirname, '..', 'data');
const REPO_DIR = path.join(__dirname, '..');

// Pushes the refreshed data/ + history-*.json files to the public GitHub Pages site
// (election.rook.works) so it stays in sync with the local wallpaper. Lives here
// rather than in scheduled_refresh.cmd because check_news_alerts.js also calls this
// script directly (not through the .cmd), so this is the one place both the daily
// and news-alert-triggered refreshes actually pass through. Best-effort: a git/network
// failure here must never crash the data fetch itself, since the local wallpaper and
// Lively both depend on this script succeeding regardless of push connectivity.
function pushDataUpdate() {
  try {
    execSync('git add data', { cwd: REPO_DIR, stdio: 'pipe' });
    try {
      execSync('git diff --cached --quiet', { cwd: REPO_DIR, stdio: 'pipe' });
      console.log('  (no data changes to push)');
      return;
    } catch (diffErr) {
      // non-zero exit from `git diff --quiet` means there ARE staged changes -- expected path.
    }
    const stamp = new Date().toISOString();
    execSync(`git commit -m "data: automated refresh ${stamp}"`, { cwd: REPO_DIR, stdio: 'pipe' });
    execSync('git push', { cwd: REPO_DIR, stdio: 'pipe' });
    console.log('  pushed data update to origin');
  } catch (err) {
    console.error('  WARNING: failed to push data update:', err.message);
  }
}

const STATE_TO_USPS = {
  Alabama: 'AL', Alaska: 'AK', Arizona: 'AZ', Arkansas: 'AR', California: 'CA',
  Colorado: 'CO', Connecticut: 'CT', Delaware: 'DE', 'District of Columbia': 'DC',
  Florida: 'FL', Georgia: 'GA', Hawaii: 'HI', Idaho: 'ID', Illinois: 'IL',
  Indiana: 'IN', Iowa: 'IA', Kansas: 'KS', Kentucky: 'KY', Louisiana: 'LA',
  Maine: 'ME', Maryland: 'MD', Massachusetts: 'MA', Michigan: 'MI', Minnesota: 'MN',
  Mississippi: 'MS', Missouri: 'MO', Montana: 'MT', Nebraska: 'NE', Nevada: 'NV',
  'New Hampshire': 'NH', 'New Jersey': 'NJ', 'New Mexico': 'NM', 'New York': 'NY',
  'North Carolina': 'NC', 'North Dakota': 'ND', Ohio: 'OH', Oklahoma: 'OK',
  Oregon: 'OR', Pennsylvania: 'PA', 'Rhode Island': 'RI', 'South Carolina': 'SC',
  'South Dakota': 'SD', Tennessee: 'TN', Texas: 'TX', Utah: 'UT', Vermont: 'VT',
  Virginia: 'VA', Washington: 'WA', 'West Virginia': 'WV', Wisconsin: 'WI',
  Wyoming: 'WY',
};

const USPS_TO_STATE = Object.fromEntries(Object.entries(STATE_TO_USPS).map(([name, usps]) => [usps, name]));

const LEVEL_MAGNITUDE = {
  solid: 3, safe: 3, likely: 2, lean: 1, tilt: 0.5, tossup: 0,
};

async function fetchWikitext(title) {
  const url = `https://en.wikipedia.org/w/api.php?action=query&prop=revisions&titles=${encodeURIComponent(title)}&rvslots=main&rvprop=content&format=json&formatversion=2`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Wikipedia fetch failed for ${title}: HTTP ${res.status}`);
  const data = await res.json();
  const page = data.query.pages[0];
  if (page.missing) throw new Error(`Wikipedia page missing: ${title}`);
  return page.revisions[0].slots.main.content;
}

async function fetchWikitextBatch(titles) {
  // Wikipedia's API accepts up to 50 titles per query for anonymous requests.
  const results = {};
  for (let i = 0; i < titles.length; i += 50) {
    const chunk = titles.slice(i, i + 50);
    const url = `https://en.wikipedia.org/w/api.php?action=query&prop=revisions&titles=${encodeURIComponent(chunk.join('|'))}&rvslots=main&rvprop=content&format=json&formatversion=2`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Wikipedia batch fetch failed: HTTP ${res.status}`);
    const data = await res.json();
    for (const page of data.query.pages) {
      if (page.missing || !page.revisions) continue;
      results[page.title] = page.revisions[0].slots.main.content;
    }
    for (const redirect of data.query.redirects || []) {
      if (results[redirect.to] && !results[redirect.from]) results[redirect.from] = results[redirect.to];
    }
  }
  return results;
}

function extractSection(wikitext, headingRegex) {
  const startMatch = wikitext.match(headingRegex);
  if (!startMatch) throw new Error(`Section not found: ${headingRegex}`);
  const start = startMatch.index + startMatch[0].length;
  const rest = wikitext.slice(start);
  const nextHeading = rest.search(/\n==[^=]/);
  return nextHeading === -1 ? rest : rest.slice(0, nextHeading);
}

function extractStateName(rowBlock) {
  const m = rowBlock.match(/^!\s*\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/m);
  if (!m) return null;
  let name = (m[2] || m[1]).trim();
  name = name.split('<br')[0].trim();
  const articleTitle = m[1].trim();
  return { name, articleTitle };
}

function extractRatings(rowBlock) {
  const ratings = [];
  const re = /\{\{USRaceRating\|([^}|]+)(?:\|([^}|]+))?(?:\|[^}]*)?\}\}/g;
  let m;
  while ((m = re.exec(rowBlock))) {
    const level = m[1].trim().toLowerCase();
    const party = m[2] ? m[2].trim().toUpperCase() : null;
    if (level === 'tossup' || level === 'toss-up') {
      ratings.push({ level: 'tossup', party: null });
    } else if (LEVEL_MAGNITUDE[level] != null && (party === 'D' || party === 'R')) {
      ratings.push({ level, party });
    }
  }
  return ratings;
}

function consensusFromRatings(ratings) {
  if (!ratings.length) return null;
  let sum = 0;
  for (const r of ratings) {
    const mag = LEVEL_MAGNITUDE[r.level] ?? 0;
    sum += r.party === 'R' ? -mag : mag; // tossup has null party, contributes 0
  }
  const avg = sum / ratings.length;
  const absAvg = Math.abs(avg);
  const party = avg >= 0 ? 'D' : 'R';

  let status, leaderParty;
  if (absAvg >= 2.5) { status = `safe-${party.toLowerCase()}`; leaderParty = party; }
  else if (absAvg >= 1.5) { status = `likely-${party.toLowerCase()}`; leaderParty = party; }
  else if (absAvg >= 0.5) { status = `lean-${party.toLowerCase()}`; leaderParty = party; }
  // Below the "lean" bar, split the old flat toss-up bucket into three cosmetic
  // sub-bands so a soft, one-sided lean (e.g. every non-tossup rater pointing the
  // same direction, just not strongly enough for any of them to call "Lean") reads
  // differently from a genuine even split -- but keep leaderParty null for all three,
  // same as before, so this never changes what counts as a projected pickup.
  else if (absAvg >= 0.15) { status = `slight-${party.toLowerCase()}`; leaderParty = null; }
  else { status = 'toss-up'; leaderParty = null; }

  return { status, leaderParty, score: avg, raterCount: ratings.length };
}

function extractIncumbentParty(rowBlock) {
  // The incumbent cell is always the first "{{Party shading/X}}" in the row --
  // the later "last election result" cell reuses the same template but comes second.
  const m = rowBlock.match(/\{\{Party shading\/(Republican|Democratic)\}\}/);
  if (!m) return null;
  return m[1] === 'Republican' ? 'R' : 'D';
}

function stripCellAttrs(s) {
  // A table cell can carry a MediaWiki attribute prefix before its content, e.g.
  // `style="text-align: left;" |FiftyPlusOne`. Only strip that specific shape
  // (key="value" pairs before a |) so we don't eat the pipe inside a real
  // [[Foo|Bar]] wikilink, which has no leading attribute syntax.
  return s.replace(/^(?:\s*[a-z-]+\s*=\s*"[^"]*"\s*)+\|/i, '');
}

function cleanWikiText(s) {
  return stripCellAttrs(s)
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/\[\[[^\]|]*\|([^\]]+)\]\]/g, '$1')
    .replace(/\[\[([^\]]+)\]\]/g, '$1')
    .replace(/'''/g, '')
    .replace(/\{\{[^}]*\}\}/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function commonsThumbUrl(filename, widthPx) {
  if (!filename) return null;
  const clean = filename.trim().replace(/^File:/i, '');
  return `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(clean)}?width=${widthPx}`;
}

function parseInfoboxCandidates(wikitext) {
  // The infobox at the top of every individual race article carries the real,
  // disambiguated article title per candidate (nominee1=[[Mike Rogers (Michigan
  // politician)|Mike Rogers]], not just the display name used in polling tables,
  // which matters for name collisions), a raw Commons image filename, and
  // before_election (the actual outgoing officeholder -- a specific person, not
  // just "whichever party holds it") for a genuine incumbency check.
  const infoboxMatch = wikitext.match(/\{\{Infobox election([\s\S]*?)\n\}\}/);
  if (!infoboxMatch) return null;
  const box = infoboxMatch[1];

  const field = (name) => {
    const m = box.match(new RegExp(`\\|\\s*${name}\\s*=\\s*([^\\n]*)`));
    return m ? m[1].trim() : '';
  };

  const beforeElectionRaw = field('before_election');
  const beforeElectionName = cleanWikiText(beforeElectionRaw);

  const candidates = [];
  for (const n of [1, 2]) {
    const nomineeRaw = field(`nominee${n}`) || field(`candidate${n}`);
    if (!nomineeRaw) continue;
    const linkMatch = nomineeRaw.match(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/);
    const articleTitle = linkMatch ? linkMatch[1].trim() : null;
    const name = cleanWikiText(nomineeRaw);
    if (!name) continue;
    const partyRaw = field(`party${n}`);
    const party = /democrat/i.test(partyRaw) ? 'D' : /republican/i.test(partyRaw) ? 'R' : null;
    const imageFilename = field(`image${n}`);
    candidates.push({
      name, articleTitle, party,
      imageUrl: commonsThumbUrl(imageFilename, 80),
      isIncumbent: !!(beforeElectionName && articleTitle && beforeElectionName === name),
    });
  }
  return candidates.length ? candidates : null;
}

function parseBestPoll(wikitextRaw) {
  // Strip "Hypothetical polling" collapsed sections first -- these wrap alternate
  // matchup tables (against candidates who never actually became the nominee, e.g.
  // "Haley Stevens vs. Mike Rogers" polled before the primary was decided) in
  // {{hidden begin|...title=Hypothetical polling...}} ... {{hidden end}}. Without
  // this, a stale hypothetical table can outrank the real current matchup.
  const wikitext = wikitextRaw.replace(
    /\{\{hidden begin\|[^}]*title\s*=\s*Hypothetical polling[^}]*\}\}[\s\S]*?\{\{hidden end\}\}/gi,
    '',
  );

  // Look at every remaining "Aggregate polls" table and keep the one whose header
  // row names both a (D) and an (R) candidate -- the general election matchup, as
  // opposed to a same-party primary table. The heading itself varies by article:
  // bold text ('''Aggregate polls'''), a definition-list term (;Aggregate polls),
  // sometimes with a stray <br /> before the table starts.
  const tableRe = /(?:'''Aggregate polls'''|;Aggregate polls)\s*(?:<br\s*\/?>\s*)?\n?\{\|([\s\S]*?)\n\|\}/g;
  let bestTable = null;
  let m;
  while ((m = tableRe.exec(wikitext))) {
    const body = m[1];
    const headerEnd = body.indexOf('\n|-');
    const header = headerEnd === -1 ? body : body.slice(0, headerEnd);
    const cols = header.split(/\n!/).slice(1);
    const candidates = [];
    for (const col of cols) {
      const partyMatch = col.match(/\(([DR])\)/);
      if (!partyMatch) continue;
      const name = cleanWikiText(col.split('(')[0].replace(/^[^|]*\|/, ''));
      if (name) candidates.push({ name, party: partyMatch[1] });
    }
    const hasD = candidates.some((c) => c.party === 'D');
    const hasR = candidates.some((c) => c.party === 'R');
    if (hasD && hasR) bestTable = { body, candidates };
  }
  if (!bestTable) return null;

  const rows = bestTable.body.split(/\n\|-/).slice(1);
  let best = null;
  for (const row of rows) {
    const cells = row.split(/\n\|/).map((c) => c.trim()).filter((c) => c && !c.startsWith('}'));
    if (cells.length < 5) continue;
    const sourceName = cleanWikiText(cells[0]);
    if (!sourceName || /^colspan/i.test(cells[0])) continue;
    const datesUpdated = cleanWikiText(cells[2] || '');
    const parsedDate = Date.parse(datesUpdated.replace(/–.*$/, '').trim());
    const marginCell = cells[cells.length - 1];
    const marginMatch = marginCell.match(/([A-Za-z .'-]+?)\s*\+(\d+(?:\.\d+)?)%/);
    if (!marginMatch) continue;
    const leaderName = marginMatch[1].trim();
    const leaderCandidate = bestTable.candidates.find((c) => leaderName.includes(c.name.split(' ').pop()));
    // Candidate % columns sit right before "Other/Undecided" and "Margin" (the last
    // two columns), regardless of how many leading source/date columns there were.
    const pctStart = cells.length - 2 - bestTable.candidates.length;
    const candidatePcts = {};
    if (pctStart >= 0) {
      bestTable.candidates.forEach((cand, i) => {
        const pctMatch = (cells[pctStart + i] || '').match(/(\d+(?:\.\d+)?)%/);
        if (pctMatch) candidatePcts[cand.party] = parseFloat(pctMatch[1]);
      });
    }
    const entry = {
      source: sourceName,
      datesUpdated,
      parsedDate: Number.isFinite(parsedDate) ? parsedDate : 0,
      margin: parseFloat(marginMatch[2]),
      leaderParty: leaderCandidate ? leaderCandidate.party : null,
      candidatePcts,
    };
    if (!best || entry.parsedDate > best.parsedDate) best = entry;
  }

  return best
    ? { source: best.source, date: best.datesUpdated, margin: best.margin, leaderParty: best.leaderParty, candidatePcts: best.candidatePcts }
    : null;
}

function parsePredictionsTable(wikitext, sectionHeadingRegex) {
  const section = extractSection(wikitext, sectionHeadingRegex);
  const tableStart = section.indexOf('{|');
  const tableEnd = section.lastIndexOf('|}');
  const table = section.slice(tableStart, tableEnd === -1 ? undefined : tableEnd);
  const rows = table.split(/\n\|-/).slice(1); // first chunk is header setup, drop it

  const results = {};
  for (const row of rows) {
    const stateInfo = extractStateName(row);
    if (!stateInfo) continue;
    const usps = STATE_TO_USPS[stateInfo.name];
    if (!usps) continue;
    const ratings = extractRatings(row);
    const consensus = consensusFromRatings(ratings);
    if (consensus) {
      consensus.incumbentParty = extractIncumbentParty(row);
      consensus.articleTitle = stateInfo.articleTitle;
      results[usps] = consensus;
    }
  }
  return results;
}

function nowIso() { return new Date().toISOString(); }

const HISTORY_MAX_DAYS = 120;

function localDateKey(d = new Date()) {
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function fmtSign(n) { return n > 0 ? `+${n}` : n < 0 ? String(n) : '±0'; }

// Appends (or overwrites, if already run today) one day's sentiment reading so the
// wallpaper can show a momentum bar -- a single signed scalar per mode: net seat swing
// vs. incumbents for Senate/Governor, generic-ballot margin for House. Re-running
// multiple times in one day (e.g. a news-alert-triggered refresh) intentionally
// replaces that day's entry rather than appending a second one, so the trend reflects
// one reading per calendar day, not one per scrape.
function updateHistory(mode, entry) {
  const file = path.join(DATA_DIR, `history-${mode}.json`);
  let history = [];
  try { history = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (err) { /* first run */ }
  const idx = history.findIndex((h) => h.date === entry.date);
  if (idx >= 0) history[idx] = entry; else history.push(entry);
  history.sort((a, b) => a.date.localeCompare(b.date));
  if (history.length > HISTORY_MAX_DAYS) history = history.slice(history.length - HISTORY_MAX_DAYS);
  fs.writeFileSync(file, JSON.stringify(history, null, 2));
}

function extractChamberBaseline(wikitext) {
  // Pulls the real "seats before this election" split straight from the article's own
  // infobox (party1 = Republican, party2 = Democratic by convention on these pages).
  const clean = (s) => parseInt(s.replace(/[^\d]/g, ''), 10);
  const r = wikitext.match(/seats_before1\s*=\s*([^\n|]+)/);
  const d = wikitext.match(/seats_before2\s*=\s*([^\n|]+)/);
  const ind = wikitext.match(/seats_before4\s*=\s*([^\n|]+)/); // independents, if any (Senate)
  if (!r || !d) return null;
  const gop = clean(r[1]);
  let dem = clean(d[1]);
  if (ind) {
    const indCount = clean(ind[1]);
    if (Number.isFinite(indCount)) dem += indCount; // these pages' independents caucus D
  }
  if (!Number.isFinite(gop) || !Number.isFinite(dem)) return null;
  return { gop, dem };
}

function buildRatingMode(mode, ratingsByState, allStates, baseline) {
  const races = allStates.map((usps) => {
    const c = ratingsByState[usps];
    if (!c) {
      return { id: `${usps}-${mode}`, state: usps, status: 'no-race', margin: null, leaderParty: null, incumbentParty: null, pollCount: 0, lastPollDaysAgo: null, dataType: 'rating', raterCount: 0, trend: [] };
    }
    return {
      id: `${usps}-${mode}`, state: usps, status: c.status, margin: null,
      leaderParty: c.leaderParty, incumbentParty: c.incumbentParty, pollCount: 0, lastPollDaysAgo: null,
      dataType: 'rating', raterCount: c.raterCount, trend: [],
      candidates: c.candidates || null, bestPoll: c.bestPoll || null,
    };
  });

  // Net change vs. the party that currently holds each rated seat, not raw win counts --
  // e.g. a seat Safe-R held by a retiring Republican contributes 0 net change, while a
  // seat Likely-D that's currently held by a Republican is a projected D pickup.
  let demHeld = 0, gopHeld = 0; // current composition of just the *rated* seats
  let demNet = 0, gopNet = 0;
  for (const usps of allStates) {
    const c = ratingsByState[usps];
    if (!c || !c.incumbentParty) continue;
    if (c.incumbentParty === 'D') demHeld++; else gopHeld++;
    if (!c.leaderParty || c.leaderParty === c.incumbentParty) continue; // toss-up or hold: no net change
    if (c.leaderParty === 'D') { demNet++; gopNet--; }
    else { gopNet++; demNet--; }
  }

  const demProjected = baseline ? baseline.dem + demNet : null;
  const gopProjected = baseline ? baseline.gop + gopNet : null;
  const control = baseline
    ? (gopProjected > demProjected ? 'Republican' : 'Democratic')
    : (gopNet >= demNet ? 'Republican' : 'Democratic'); // fallback if baseline parse ever fails

  return {
    updatedAt: nowIso(),
    source: 'Wikipedia (aggregated forecaster ratings: Cook, Inside Elections, Sabato, Race to the WH, RCP, Fox, VoteHub, Silver Bulletin, and others)',
    mode,
    summary: {
      demSeatsHeld: demHeld, gopSeatsHeld: gopHeld,
      demNet, gopNet,
      demSeatsBefore: baseline ? baseline.dem : null,
      gopSeatsBefore: baseline ? baseline.gop : null,
      demSeatsProjected: demProjected, gopSeatsProjected: gopProjected,
      control,
      confidence: baseline
        ? `Currently ${baseline.gop} R – ${baseline.dem} D; net change vs. incumbents from consensus forecaster ratings projects ${gopProjected} R – ${demProjected} D`
        : 'net change vs. current incumbent party, from consensus of published forecaster ratings (not raw polling)',
      unit: `${mode === 'governor' ? 'rated governorships' : 'rated seats'} (toss-ups and non-flips count as no net change)`,
    },
    races,
    dataType: 'rating',
  };
}

function extractGenericBallotAverage(houseWikitext) {
  const m = houseWikitext.match(/<section begin="GenericBallotAgg"\/>([\s\S]*?)<section end="GenericBallotAgg"/);
  if (!m) return null;
  const section = m[1];
  const rows = section.split(/\n\|-/).slice(1);
  const avgRow = rows.find((r) => /'''Average'''/.test(r));
  if (!avgRow) return null;
  const cells = avgRow.split(/\n\|/).map((c) => c.trim()).filter(Boolean);
  // cells: [colspan=2 |'''Average''' <- consumed by split oddity, date, R%, D%, other%, margin]
  const repMatch = avgRow.match(/\|(\d+\.\d+)%\s*\n\|\{\{Party shading\/Democratic\}\}/);
  const demMatch = avgRow.match(/\{\{Party shading\/Democratic\}\}\s*\|'''(\d+\.\d+)%'''/);
  const marginMatch = avgRow.match(/'''(Democrats|Republicans) \+(\d+\.\d+)%'''/);
  if (!repMatch || !demMatch || !marginMatch) return null;
  return {
    republicanPct: parseFloat(repMatch[1]),
    democratPct: parseFloat(demMatch[1]),
    marginParty: marginMatch[1] === 'Democrats' ? 'D' : 'R',
    marginPts: parseFloat(marginMatch[2]),
  };
}

function parsePviByDistrict(wikitext) {
  const section = extractSection(wikitext, /== ?By congressional district ?==/);
  const tableStart = section.indexOf('{|');
  const tableEnd = section.lastIndexOf('|}');
  const table = section.slice(tableStart, tableEnd === -1 ? undefined : tableEnd);
  const rows = table.split(/\n\|-/).slice(1);

  const results = {};
  for (const row of rows) {
    const stateMatch = row.match(/\{\{ushr\|([^|}]+)\|([^|}]+)\|X\}\}/);
    if (!stateMatch) continue;
    const usps = STATE_TO_USPS[stateMatch[1].trim()];
    if (!usps) continue;
    const rawDist = stateMatch[2].trim();
    const distNum = /^\d+$/.test(rawDist) ? rawDist.padStart(2, '0') : '00'; // 'AL' (at-large) -> '00'

    const evenMatch = row.match(/\{\{Shading PVI\|EVEN\}\}/);
    const pviMatch = row.match(/\{\{Shading PVI\|([DR])\|(?:value=)?(\d+)\}\}/);
    const partyMatch = row.match(/\{\{Party shading\/Text\/(Republican|Democratic)\}\}/);
    const repParty = partyMatch ? (partyMatch[1] === 'Republican' ? 'R' : 'D') : null;

    if (evenMatch) {
      results[`${usps}-${distNum}`] = { pviParty: null, pviMag: 0, repParty };
    } else if (pviMatch) {
      results[`${usps}-${distNum}`] = { pviParty: pviMatch[1], pviMag: parseInt(pviMatch[2], 10), repParty };
    }
  }
  return results;
}

function statusFromPvi(pviParty, pviMag) {
  if (pviMag === 0 || !pviParty) return { status: 'toss-up', competitive: true };
  let bucket;
  if (pviMag >= 10) bucket = 'safe';
  else if (pviMag >= 6) bucket = 'likely';
  else if (pviMag >= 3) bucket = 'lean';
  else bucket = 'slight'; // PVI magnitude 1-2
  // Wikipedia's own PVI article defines "swing seats" as within +/-5 -- use that
  // as the competitive/safe cutoff rather than an arbitrary threshold of our own.
  const competitive = bucket === 'toss-up' || bucket === 'slight' || bucket === 'lean';
  return { status: `${bucket}-${pviParty.toLowerCase()}`, competitive };
}

function buildHouseDistrictMode(pviByDistrict, genericBallot, allDistrictIds) {
  const races = allDistrictIds.map((id) => {
    const p = pviByDistrict[id];
    if (!p) {
      return { id, status: 'no-race', margin: null, leaderParty: null, incumbentParty: null, dataType: 'pvi', pviMagnitude: null, competitive: false, trend: [] };
    }
    const { status, competitive } = statusFromPvi(p.pviParty, p.pviMag);
    return {
      id, status, margin: null, leaderParty: p.pviParty,
      incumbentParty: p.repParty, dataType: 'pvi',
      pviMagnitude: p.pviMag, competitive, trend: [],
      candidates: p.candidates || null, bestPoll: p.bestPoll || null,
    };
  });

  let dem = 0, gop = 0;
  for (const id of allDistrictIds) {
    const p = pviByDistrict[id];
    if (!p || !p.repParty) continue;
    if (p.repParty === 'D') dem++; else gop++;
  }

  const genericBallotTxt = genericBallot
    ? ` Nationally, the generic-ballot polling average has ${genericBallot.marginParty === 'D' ? 'Democrats' : 'Republicans'} +${genericBallot.marginPts.toFixed(1)} pts (Wikipedia aggregation of DDHQ, FiftyPlusOne, RCP, Silver Bulletin, VoteHub, Race to the WH).`
    : '';

  return {
    updatedAt: nowIso(),
    source: 'Wikipedia (Cook Partisan Voting Index by congressional district, current representative party); district boundaries from U.S. Census Bureau cb_2025_us_cd119_500k',
    mode: 'house',
    summary: {
      demSeats: dem, gopSeats: gop,
      control: gop >= dem ? 'Republican' : 'Democratic',
      confidence: `Shading is each district's real Cook PVI (structural partisan lean, not a poll) — safe districts (|PVI| ≥ 10) render muted, competitive districts render in full color.${genericBallotTxt}`,
      unit: 'current House seats (PVI shading is structural lean, not a forecast)',
      genericBallot: genericBallot || null,
    },
    races,
    dataType: 'pvi',
    granularity: 'district',
  };
}

function extractDistrictSection(wikitext, districtNumInt) {
  const headingRe = new RegExp(`==\\s*District\\s+${districtNumInt}\\s*==`, 'i');
  const m = wikitext.match(headingRe);
  if (!m) return null;
  const start = m.index + m[0].length;
  const rest = wikitext.slice(start);
  const nextHeading = rest.search(/\n==[^=]/);
  return nextHeading === -1 ? rest : rest.slice(0, nextHeading);
}

async function attachHouseCandidates(pviByDistrict, districtIds) {
  // House races live inside per-STATE articles rather than per-race ones. Multi-
  // district states get "...elections in {State}" (plural) with each district's own
  // {{Infobox election}} nested under a "== District N ==" heading; single-district
  // (at-large) states get "...election in {State}" (singular, no plural "s") with the
  // infobox directly at the top, same shape as the Senate/Governor articles.
  const byState = {};
  for (const id of districtIds) {
    const [usps, distNum] = id.split('-');
    (byState[usps] = byState[usps] || []).push(distNum);
  }

  const titleForState = {};
  for (const [usps, districts] of Object.entries(byState)) {
    const stateName = USPS_TO_STATE[usps];
    if (!stateName) continue;
    const plural = districts.length > 1;
    titleForState[usps] = `2026 United States House of Representatives election${plural ? 's' : ''} in ${stateName}`;
  }

  const articles = await fetchWikitextBatch(Object.values(titleForState));

  for (const [usps, districts] of Object.entries(byState)) {
    const wikitext = articles[titleForState[usps]];
    if (!wikitext) continue;
    for (const distNum of districts) {
      const id = `${usps}-${distNum}`;
      const section = distNum === '00' ? wikitext : extractDistrictSection(wikitext, parseInt(distNum, 10));
      if (!section) continue;
      const entry = pviByDistrict[id];
      if (!entry) continue; // no PVI data for this district id; don't attach an orphaned entry
      try { entry.candidates = parseInfoboxCandidates(section); } catch (err) { /* best-effort */ }
      try { entry.bestPoll = parseBestPoll(section); } catch (err) { /* best-effort */ }
    }
  }
}

async function attachCandidatesAndPolls(ratingsByState) {
  const titles = Object.values(ratingsByState).map((c) => c.articleTitle).filter(Boolean);
  if (!titles.length) return;
  const articles = await fetchWikitextBatch(titles);
  for (const c of Object.values(ratingsByState)) {
    const wikitext = c.articleTitle && articles[c.articleTitle];
    if (!wikitext) continue;
    try {
      c.candidates = parseInfoboxCandidates(wikitext);
    } catch (err) { /* best-effort */ }
    try {
      c.bestPoll = parseBestPoll(wikitext);
    } catch (err) { /* best-effort */ }
  }
}

function statusFromMargin(absMargin) {
  if (absMargin >= 15) return 'safe';
  if (absMargin >= 8) return 'likely';
  if (absMargin >= 3) return 'lean';
  return 'toss-up';
}

async function fetchPresident2024Results() {
  const res = await fetch('https://decisionlabs.ai/api/elections/2024');
  if (!res.ok) throw new Error(`Decision Labs elections fetch failed: HTTP ${res.status}`);
  const data = await res.json();

  const races = data.states.map((s) => {
    const usps = s.abbr;
    const absMargin = Math.abs(s.margin);
    const bucket = statusFromMargin(absMargin);
    const party = s.winner_party === 'democrat' ? 'D' : 'R';
    const status = bucket === 'toss-up' ? 'toss-up' : `${bucket}-${party.toLowerCase()}`;
    return {
      id: `${usps}-president`, state: usps, status,
      margin: Math.round(absMargin * 10) / 10, leaderParty: party,
      pollCount: 0, lastPollDaysAgo: null, dataType: 'historical-result',
      priorMargin: s.prior_margin, swing: s.swing, isFlip: s.is_flip,
      trend: [],
    };
  });

  return {
    updatedAt: nowIso(),
    source: '2024 certified presidential election results (via Decision Labs elections API)',
    mode: 'president',
    summary: {
      demSeats: data.national.ev.democrat, gopSeats: data.national.ev.republican,
      control: data.national.winner_party === 'democrat' ? 'Democratic' : 'Republican',
      confidence: `2024 result — most recent presidential election (next is 2028). Popular vote: D ${data.national.popular_vote_pct.democrat}% / R ${data.national.popular_vote_pct.republican}%.`,
      unit: 'electoral votes (2024, historical)',
    },
    races,
    dataType: 'historical-result',
  };
}

async function main() {
  const allStates = Object.values(STATE_TO_USPS).filter((s) => s !== 'DC');

  console.log('Fetching Senate predictions...');
  const senateWikitext = await fetchWikitext('2026 United States Senate elections');
  const senateRatings = parsePredictionsTable(senateWikitext, /== ?Predictions ?==/);
  const senateBaseline = extractChamberBaseline(senateWikitext);
  console.log('  fetching per-race candidate/poll detail...');
  await attachCandidatesAndPolls(senateRatings);
  const senateData = buildRatingMode('senate', senateRatings, allStates, senateBaseline);
  fs.writeFileSync(path.join(DATA_DIR, 'live-senate.json'), JSON.stringify(senateData, null, 2));
  const senateWithCandidates = Object.values(senateRatings).filter((c) => c.candidates).length;
  console.log('  rated states:', Object.keys(senateRatings).length, 'with candidates:', senateWithCandidates, 'baseline:', senateBaseline, 'net D/R:', senateData.summary.demNet, senateData.summary.gopNet);
  updateHistory('senate', {
    date: localDateKey(),
    netScore: senateData.summary.demNet,
    label: `D net ${fmtSign(senateData.summary.demNet)} / R net ${fmtSign(senateData.summary.gopNet)} vs. incumbents`,
  });

  console.log('Fetching Governor predictions...');
  const govWikitext = await fetchWikitext('2026 United States gubernatorial elections');
  const govRatings = parsePredictionsTable(govWikitext, /== ?Predictions ?==/);
  const govBaseline = extractChamberBaseline(govWikitext);
  console.log('  fetching per-race candidate/poll detail...');
  await attachCandidatesAndPolls(govRatings);
  const govData = buildRatingMode('governor', govRatings, allStates, govBaseline);
  fs.writeFileSync(path.join(DATA_DIR, 'live-governor.json'), JSON.stringify(govData, null, 2));
  const govWithCandidates = Object.values(govRatings).filter((c) => c.candidates).length;
  console.log('  rated states:', Object.keys(govRatings).length, 'with candidates:', govWithCandidates, 'baseline:', govBaseline, 'net D/R:', govData.summary.demNet, govData.summary.gopNet);
  updateHistory('governor', {
    date: localDateKey(),
    netScore: govData.summary.demNet,
    label: `D net ${fmtSign(govData.summary.demNet)} / R net ${fmtSign(govData.summary.gopNet)} vs. incumbents`,
  });

  console.log('Fetching House generic ballot + district PVI...');
  const houseWikitext = await fetchWikitext('2026 United States House of Representatives elections');
  const genericBallot = extractGenericBallotAverage(houseWikitext);
  const pviWikitext = await fetchWikitext('Cook Partisan Voting Index');
  const pviByDistrict = parsePviByDistrict(pviWikitext);
  const districtPaths = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'us-districts-paths.json'), 'utf8'));
  const allDistrictIds = districtPaths.districts.map((d) => d.id).filter((id) => !id.startsWith('DC-'));
  console.log('  fetching per-district candidate/poll detail (50 state articles)...');
  await attachHouseCandidates(pviByDistrict, allDistrictIds);
  const houseData = buildHouseDistrictMode(pviByDistrict, genericBallot, allDistrictIds);
  fs.writeFileSync(path.join(DATA_DIR, 'live-house.json'), JSON.stringify(houseData, null, 2));
  const matched = allDistrictIds.filter((id) => pviByDistrict[id]).length;
  const houseWithCandidates = allDistrictIds.filter((id) => pviByDistrict[id] && pviByDistrict[id].candidates).length;
  console.log('  generic ballot:', genericBallot, '| districts matched:', matched, '/', allDistrictIds.length, '| with candidates:', houseWithCandidates);
  if (genericBallot) {
    const signedMargin = genericBallot.marginParty === 'D' ? genericBallot.marginPts : -genericBallot.marginPts;
    updateHistory('house', {
      date: localDateKey(),
      netScore: signedMargin,
      label: `Generic ballot ${genericBallot.marginParty}+${genericBallot.marginPts.toFixed(1)}`,
    });
  }

  console.log('Fetching 2024 presidential results (historical, no 2026 presidential race exists)...');
  const presidentData = await fetchPresident2024Results();
  fs.writeFileSync(path.join(DATA_DIR, 'live-president.json'), JSON.stringify(presidentData, null, 2));
  console.log('  states:', presidentData.races.length, 'EV', presidentData.summary.demSeats, '-', presidentData.summary.gopSeats);

  console.log('Pushing data update to origin (election.rook.works)...');
  pushDataUpdate();

  console.log('Done.');
}

main().catch((err) => { console.error(err); process.exit(1); });
