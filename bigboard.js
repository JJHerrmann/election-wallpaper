(function () {
  'use strict';

  const REFRESH_SEC = 60;
  const COMPLETE = 0.95;          // county counted as "in" at 95%+ of precincts
  const MIN_COMPLETE = 5;         // counties needed before showing an estimate
  const TURNOUT_PRIOR = 0.70;     // midterm vs 2024 presidential turnout, until complete counties say otherwise

  const VIEWS = [
    { id: 'lead', label: 'Leading' },
    { id: 'swing', label: 'Swing vs 2024' },
    { id: 'reporting', label: '% in' },
    { id: 'base', label: '2024 result' },
  ];

  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  const fmtInt = (n) => Math.round(n || 0).toLocaleString('en-US');
  const pct1 = (x) => (100 * x).toFixed(1) + '%';
  const marginTxt = (m) => (m == null || !isFinite(m)) ? '-' : (Math.abs(m) < 0.0005 ? 'Even' : (m > 0 ? 'D+' : 'R+') + (100 * Math.abs(m)).toFixed(1));
  const swingTxt = (s) => (s == null || !isFinite(s)) ? '-' : (Math.abs(s) < 0.0005 ? 'no change' : (100 * Math.abs(s)).toFixed(1) + ' pts toward ' + (s > 0 ? 'D' : 'R'));
  const lastName = (n) => String(n).replace(/,?\s+(Jr|Sr|II|III|IV)\.?$/i, '').trim().split(/\s+/).pop();

  let state = {
    geo: null, baseline: null, data: null,
    race: null, view: 'lead', selected: null, secondsLeft: REFRESH_SEC,
  };
  let viewChosen = false; // until the viewer picks a view, show the 2024 map while nothing is counted
  try {
    state.race = localStorage.getItem('bb-race');
    const v = localStorage.getItem('bb-view');
    if (v) { state.view = v; viewChosen = true; } else state.view = 'lead';
  } catch (e) {}
  const params = new URLSearchParams(location.search);
  if (params.get('race')) state.race = params.get('race');

  async function loadJson(url) {
    const r = await fetch(url + (url.includes('?') ? '&' : '?') + 't=' + Date.now(), { cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  }

  // ------------------------------------------------------------------ math
  function analyze(race) {
    const geoSt = state.geo[race.state];
    const base = state.baseline[race.state];
    const cands = race.candidates || [];
    const di = cands.findIndex((c) => c.party === 'D');
    const ri = cands.findIndex((c) => c.party === 'R');
    const counties = {};

    for (const g of geoSt.counties) {
      const live = race.counties && race.counties[g.fips];
      const b = base[g.fips] || { d: 0, r: 0, total: 0 };
      const v = live ? live.v : cands.map(() => 0);
      const counted = v.reduce((s, x) => s + x, 0);
      const d = di >= 0 ? v[di] : 0, r = ri >= 0 ? v[ri] : 0;
      const frac = live && live.t ? live.u / live.t : 0;
      const baseMargin = b.total ? (b.d - b.r) / b.total : 0;
      const margin = counted ? (d - r) / counted : null;
      const complete = counted > 0 && frac >= COMPLETE;
      counties[g.fips] = { g, b, v, counted, d, r, frac, units: live ? live.u : 0, unitsTotal: live ? live.t : 0, baseMargin, margin, complete,
        swing: margin == null ? null : margin - baseMargin };
    }

    const all = Object.values(counties);
    const complete = all.filter((c) => c.complete);
    const model = fitModel(complete);
    let counted = 0, net = 0;
    const totals = cands.map(() => 0);
    for (const c of all) { c.v.forEach((x, i) => { totals[i] += x; }); counted += c.counted; net += c.d - c.r; }
    const proj = project(all, model);
    for (const c of all) { c.expected = proj.expectedBy.get(c); c.remaining = Math.max(0, c.expected - c.counted); }

    // Rough range: re-fit on resampled sets of completed counties (deterministic
    // seed so the range doesn't jitter between refreshes) and take the 10th-90th
    // percentile of the estimates.
    let range = null;
    if (model.ready) {
      let seed = 12345;
      const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
      const ests = [];
      for (let k = 0; k < 200; k++) {
        const sample = complete.map(() => complete[Math.floor(rnd() * complete.length)]);
        const m = fitModel(sample);
        if (m.ready) ests.push(project(all, m).margin);
      }
      ests.sort((a, b) => a - b);
      if (ests.length >= 50) range = [ests[Math.floor(ests.length * 0.1)], ests[Math.floor(ests.length * 0.9)]];
    }
    return {
      counties, cands, di, ri, totals, counted, expected: proj.expected,
      share: proj.expected ? Math.min(1, counted / proj.expected) : 0,
      margin: counted ? net / counted : null,
      completeCount: complete.length, avgSwing: model.ready ? model.swing : null,
      turnoutRatio: proj.expected && all.reduce((s, c) => s + c.b.total, 0) ? proj.expected / all.reduce((s, c) => s + c.b.total, 0) : model.T0,
      estMargin: model.ready ? proj.margin : null,
      estRange: range,
    };
  }

  // Swing: vote-weighted average shift in margin across completed counties.
  // Turnout: varies with a county's 2024 lean (fitted on completed counties when
  // there are at least 8), because low-turnout elections turn out unevenly by party
  // and a single statewide ratio badly misjudges where the remaining votes are.
  function fitModel(complete) {
    const out = { ready: complete.length >= MIN_COMPLETE, T0: TURNOUT_PRIOR, swing: 0, a: TURNOUT_PRIOR, b: 0, rMin: 0, rMax: 5 };
    if (!complete.length) return out;
    let cv = 0, cb = 0, sw = 0;
    for (const c of complete) { cv += c.counted; cb += c.b.total; sw += c.swing * c.counted; }
    out.T0 = cb ? cv / cb : TURNOUT_PRIOR;
    out.swing = cv ? sw / cv : 0;
    out.a = out.T0;
    if (complete.length >= 8) {
      let W = 0, X = 0, Y = 0;
      for (const c of complete) { const r = c.counted / c.b.total; W += c.b.total; X += c.b.total * c.baseMargin; Y += c.b.total * r; }
      const mx = X / W, my = Y / W;
      let sxy = 0, sxx = 0;
      for (const c of complete) { const r = c.counted / c.b.total; sxy += c.b.total * (c.baseMargin - mx) * (r - my); sxx += c.b.total * (c.baseMargin - mx) ** 2; }
      out.b = sxx > 1e-9 ? sxy / sxx : 0;
      out.a = my - out.b * mx;
      const ratios = complete.map((c) => c.counted / c.b.total);
      out.rMin = Math.min(...ratios); out.rMax = Math.max(...ratios);
    }
    return out;
  }
  function project(all, m) {
    let expected = 0, projNet = 0;
    const expectedBy = new Map();
    for (const c of all) {
      const T = Math.min(m.rMax, Math.max(m.rMin, m.a + m.b * c.baseMargin));
      const e = c.complete ? c.counted : Math.max(c.counted, c.b.total * T);
      expectedBy.set(c, e);
      expected += e;
      const remMargin = Math.max(-1, Math.min(1, c.baseMargin + m.swing));
      projNet += (c.d - c.r) + (e - c.counted) * remMargin;
    }
    return { expected, expectedBy, margin: expected ? projNet / expected : 0 };
  }

  // ------------------------------------------------------------------ colors
  function partyRamp(m) {
    if (m == null) return 'var(--nodata)';
    const a = Math.abs(m);
    if (a < 0.005) return 'var(--tie)';
    const lvl = a >= 0.30 ? 1 : a >= 0.15 ? 2 : a >= 0.05 ? 3 : 4;
    return `var(--${m > 0 ? 'dem' : 'gop'}-${lvl})`;
  }
  function swingRamp(s) {
    if (s == null) return 'var(--nodata)';
    const a = Math.abs(s);
    if (a < 0.01) return '#59627a';
    const lvl = a >= 0.10 ? 1 : a >= 0.05 ? 2 : a >= 0.02 ? 3 : 4;
    return `var(--${s > 0 ? 'dem' : 'gop'}-${lvl})`;
  }
  function reportingRamp(f, counted) {
    if (!counted) return 'var(--nodata)';
    if (f >= COMPLETE) return '#e8edf7';
    if (f >= 0.5) return '#a9b4cc';
    if (f > 0) return '#6b7894';
    return '#47526b'; // votes in (early/mail) but no precincts yet
  }
  function fillFor(c) {
    if (state.view === 'base') return partyRamp(c.baseMargin);
    if (state.view === 'reporting') return reportingRamp(c.frac, c.counted);
    if (state.view === 'swing') return c.counted && c.frac >= 0.5 ? swingRamp(c.swing) : 'var(--nodata)';
    return partyRamp(c.margin);
  }

  function legend() {
    const L = $('legend'); L.textContent = '';
    const item = (color, label) => { const s = el('span'); const sw = el('span', 'sw'); sw.style.background = color; s.appendChild(sw); s.appendChild(document.createTextNode(label)); L.appendChild(s); };
    if (state.view === 'reporting') {
      item('var(--nodata)', 'No votes'); item('#47526b', 'Early/mail only'); item('#6b7894', 'Under half'); item('#a9b4cc', 'Half+'); item('#e8edf7', '95%+ in');
    } else if (state.view === 'swing') {
      item('var(--dem-1)', 'D 10+'); item('var(--dem-3)', 'D 2-5'); item('#59627a', 'Under 1'); item('var(--gop-3)', 'R 2-5'); item('var(--gop-1)', 'R 10+');
      item('var(--nodata)', 'Under 50% in');
    } else {
      item('var(--dem-1)', 'D 30+'); item('var(--dem-2)', 'D 15-30'); item('var(--dem-3)', 'D 5-15'); item('var(--dem-4)', 'D 0-5');
      item('var(--tie)', 'Tied'); item('var(--gop-4)', 'R 0-5'); item('var(--gop-3)', 'R 5-15'); item('var(--gop-2)', 'R 15-30'); item('var(--gop-1)', 'R 30+');
      if (state.view === 'lead') item('var(--nodata)', 'No votes yet');
    }
  }

  // ------------------------------------------------------------------ render
  function renderTabs() {
    const T = $('tabs'); T.textContent = '';
    for (const r of Object.values(state.data.races)) {
      const b = el('button');
      b.type = 'button';
      b.setAttribute('aria-pressed', String(r.id === state.race));
      b.appendChild(document.createTextNode(r.label));
      b.appendChild(el('span', 'st ' + (r.status === 'live' ? 'live' : ''), r.status === 'live' ? 'LIVE' : 'WAITING'));
      b.addEventListener('click', () => { state.race = r.id; state.selected = null; try { localStorage.setItem('bb-race', r.id); } catch (e) {} render(); });
      T.appendChild(b);
    }
  }
  function renderViews() {
    const V = $('views'); V.textContent = '';
    for (const v of VIEWS) {
      const b = el('button', null, v.label);
      b.type = 'button';
      b.setAttribute('aria-pressed', String(v.id === state.view));
      b.addEventListener('click', () => { state.view = v.id; viewChosen = true; try { localStorage.setItem('bb-view', v.id); } catch (e) {} paintMap(); renderViews(); legend(); });
      V.appendChild(b);
    }
  }

  function renderStatewide(race, A) {
    const S = $('statewide'); S.textContent = '';
    if (race.status !== 'live' && !(race.candidates && race.candidates.length)) {
      S.appendChild(el('div', 'waiting', `${race.label}: ${/not posted/.test(race.note || '') ? 'the state has not posted this election yet. It will appear automatically.' : 'waiting for the state to post this race.'} Polls close ${race.state === 'NC' ? '7:30' : '7'} PM ET.`));
      return;
    }
    const wrap = el('div', 'statewide');
    const D = A.di >= 0 ? A.cands[A.di] : A.cands[0];
    const R = A.ri >= 0 ? A.cands[A.ri] : A.cands[1];
    const tot = A.totals.reduce((s, x) => s + x, 0);
    const side = (c, idx, right) => {
      const box = el('div', 'cand-big ' + (c && c.party ? c.party : '') + (right ? ' right' : ''));
      box.appendChild(el('div', 'nm', c ? c.name : '-'));
      box.appendChild(el('div', 'pct', tot && idx >= 0 ? pct1(A.totals[idx] / tot) : '0.0%'));
      box.appendChild(el('div', 'votes', fmtInt(idx >= 0 ? A.totals[idx] : 0) + ' votes'));
      return box;
    };
    wrap.appendChild(side(D, A.cands.indexOf(D), false));
    wrap.appendChild(el('div', 'vs', 'vs'));
    wrap.appendChild(side(R, A.cands.indexOf(R), true));

    const bar = el('div', 'bigbar');
    const dv = A.totals[A.cands.indexOf(D)] || 0, rv = A.totals[A.cands.indexOf(R)] || 0;
    const ov = Math.max(0, tot - dv - rv);
    for (const [cls, v] of [['D', dv], ['O', ov], ['R', rv]]) { const i = el('i', cls); i.style.width = (tot ? 100 * v / tot : 0) + '%'; bar.appendChild(i); }
    bar.appendChild(el('span', 'mid'));
    wrap.appendChild(bar);

    const meta = el('div', 'meta-row');
    const add = (k, v) => { const s = el('span'); s.appendChild(document.createTextNode(k + ' ')); s.appendChild(el('strong', null, v)); meta.appendChild(s); };
    add('Margin', marginTxt(A.margin));
    add('Counted', fmtInt(A.counted));
    add('Est. expected vote in', A.counted ? pct1(A.share) : '0%');
    add('Counties 95%+ in', `${A.completeCount} of ${Object.keys(A.counties).length}`);
    const others = A.cands.filter((c) => c !== D && c !== R && A.totals[A.cands.indexOf(c)] > 0);
    if (others.length) add('Others', others.map((c) => lastName(c.name) + ' ' + pct1(A.totals[A.cands.indexOf(c)] / tot)).join(', '));
    wrap.appendChild(meta);

    const est = el('div', 'estimate');
    if (A.estMargin != null) {
      const leader = A.estMargin >= 0 ? D : R;
      est.appendChild(document.createTextNode('Estimated finish: '));
      est.appendChild(el('strong', null, `${leader ? lastName(leader.name) : ''} ${marginTxt(A.estMargin)}`));
      if (A.estRange) est.appendChild(document.createTextNode(` (rough range ${marginTxt(A.estRange[0])} to ${marginTxt(A.estRange[1])})`));
      est.appendChild(document.createTextNode(`. Completed counties are swinging ${swingTxt(A.avgSwing)} from 2024.`));
      est.appendChild(el('span', 'why', `Arithmetic from ${A.completeCount} completed counties, not a race call. Expected turnout about ${pct1(A.turnoutRatio)} of 2024.`));
    } else {
      est.appendChild(document.createTextNode('Estimated finish appears once 5 counties are 95%+ in.'));
      est.appendChild(el('span', 'why', A.completeCount ? `${A.completeCount} complete so far.` : 'None complete yet. Early and mail votes usually report first and lean differently from Election Day votes.'));
    }
    wrap.appendChild(est);
    S.appendChild(wrap);
  }

  let A = null;
  function buildMap(race) {
    const geoSt = state.geo[race.state];
    const svg = $('cmap');
    svg.setAttribute('viewBox', geoSt.viewBox);
    svg.setAttribute('aria-label', `${geoSt.name} counties`);
    svg.textContent = '';
    const NS = 'http://www.w3.org/2000/svg';
    for (const g of geoSt.counties) {
      const p = document.createElementNS(NS, 'path');
      p.setAttribute('d', g.d);
      p.dataset.fips = g.fips;
      svg.appendChild(p);
    }
    svg.dataset.state = race.state;
  }
  function paintMap() {
    if (!A) return;
    for (const p of $('cmap').querySelectorAll('path')) {
      const c = A.counties[p.dataset.fips];
      p.style.fill = c ? fillFor(c) : 'var(--nodata)';
      p.classList.toggle('sel', p.dataset.fips === state.selected);
    }
  }

  function countyBlock(c) {
    const box = $('county'); box.textContent = '';
    box.appendChild(el('h2', null, 'County'));
    box.appendChild(el('h3', null, `${c.g.name}${state.data.races[state.race].state === 'VA' && +c.g.fips.slice(2) >= 510 ? ' (city)' : ''}`));
    box.appendChild(el('div', 'in', c.unitsTotal ? `${fmtInt(c.units)} of ${fmtInt(c.unitsTotal)} precincts in (${pct1(c.frac)})` : 'No precinct reporting yet'));
    const tot = c.counted;
    A.cands.forEach((cand, i) => {
      if (!c.v[i] && tot) return;
      const row = el('div', 'crow');
      row.appendChild(el('span', null, cand.name + (cand.party ? ` (${cand.party})` : '')));
      row.appendChild(el('span', 'p', tot ? pct1(c.v[i] / tot) : '-'));
      const bar = el('div', 'bar'); const fill = el('i', cand.party === 'D' || cand.party === 'R' ? cand.party : '');
      fill.style.width = (tot ? 100 * c.v[i] / tot : 0) + '%'; bar.appendChild(fill); row.appendChild(bar);
      box.appendChild(row);
    });
    const kv = el('div', 'kv');
    const pair = (k, v, cls) => { kv.appendChild(el('span', null, k)); kv.appendChild(el('span', cls || null, v)); };
    pair('Votes counted', fmtInt(c.counted));
    pair('Margin now', marginTxt(c.margin), c.margin == null ? '' : c.margin >= 0 ? 'pos-D' : 'pos-R');
    pair('2024 (Harris vs Trump)', marginTxt(c.baseMargin), c.baseMargin >= 0 ? 'pos-D' : 'pos-R');
    pair('Swing', c.counted ? swingTxt(c.swing) : '-', c.swing == null ? '' : c.swing >= 0 ? 'pos-D' : 'pos-R');
    pair('Est. votes left', c.complete ? 'about none' : '~' + fmtInt(c.remaining));
    pair('2024 votes cast', fmtInt(c.b.total));
    box.appendChild(kv);
    if (!c.complete && c.counted && c.frac < 0.5) box.appendChild(el('p', 'hint', 'Early in the count: swing here mostly reflects which ballot types have reported.'));
  }

  function selStrip(c) {
    const st = $('selstrip'); st.textContent = '';
    if (!c) { st.classList.remove('on'); return; }
    st.appendChild(el('b', null, c.g.name));
    st.appendChild(document.createTextNode(c.counted
      ? ` · ${marginTxt(c.margin)} · ${pct1(c.frac)} in · swing ${swingTxt(c.swing)} · 2024 ${marginTxt(c.baseMargin)}`
      : ` · no votes yet · 2024 ${marginTxt(c.baseMargin)} · ~${fmtInt(c.remaining)} expected`));
    const a = el('a', null, 'Details');
    a.href = '#county';
    st.appendChild(a);
    st.classList.add('on');
  }

  function select(fips) {
    state.selected = fips;
    paintMap();
    if (A && A.counties[fips]) { countyBlock(A.counties[fips]); selStrip(A.counties[fips]); }
  }

  function renderLists() {
    const L = $('left'); L.textContent = '';
    const left = Object.values(A.counties).filter((c) => c.remaining > 0).sort((a, b) => b.remaining - a.remaining).slice(0, 8);
    if (!A.counted) L.appendChild(el('p', 'hint', 'Biggest vote counties will rank here once counting starts.'));
    for (const c of left) {
      if (!A.counted) break;
      const b = el('button');
      b.type = 'button';
      b.appendChild(el('span', null, c.g.name));
      b.appendChild(el('span', 'n', '~' + fmtInt(c.remaining)));
      b.appendChild(el('span', 's', `${c.counted ? pct1(c.frac) + ' in' : 'nothing in'} · 2024 ${marginTxt(c.baseMargin)}${c.margin != null ? ' · now ' + marginTxt(c.margin) : ''}`));
      b.addEventListener('click', () => select(c.g.fips));
      L.appendChild(b);
    }
    const W = $('swings'); W.textContent = '';
    const sw = Object.values(A.counties).filter((c) => c.complete).sort((a, b) => Math.abs(b.swing) - Math.abs(a.swing)).slice(0, 8);
    if (!sw.length) W.appendChild(el('p', 'hint', 'Appears as counties finish counting.'));
    for (const c of sw) {
      const b = el('button');
      b.type = 'button';
      b.appendChild(el('span', null, c.g.name));
      b.appendChild(el('span', 'n ' + (c.swing >= 0 ? 'pos-D' : 'pos-R'), (c.swing >= 0 ? 'D ' : 'R ') + '+' + (100 * Math.abs(c.swing)).toFixed(1)));
      b.appendChild(el('span', 's', `now ${marginTxt(c.margin)} · 2024 ${marginTxt(c.baseMargin)}`));
      b.addEventListener('click', () => select(c.g.fips));
      W.appendChild(b);
    }
  }

  function render() {
    const races = state.data.races;
    if (!races[state.race]) state.race = (Object.values(races).find((r) => r.status === 'live') || Object.values(races)[0] || {}).id;
    const race = races[state.race];
    if (!viewChosen && race) {
      const anyVotes = Object.values(race.counties || {}).some((c) => c.v.some((x) => x > 0));
      state.view = anyVotes ? 'lead' : 'base';
    }
    renderTabs();
    renderViews();
    legend();
    $('flag').textContent = state.data.dryRun ? 'TEST DATA: past-election numbers' : '';
    $('updated').textContent = new Date(state.data.updatedAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    if (!race) return;
    if ($('cmap').dataset.state !== race.state || $('cmap').dataset.race !== race.id) { buildMap(race); $('cmap').dataset.race = race.id; }
    A = analyze(race);
    renderStatewide(race, A);
    paintMap();
    renderLists();
    if (state.selected && A.counties[state.selected]) { countyBlock(A.counties[state.selected]); selStrip(A.counties[state.selected]); }
    else {
      selStrip(null); const box = $('county'); box.textContent = ''; box.appendChild(el('h2', null, 'County')); box.appendChild(el('p', 'hint', 'Tap or hover a county on the map, or pick one from the lists below.')); }
  }

  // ------------------------------------------------------------------ interaction
  function wireMap() {
    const svg = $('cmap'), tip = $('tip');
    svg.addEventListener('mousemove', (e) => {
      const p = e.target.closest('path');
      if (!p || !A) { tip.style.display = 'none'; return; }
      const c = A.counties[p.dataset.fips];
      tip.textContent = '';
      tip.appendChild(el('b', null, c.g.name));
      tip.appendChild(el('div', null, c.counted ? `${marginTxt(c.margin)} · ${pct1(c.frac)} in` : 'No votes yet'));
      tip.appendChild(el('div', null, `2024 ${marginTxt(c.baseMargin)}${c.counted ? ' · swing ' + swingTxt(c.swing) : ''}`));
      const r = svg.parentElement.getBoundingClientRect();
      tip.style.display = 'block';
      tip.style.left = Math.min(e.clientX - r.left + 14, r.width - 250) + 'px';
      tip.style.top = (e.clientY - r.top + 14) + 'px';
    });
    svg.addEventListener('mouseleave', () => { tip.style.display = 'none'; });
    svg.addEventListener('click', (e) => { const p = e.target.closest('path'); if (p) select(p.dataset.fips); });
  }

  async function refresh() {
    try {
      state.data = await loadJson('data/bigboard.json');
      render();
    } catch (e) {
      if (!state.data) $('statewide').appendChild(el('div', 'waiting', 'Big board data is not available right now. This page will keep trying.'));
    }
    state.secondsLeft = REFRESH_SEC;
  }

  async function init() {
    try {
      [state.geo, state.baseline] = await Promise.all([loadJson('data/bigboard-geo.json'), loadJson('data/bigboard-baseline.json')]);
    } catch (e) {
      $('statewide').appendChild(el('div', 'waiting', 'Could not load the county map. Reload to try again.'));
      return;
    }
    wireMap();
    await refresh();
    setInterval(() => {
      state.secondsLeft -= 1;
      if (state.secondsLeft <= 0) refresh();
      $('countdown').textContent = state.secondsLeft + 's';
    }, 1000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
  }
  init();
})();
