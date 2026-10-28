// Election-night live results poller. Reads official state results feeds (see
// results_config.js), normalizes every configured race to one shape, and writes
// data/live-results.json for results.html.
//
//   node scripts/fetch_live_results.js              one pass, write file
//   node scripts/fetch_live_results.js --dry-run    one pass against past elections
//   node scripts/fetch_live_results.js --loop 3 --until 2026-11-04T08:00:00Z --push
//        poll every 3 minutes until the given UTC time, committing + pushing
//        data/live-results.json after each pass that changed it
//
// One failing state never blocks the others: its races are marked status "error"
// with the reason, and the last good numbers for that race are kept.

const fs = require('fs');
const path = require('path');
const { execSync, execFileSync } = require('child_process');
const { ELECTION_DATE, GROUPS, OFFICIAL_PAGES, NO_FEED_REASON, SOURCES, RACES } = require('./results_config');

const REPO_DIR = path.join(__dirname, '..');
const DATA_DIR = path.join(REPO_DIR, 'data');
const OUT_PATH = path.join(DATA_DIR, 'live-results.json');
const USER_AGENT = 'ElectionRookWorks/1.0 (https://election.rook.works; https://github.com/JJHerrmann/election-wallpaper)';

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const argVal = (flag) => { const i = args.indexOf(flag); return i === -1 ? null : args[i + 1]; };

async function getJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json,text/plain,*/*' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
  const text = await res.text();
  return JSON.parse(text.replace(/^﻿/, ''));
}
async function getText(url) {
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
  return (await res.text()).trim();
}

// Clarity's CDN answers Node's built-in fetch with an empty 202 (its bot filter keys
// on the HTTP client, not on anything we send) but serves curl normally. Same honest
// User-Agent either way; this only changes which HTTP client makes the request.
function curlGet(url) {
  return execFileSync('curl', ['-sS', '--fail', '--compressed', '--max-time', '30', '-A', USER_AGENT, url], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}
const curlJson = (url) => JSON.parse(curlGet(url).replace(/^\uFEFF/, ''));

// ---------------------------------------------------------------- party labels
const PARTY_MAP = {
  D: 'D', DEM: 'D', DEMOCRAT: 'D', DEMOCRATIC: 'D', 'DEMOCRATIC PARTY': 'D',
  R: 'R', REP: 'R', REPUBLICAN: 'R', 'REPUBLICAN PARTY': 'R', GOP: 'R',
  L: 'L', LIB: 'L', LIBERTARIAN: 'L', G: 'G', GRE: 'G', GREEN: 'G',
  I: 'I', IND: 'I', INDEPENDENT: 'I', UNA: 'I', UNAFFILIATED: 'I', NPA: 'I',
};
function normParty(raw) {
  if (!raw) return null;
  const k = String(raw).trim().toUpperCase().replace(/\.$/, '');
  return PARTY_MAP[k] || null;
}

// Candidate -> party lookup from the site's own forecast data (Senate/Governor
// candidates, House candidates), used when a feed's party code is missing or
// opaque (Colorado's Clarity feed uses numeric codes).
function knownCandidates() {
  const out = {};
  const add = (key, cands) => {
    for (const c of cands || []) {
      if (!c || !c.name || !c.party) continue;
      (out[key] = out[key] || []).push({ name: c.name, party: normParty(c.party) || c.party });
    }
  };
  for (const mode of ['senate', 'governor', 'house']) {
    try {
      const d = JSON.parse(fs.readFileSync(path.join(DATA_DIR, `live-${mode}.json`), 'utf8'));
      for (const r of d.races || []) {
        const key = mode === 'house' ? `house:${r.id}` : `${mode}:${r.state}`;
        add(key, r.candidates);
      }
    } catch (e) { /* data file missing: no fallback for that chamber */ }
  }
  return out;
}
const lastName = (n) => String(n).replace(/\(.*?\)/g, '').replace(/,?\s+(Jr|Sr|II|III|IV)\.?$/i, '').trim().split(/\s+/).pop().toLowerCase();
function partyFromKnown(known, race, name) {
  const key = race.chamber === 'house' ? `house:${race.id}` : `${race.chamber}:${race.state}`;
  const ln = lastName(name);
  const hit = (known[key] || []).find((c) => lastName(c.name) === ln);
  return hit ? hit.party : null;
}

// Candidate names in some feeds carry "(I)" incumbent marks and "(Rep)" party tags.
function cleanName(n) {
  return String(n || '').replace(/\s*\((I|Rep|Dem|Lib|Grn|Ind|NPA)\)/gi, '').replace(/\s+/g, ' ').trim();
}
function partyFromNameTag(n) {
  const m = /\((Rep|Dem|Lib|Grn|Ind|NPA)\)\s*$/i.exec(String(n || ''));
  return m ? normParty(m[1]) : null;
}

// ---------------------------------------------------------------- adapters
// Each returns an array of contests: { name, candidates:[{name, party, votes}],
// reportingUnits, totalUnits, unitLabel }.

async function loadNcsbe(src) {
  const key = DRY_RUN ? src.dryRun.dateKey : src.dateKey;
  const rows = await getJson(`https://er.ncsbe.gov/enr/${key}/data/results_0.txt`);
  const byContest = new Map();
  for (const r of rows) {
    if (!byContest.has(r.cnm)) {
      byContest.set(r.cnm, { name: r.cnm, candidates: [], reportingUnits: +r.prt || 0, totalUnits: +r.ptl || 0, unitLabel: 'precincts' });
    }
    byContest.get(r.cnm).candidates.push({ name: r.bnm, party: normParty(r.pty), votes: +r.vct || 0 });
  }
  return [...byContest.values()];
}

async function enhancedVotingElectionId(src) {
  if (DRY_RUN) return src.dryRun.electionId;
  const j = await getJson(`${src.host}/results/public/api/jurisdictions/${encodeURIComponent(src.jurisdiction)}`);
  const general = (j.elections || []).filter((e) => e.electionDate === ELECTION_DATE);
  const pick = general.find((e) => /general/i.test(JSON.stringify(e.name))) || general[0];
  if (!pick) throw new Error(`${src.jurisdiction} has not posted its ${ELECTION_DATE} election yet`);
  return pick.publicElectionId;
}
async function loadEnhancedVoting(src) {
  const id = await enhancedVotingElectionId(src);
  const d = await getJson(`${src.host}/results/public/api/elections/${encodeURIComponent(src.jurisdiction)}/${encodeURIComponent(id)}/data`);
  const en = (arr) => (Array.isArray(arr) ? (arr.find((n) => n.languageId === 'en') || arr[0] || {}).text : arr) || '';
  return (d.ballotItems || []).map((it) => ({
    name: en(it.name),
    candidates: ((it.summaryResults && it.summaryResults.ballotOptions) || []).map((o) => ({
      name: cleanName(en(o.name)),
      party: normParty(o.party && (o.party.abbreviation || en(o.party.name))) || partyFromNameTag(en(o.name)),
      votes: +o.voteCount || 0,
      winner: !!o.isWinner,
    })),
    reportingUnits: it.reportingStatus ? +it.reportingStatus.reportingUnits || 0 : 0,
    totalUnits: it.reportingStatus ? +it.reportingStatus.totalUnits || 0 : 0,
    unitLabel: src.jurisdiction === 'Georgia' ? 'counties' : 'localities',
  }));
}

async function clarityEid(src) {
  if (DRY_RUN) return src.dryRun.eid;
  const list = curlJson(`https://results.enr.clarityelections.com/${src.state}/elections.json`);
  const [y, m, d] = ELECTION_DATE.split('-').map(Number);
  const want = `${m}/${d}/${y}`;
  const hits = list.filter((e) => String(e.Date || '').startsWith(want) && !e.County);
  const pick = hits.find((e) => /general/i.test(e.ElectionName)) || hits[0];
  if (!pick) throw new Error(`${src.state} has not posted its ${ELECTION_DATE} election yet`);
  return pick.EID;
}
async function loadClarity(src) {
  const eid = await clarityEid(src);
  const base = `https://results.enr.clarityelections.com/${src.state}/${eid}`;
  const ver = curlGet(`${base}/current_ver.txt`).trim();
  if (!/^\d+$/.test(ver)) throw new Error(`${src.state} returned an unexpected version marker`);
  const rows = curlJson(`${base}/${ver}/json/en/summary.json`);
  return rows.map((c) => ({
    name: c.C,
    candidates: (c.CH || []).map((nm, i) => ({
      name: cleanName(nm), party: normParty((c.P || [])[i]), votes: +((c.V || [])[i]) || 0, winner: !!((c.W || [])[i]),
    })),
    reportingUnits: +c.PR || 0,
    totalUnits: +c.TP || 0,
    unitLabel: 'counties', // IA (99) and CO (64) report by county
  }));
}

const ADAPTERS = { ncsbe: loadNcsbe, enhancedvoting: loadEnhancedVoting, clarity: loadClarity };

// ---------------------------------------------------------------- normalize
function buildRace(race, contests, known) {
  const re = DRY_RUN && race.dryRunMatch ? race.dryRunMatch : race.match;
  const hits = contests.filter((c) => re.test(c.name));
  if (hits.length !== 1) {
    return { status: hits.length ? 'error' : 'waiting', note: hits.length ? `matched ${hits.length} contests` : 'contest not posted yet' };
  }
  const c = hits[0];
  const total = c.candidates.reduce((s, x) => s + x.votes, 0);
  const candidates = c.candidates
    .filter((x) => !/^write-?in/i.test(x.name) || x.votes > 0)
    .map((x) => {
      const party = (x.party === 'D' || x.party === 'R') ? x.party : (partyFromKnown(known, race, x.name) || x.party);
      return { name: x.name, party: party || null, votes: x.votes, pct: total ? Math.round(1000 * x.votes / total) / 10 : 0, winner: !!x.winner };
    })
    .sort((a, b) => b.votes - a.votes);
  const reportingPct = c.totalUnits ? Math.round(1000 * c.reportingUnits / c.totalUnits) / 10 : null;
  return {
    status: total > 0 ? 'live' : 'waiting',
    contestName: c.name,
    candidates,
    totalVotes: total,
    reporting: { units: c.reportingUnits, total: c.totalUnits, label: c.unitLabel, pct: reportingPct },
  };
}

function loadPrevious() {
  try { return JSON.parse(fs.readFileSync(OUT_PATH, 'utf8')); } catch (e) { return null; }
}

async function runOnce() {
  const known = knownCandidates();
  const prev = loadPrevious();
  // Only carry numbers forward from a previous file of the same kind: never let a
  // dry run's past-election data stand in for real results (or vice versa).
  const prevUsable = prev && !!prev.dryRun === DRY_RUN && prev.electionDate === ELECTION_DATE;
  const prevById = Object.fromEntries(((prevUsable && prev.races) || []).map((r) => [r.id, r]));

  const neededSources = [...new Set(RACES.map((r) => r.feed).filter(Boolean))];
  const contestsBySource = {};
  const sourceErrors = {};
  await Promise.all(neededSources.map(async (key) => {
    const src = SOURCES[key];
    try {
      contestsBySource[key] = await ADAPTERS[src.type](src);
    } catch (err) {
      sourceErrors[key] = err.message;
    }
  }));

  const now = new Date().toISOString();
  const races = RACES.map((race) => {
    const base = {
      id: race.id, label: race.label, state: race.state, chamber: race.chamber, groups: race.groups,
      officialUrl: OFFICIAL_PAGES[race.state] || null,
    };
    if (!race.feed) return { ...base, status: 'no-feed', note: NO_FEED_REASON[race.state] || 'No live state feed' };
    if (sourceErrors[race.feed]) {
      const waitingish = /not posted/.test(sourceErrors[race.feed]);
      const old = prevById[race.id];
      // A feed that errors mid-count: keep the last good numbers, flagged stale.
      if (!waitingish && old && old.candidates && old.totalVotes > 0) {
        return { ...old, ...base, status: 'stale', note: sourceErrors[race.feed], checkedAt: now };
      }
      return { ...base, status: waitingish ? 'waiting' : 'error', note: sourceErrors[race.feed], checkedAt: now };
    }
    const built = buildRace(race, contestsBySource[race.feed], known);
    const old = prevById[race.id];
    const changed = !old || JSON.stringify(old.candidates) !== JSON.stringify(built.candidates) ||
      JSON.stringify(old.reporting) !== JSON.stringify(built.reporting);
    return { ...base, ...built, checkedAt: now, changedAt: changed ? now : (old && old.changedAt) || now };
  });

  const out = {
    updatedAt: now,
    electionDate: ELECTION_DATE,
    dryRun: DRY_RUN || undefined,
    groups: GROUPS,
    races,
    sources: Object.fromEntries(neededSources.map((k) => [k, sourceErrors[k] ? { ok: false, error: sourceErrors[k] } : { ok: true }])),
    note: 'Unofficial results from official state election feeds. Not race calls.',
  };
  fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 2));

  const tally = races.reduce((m, r) => ((m[r.status] = (m[r.status] || 0) + 1), m), {});
  console.log(`[${now}] races: ${JSON.stringify(tally)}${Object.keys(sourceErrors).length ? ' | source errors: ' + JSON.stringify(sourceErrors) : ''}`);
  return out;
}

function pushResults() {
  try {
    execSync('git add data/live-results.json', { cwd: REPO_DIR, stdio: 'pipe' });
    try { execSync('git diff --cached --quiet', { cwd: REPO_DIR, stdio: 'pipe' }); console.log('  (no change)'); return; } catch (e) { /* staged changes: continue */ }
    execSync(`git commit -m "results: live update ${new Date().toISOString()}"`, { cwd: REPO_DIR, stdio: 'pipe' });
    execSync('git pull --rebase --autostash', { cwd: REPO_DIR, stdio: 'pipe' });
    execSync('git push', { cwd: REPO_DIR, stdio: 'pipe' });
    console.log('  pushed');
  } catch (err) {
    console.error('  WARNING: push failed:', err.message.split('\n')[0]);
  }
}

async function main() {
  const loopMin = argVal('--loop');
  const doPush = args.includes('--push');
  if (!loopMin) {
    await runOnce();
    if (doPush) pushResults();
    return;
  }
  // --until: hard stop (UTC ISO). --max-minutes: stop after this long (keeps one
  // GitHub Actions job under its 6-hour limit). --push-every: minimum minutes
  // between pushes (GitHub Pages branch builds have a soft limit of ~10/hour).
  let until = argVal('--until') ? Date.parse(argVal('--until')) : Date.now() + 6 * 3600e3;
  if (argVal('--max-minutes')) until = Math.min(until, Date.now() + Number(argVal('--max-minutes')) * 60e3);
  const everyMs = Math.max(1, Number(loopMin)) * 60e3;
  const pushEveryMs = Number(argVal('--push-every') || loopMin) * 60e3;
  let lastPush = 0;
  if (Date.now() >= until) { console.log('past --until; nothing to do'); return; }
  while (Date.now() < until) {
    const started = Date.now();
    try {
      await runOnce();
      if (doPush && Date.now() - lastPush >= pushEveryMs - 15e3) { pushResults(); lastPush = Date.now(); }
    } catch (err) { console.error('pass failed:', err.message); }
    const wait = everyMs - (Date.now() - started);
    if (Date.now() + wait >= until) break;
    await new Promise((r) => setTimeout(r, Math.max(wait, 5000)));
  }
  console.log('loop finished');
}

main().catch((err) => { console.error(err); process.exit(1); });
