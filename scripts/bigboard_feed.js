// County-level live results for the big board (bigboard.html). Statewide races in
// states whose official feeds publish per-county results and are reachable from
// GitHub's runners: North Carolina (NCSBE per-county files) and Virginia/Georgia
// (Enhanced Voting per-locality API). Writes raw county counts only; the page does
// the swing / outstanding-vote / estimated-finish math against
// data/bigboard-baseline.json so the method is visible in one place.

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const OUT_PATH = path.join(DATA_DIR, 'bigboard.json');

const BIGBOARD_RACES = [
  { id: 'NC-sen', label: 'North Carolina Senate', state: 'NC',
    live: { dateKey: '20261103', match: /^US SENATE\b/i },
    dry: { dateKey: '20241105', match: /^NC GOVERNOR\b/i, label: 'TEST: 2024 NC Governor' } },
  { id: 'VA-sen', label: 'Virginia Senate', state: 'VA',
    live: { match: /^Member, United States Senate$/i },
    dry: { electionId: '2025-November-General', match: /^Governor$/i, label: 'TEST: 2025 VA Governor' } },
  { id: 'GA-sen', label: 'Georgia Senate', state: 'GA',
    live: { match: /^US Senate\b/i },
    dry: { electionId: 'MunicipalGeneralSpecialElectionPSC11042025', match: /^PSC - District 2$/i, label: 'TEST: 2025 GA PSC District 2' } },
  { id: 'GA-gov', label: 'Georgia Governor', state: 'GA',
    live: { match: /^Governor\b/i },
    dry: { electionId: 'MunicipalGeneralSpecialElectionPSC11042025', match: /^PSC - District 3$/i, label: 'TEST: 2025 GA PSC District 3' } },
];

const EV_HOSTS = {
  VA: { host: 'https://enr.elections.virginia.gov', jurisdiction: 'Virginia' },
  GA: { host: 'https://results.sos.ga.gov', jurisdiction: 'Georgia' },
};

const en = (a) => (Array.isArray(a) ? (a.find((x) => x.languageId === 'en') || a[0] || {}).text : a) || '';
const cleanName = (n) => String(n || '').replace(/\s*\((I|Rep|Dem|Lib|Grn|Ind|NPA)\)/gi, '').replace(/\s+/g, ' ').trim();

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < items.length) { const k = i++; try { out[k] = await fn(items[k]); } catch (e) { out[k] = { error: e.message }; } }
  }));
  return out;
}

// helpers is { getJson, normParty, ELECTION_DATE }
async function evElectionId(helpers, st, dryRun, race) {
  if (dryRun) return race.dry.electionId;
  const { host, jurisdiction } = EV_HOSTS[st];
  const j = await helpers.getJson(`${host}/results/public/api/jurisdictions/${jurisdiction}`);
  const general = (j.elections || []).filter((e) => e.electionDate === helpers.ELECTION_DATE);
  const pick = general.find((e) => /general/i.test(JSON.stringify(e.name))) || general[0];
  if (!pick) throw new Error(`${jurisdiction} has not posted its ${helpers.ELECTION_DATE} election yet`);
  return pick.publicElectionId;
}

// Returns { fips: { cands:[{name,party,votes}], u, t } } for every county, per race.
async function countyResultsFor(state, races, geo, helpers, dryRun) {
  const counties = geo[state].counties;
  const byRace = Object.fromEntries(races.map((r) => [r.id, {}]));
  const errors = [];

  if (state === 'NC') {
    const key = dryRun ? races[0].dry.dateKey : races[0].live.dateKey;
    const results = await pool(counties, 8, async (c) => helpers.getJson(`https://er.ncsbe.gov/enr/${key}/data/results_${c.feedId}.txt`));
    counties.forEach((c, i) => {
      const rows = results[i];
      if (!Array.isArray(rows)) { errors.push(`${c.name}: ${rows && rows.error}`); return; }
      for (const race of races) {
        const re = dryRun ? race.dry.match : race.live.match;
        const mine = rows.filter((r) => re.test(r.cnm));
        if (!mine.length) continue;
        byRace[race.id][c.fips] = {
          cands: mine.map((r) => ({ name: r.bnm, party: helpers.normParty(r.pty), votes: +r.vct || 0 })),
          u: +mine[0].prt || 0, t: +mine[0].ptl || 0,
        };
      }
    });
  } else {
    const electionId = await evElectionId(helpers, state, dryRun, races[0]);
    const { host, jurisdiction } = EV_HOSTS[state];
    // Counties sometimes rename a statewide contest (Baldwin County, GA labeled
    // "PSC - District 2" as "PSC - District 2 - Rep"), but each county item carries
    // the statewide item's id as parentId. Resolve the statewide id by name once,
    // then match counties by id, falling back to the name pattern.
    const statewide = await helpers.getJson(`${host}/results/public/api/elections/${jurisdiction}/${encodeURIComponent(electionId)}/data`);
    const stateItemId = {};
    for (const race of races) {
      const re = dryRun ? race.dry.match : race.live.match;
      const hits = (statewide.ballotItems || []).filter((b) => re.test(en(b.name)));
      if (hits.length === 1) stateItemId[race.id] = hits[0].id;
    }
    const results = await pool(counties, 8, async (c) => helpers.getJson(`${host}/results/public/api/elections/${encodeURIComponent(c.feedId)}/${encodeURIComponent(electionId)}/data`));
    counties.forEach((c, i) => {
      const d = results[i];
      if (!d || d.error || !d.ballotItems) { errors.push(`${c.name}: ${(d && d.error) || 'no data'}`); return; }
      for (const race of races) {
        const re = dryRun ? race.dry.match : race.live.match;
        const sid = stateItemId[race.id];
        const it = (sid && d.ballotItems.find((b) => b.parentId === sid || b.id === sid)) || d.ballotItems.find((b) => re.test(en(b.name)));
        if (!it) continue;
        const rs = it.reportingStatus || {};
        byRace[race.id][c.fips] = {
          cands: ((it.summaryResults && it.summaryResults.ballotOptions) || []).map((o) => {
            const raw = en(o.name);
            const tag = /\((Rep|Dem|Lib)\)\s*$/i.exec(raw);
            return { name: cleanName(raw), party: helpers.normParty(o.party && (o.party.abbreviation || en(o.party.name))) || (tag && helpers.normParty(tag[1])), votes: +o.voteCount || 0 };
          }),
          u: +rs.reportingUnits || 0, t: +rs.totalUnits || 0,
        };
      }
    });
  }
  return { byRace, errors };
}

async function buildBigBoard(helpers, dryRun) {
  const geo = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'bigboard-geo.json'), 'utf8'));
  const out = { updatedAt: new Date().toISOString(), dryRun: dryRun || undefined, races: {} };
  const byState = {};
  for (const r of BIGBOARD_RACES) (byState[r.state] = byState[r.state] || []).push(r);

  await Promise.all(Object.entries(byState).map(async ([state, races]) => {
    let res;
    try {
      res = await countyResultsFor(state, races, geo, helpers, dryRun);
    } catch (err) {
      for (const r of races) out.races[r.id] = { id: r.id, label: r.label, state, status: /not posted/.test(err.message) ? 'waiting' : 'error', note: err.message };
      return;
    }
    for (const race of races) {
      const counties = res.byRace[race.id];
      const n = Object.keys(counties).length;
      // Candidate list in a stable order (by statewide votes), county votes aligned to it.
      const totals = {};
      const party = {};
      for (const c of Object.values(counties)) for (const x of c.cands) { totals[x.name] = (totals[x.name] || 0) + x.votes; if (x.party) party[x.name] = x.party; }
      const names = Object.keys(totals).filter((nm) => !/^write-?in/i.test(nm) || totals[nm] > 0).sort((a, b) => totals[b] - totals[a]);
      const total = names.reduce((s, nm) => s + totals[nm], 0);
      out.races[race.id] = {
        id: race.id, state,
        label: dryRun ? race.dry.label : race.label,
        status: n === 0 ? 'waiting' : total > 0 ? 'live' : 'waiting',
        note: n === 0 ? 'contest not posted yet' : undefined,
        countiesWithData: n,
        countiesTotal: geo[state].counties.length,
        candidates: names.map((nm) => ({ name: nm, party: party[nm] || null })),
        counties: Object.fromEntries(Object.entries(counties).map(([fips, c]) => {
          const v = Object.fromEntries(c.cands.map((x) => [x.name, x.votes]));
          return [fips, { v: names.map((nm) => v[nm] || 0), u: c.u, t: c.t }];
        })),
        feedErrors: res.errors.length ? res.errors.slice(0, 10) : undefined,
      };
    }
  }));

  // Stable tab order (config order), regardless of which state answered first.
  out.races = Object.fromEntries(BIGBOARD_RACES.filter((r) => out.races[r.id]).map((r) => [r.id, out.races[r.id]]));
  fs.writeFileSync(OUT_PATH, JSON.stringify(out));
  const summary = Object.values(out.races).map((r) => `${r.id}:${r.status}${r.countiesWithData != null ? `(${r.countiesWithData}/${r.countiesTotal})` : ''}`).join(' ');
  console.log(`  big board: ${summary}`);
  return out;
}

module.exports = { buildBigBoard, BIGBOARD_RACES };
