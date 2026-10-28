(function () {
  'use strict';

  const DATA_URL = 'data/live-results.json';
  const REFRESH_SEC = 60;

  // Poll closing times, Eastern (Nov 3, 2026 is after DST ends, so ET = EST).
  const POLLS_CLOSE_ET = {
    KY: '6-7 PM', GA: '7 PM', VA: '7 PM', NC: '7:30 PM', OH: '7:30 PM', ME: '8 PM', PA: '8 PM',
    MI: '8-9 PM', KS: '8-9 PM', TX: '8-9 PM', IA: '9 PM', CO: '9 PM', AZ: '9 PM', NY: '9 PM', AK: '12-1 AM',
  };
  const STATUS_LABEL = { live: 'Counting', waiting: 'Awaiting results', 'no-feed': 'No live feed', stale: 'Feed delayed', error: 'Feed error' };

  const els = {
    groups: document.getElementById('groups'),
    nav: document.getElementById('group-nav'),
    statusText: document.getElementById('status-text'),
    dot: document.getElementById('live-dot'),
    updated: document.getElementById('updated'),
    countdown: document.getElementById('countdown'),
    banner: document.getElementById('pre-banner'),
    dry: document.getElementById('dry-flag'),
  };

  let activeGroup = 'all';
  try { activeGroup = localStorage.getItem('results-group') || 'all'; } catch (e) {}
  let lastData = null;
  let prevChangedAt = {};
  let secondsLeft = REFRESH_SEC;

  const fmtInt = (n) => Number(n || 0).toLocaleString('en-US');
  const fmtTime = (iso) => {
    if (!iso) return '-';
    const d = new Date(iso);
    return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) +
      (Date.now() - d.getTime() > 20 * 3600e3 ? ' ' + d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '');
  };
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };

  function renderNav(groups) {
    els.nav.textContent = '';
    const all = [{ id: 'all', label: 'All races' }].concat(groups);
    for (const g of all) {
      const b = el('button', null, g.label);
      b.type = 'button';
      b.dataset.group = g.id;
      b.setAttribute('aria-pressed', String(g.id === activeGroup));
      b.addEventListener('click', () => {
        activeGroup = g.id;
        try { localStorage.setItem('results-group', g.id); } catch (e) {}
        render(lastData, false);
      });
      els.nav.appendChild(b);
    }
  }

  function candRow(c, leaderVotes, isLeadMarked) {
    const row = el('div', 'cand');
    if (c.winner) row.classList.add('win');
    else if (isLeadMarked) row.classList.add('lead');
    const nm = el('div', 'nm');
    const pty = el('span', 'pty ' + (c.party === 'D' || c.party === 'R' ? c.party : ''), c.party || '-');
    nm.appendChild(pty);
    nm.appendChild(document.createTextNode(c.name));
    nm.title = c.name;
    row.appendChild(nm);
    row.appendChild(el('div', 'pc', c.pct.toFixed(1) + '%'));
    const vt = el('div', 'vt');
    const bar = el('div', 'bar');
    const fill = el('i', c.party === 'D' || c.party === 'R' ? c.party : '');
    fill.style.width = Math.min(100, c.pct) + '%';
    bar.appendChild(fill);
    vt.appendChild(bar);
    vt.appendChild(el('span', null, fmtInt(c.votes)));
    row.appendChild(vt);
    return row;
  }

  function raceCard(r) {
    const card = el('article', 'race');
    card.dataset.id = r.id;
    const head = el('div', 'race-head');
    const left = el('div');
    left.appendChild(el('div', 'race-title', r.label));
    const close = POLLS_CLOSE_ET[r.state];
    left.appendChild(el('div', 'race-meta', close ? `Polls close ${close} ET` : r.state));
    head.appendChild(left);
    head.appendChild(el('span', 'pill ' + r.status, STATUS_LABEL[r.status] || r.status));
    card.appendChild(head);

    if (r.candidates && r.candidates.length && (r.status === 'live' || r.status === 'stale' || r.status === 'waiting')) {
      const list = el('div', 'cands');
      const counting = r.totalVotes > 0;
      const shown = r.candidates.filter((c, i) => i < 2 || c.party === 'D' || c.party === 'R' || c.pct >= 2).slice(0, 4);
      shown.forEach((c, i) => list.appendChild(candRow(c, r.candidates[0].votes, counting && i === 0 && !r.candidates.some((x) => x.winner))));
      card.appendChild(list);
      if (counting && r.candidates.length > 1) {
        const lead = r.candidates[0].votes - r.candidates[1].votes;
        card.appendChild(el('div', 'note', `${r.candidates[0].name.split(' ').slice(-1)[0]} +${fmtInt(lead)} votes (${(r.candidates[0].pct - r.candidates[1].pct).toFixed(1)} pts) · ${fmtInt(r.totalVotes)} counted`));
      }
    }

    if (r.reporting && r.reporting.total) {
      const rep = el('div', 'reporting');
      const bar = el('div', 'bar');
      const fill = el('i');
      fill.style.width = (r.reporting.pct || 0) + '%';
      bar.appendChild(fill);
      rep.appendChild(el('span', null, `${fmtInt(r.reporting.units)} of ${fmtInt(r.reporting.total)} ${r.reporting.label} reporting`));
      rep.appendChild(bar);
      card.appendChild(rep);
    }

    if (r.status === 'no-feed') {
      card.appendChild(el('div', 'note', `${r.note}. Check the official count:`));
    } else if (r.status === 'waiting' && !(r.candidates && r.candidates.length)) {
      card.appendChild(el('div', 'note', /not posted/.test(r.note || '') ? 'The state has not posted this election yet. It will appear automatically.' : 'Waiting for the state to post this race.'));
    } else if (r.status === 'stale' || r.status === 'error') {
      card.appendChild(el('div', 'note', `Latest check failed (${r.note}). ${r.status === 'stale' ? 'Showing the last good numbers.' : ''}`));
    }

    const foot = el('div', 'race-foot');
    if (r.officialUrl) {
      const a = el('a', null, 'Official results');
      a.href = r.officialUrl;
      a.target = '_blank';
      a.rel = 'noopener';
      foot.appendChild(a);
    } else {
      foot.appendChild(el('span', null, ''));
    }
    foot.appendChild(el('span', null, r.changedAt && r.totalVotes > 0 ? `Changed ${fmtTime(r.changedAt)}` : ''));
    card.appendChild(foot);
    return card;
  }

  function render(data, isRefresh) {
    if (!data) return;
    lastData = data;
    renderNav(data.groups || []);

    const anyLive = data.races.some((r) => r.status === 'live' || r.status === 'stale');
    els.dot.classList.toggle('on', anyLive);
    els.statusText.textContent = anyLive ? 'Live counting' : 'Waiting for polls to close';
    els.updated.textContent = fmtTime(data.updatedAt);
    els.dry.textContent = data.dryRun ? 'TEST DATA: past-election numbers' : '';

    if (!anyLive) {
      els.banner.textContent = 'No votes counted yet. Results begin after polls close on Tuesday, Nov 3: Kentucky first at 6 PM ET, then Georgia and Virginia at 7. ' +
        'This page refreshes itself; leave it open. Races marked "No live feed" link to the state\'s official count.';
      els.banner.classList.remove('hidden');
    } else {
      els.banner.classList.add('hidden');
    }

    const groups = (data.groups || []).filter((g) => activeGroup === 'all' || g.id === activeGroup);
    const frag = document.createDocumentFragment();
    for (const g of groups) {
      const races = data.races.filter((r) => (r.groups || []).includes(g.id));
      if (!races.length) continue;
      const sec = el('section', 'group');
      sec.appendChild(el('h2', null, g.label));
      if (g.blurb) sec.appendChild(el('p', 'blurb', g.blurb));
      const grid = el('div', 'grid');
      for (const r of races) {
        const card = raceCard(r);
        if (isRefresh && r.changedAt && prevChangedAt[r.id] && prevChangedAt[r.id] !== r.changedAt) card.classList.add('flash');
        grid.appendChild(card);
      }
      sec.appendChild(grid);
      frag.appendChild(sec);
    }
    els.groups.textContent = '';
    els.groups.appendChild(frag);
    prevChangedAt = Object.fromEntries(data.races.map((r) => [r.id, r.changedAt]));
  }

  async function load(isRefresh) {
    try {
      const res = await fetch(DATA_URL + '?t=' + Date.now(), { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      render(await res.json(), isRefresh);
    } catch (err) {
      if (!lastData) {
        els.groups.textContent = '';
        els.groups.appendChild(el('p', 'empty', 'Results data is not available right now. This page will keep trying.'));
      }
      els.statusText.textContent = 'Connection problem, retrying';
    }
    secondsLeft = REFRESH_SEC;
  }

  setInterval(() => {
    secondsLeft -= 1;
    if (secondsLeft <= 0) { load(true); secondsLeft = REFRESH_SEC; }
    els.countdown.textContent = secondsLeft + 's';
  }, 1000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) load(true); });
  load(false);
})();
