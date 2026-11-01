// Workfloor client. Plain JS, no build step.
(() => {
  const $ = (s, el = document) => el.querySelector(s);
  const h = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  let S = null;                 // snapshot from /api/state
  let openId = null;            // task shown in the drawer
  let tab = 'convo';
  const briefs = {}; // task id -> { markdown, at } | { loading } | { error }
  let log = [];
  let room = 'inbox';
  let query = '';
  let showHidden = false;
  const noteDrafts = {};
  let centeredStep = '';
  const prevAgent = {};

  // Inside the Mac app: Dock badge for desks that need you, and a Dock bounce when a turn ends.
  const mac = window.webkit?.messageHandlers?.workfloor;

  // ---------- theme ----------
  const storedTheme = (() => { try { return localStorage.getItem('wf-theme'); } catch { return null; } })();
  const theme = storedTheme || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
  document.documentElement.dataset.theme = theme;
  $('#themeBtn').onclick = () => {
    const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('wf-theme', next); } catch {}
  };

  // ---------- API ----------
  async function api(path, body) {
    const res = await fetch('/api/' + path, body === undefined ? {} : {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) { location.reload(); throw new Error('Not paired'); }
    if (!res.ok) throw new Error(data.error || res.statusText);
    return data;
  }

  function toast(text, level = 'info', onClick) {
    const el = document.createElement('div');
    el.className = 'toast ' + level;
    el.textContent = text;
    el.onclick = () => { el.remove(); onClick?.(); };
    $('#toasts').append(el);
    setTimeout(() => el.remove(), level === 'error' ? 9000 : 5000);
  }

  // ---------- pixel art ----------
  const PAL = {
    hair: ['#2b1d14', '#5a3a22', '#d9a441', '#1c1c1c', '#8a3b2a', '#c9c3b8'],
    skin: ['#f1c7a1', '#d9a07a', '#a86f4c', '#7a4c32', '#f5d6b8'],
    shirt: ['#4a7bd0', '#d0644a', '#3c9c78', '#8a5bd0', '#d0a03c', '#c94f7c'],
  };
  const hash = (s) => [...String(s)].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);

  const SCREEN = { running: '#74e0b5', 'needs-you': '#f07a5c', waiting: '#f3b54e', error: '#b2493a', review: '#b59cf5', idle: '#2a3340', stopped: '#2a3340' };

  const BODY = [
    '......................',
    '....hhhh..............',
    '...hhhhhh....mmmmmmm..',
    '...hhssss....mgggggm..',
    '...hsssesP...mgggggm..',
    '....ssss.....mgggggm.L',
    '..cc.ss......mgggggmLL',
    '..cbbbbbb....mmmmmmm.L',
    '..cbbbbbbB.....mmm..OO',
    '..cbbbbbb....kkkkk.uOO',
    'wwwwwwwwwwwwwwwwwwwwww',
    'WWWWWWWWWWWWWWWWWWWWWW',
    '.WW................WW.',
    '.WW................WW.',
  ];
  const ARMS_A = [[9, 8, 'b'], [10, 8, 'b'], [11, 9, 's'], [12, 9, 's']];
  const ARMS_B = [[9, 8, 'b'], [10, 8, 'b'], [11, 8, 's'], [12, 8, 's']];

  function worker(seed, state) {
    const n = hash(seed);
    const col = {
      h: PAL.hair[n % PAL.hair.length], s: PAL.skin[(n >> 3) % PAL.skin.length], e: '#1a1410', P: PAL.skin[(n >> 3) % PAL.skin.length],
      b: PAL.shirt[(n >> 6) % PAL.shirt.length], B: PAL.shirt[(n >> 6) % PAL.shirt.length], c: '#3a414b', m: '#3b4450', k: '#cfc6b6',
      w: '#9a6a45', W: '#6d4a30', g: SCREEN[state] || SCREEN.idle, u: '#f4ecdc', L: '#5fae6a', O: '#b7643f',
    };
    let rects = '';
    BODY.forEach((row, y) => [...row].forEach((ch, x) => {
      if (ch === '.') return;
      const cls = ch === 'g' && state === 'running' ? ' class="screen-glow"' : '';
      rects += `<rect x="${x}" y="${y}" width="1" height="1" fill="${col[ch]}"${cls}/>`;
    }));
    const arm = (list) => list.map(([x, y, c]) => `<rect x="${x}" y="${y}" width="1" height="1" fill="${col[c]}"/>`).join('');
    // a few lines of "code" on the screen while typing
    const code = state === 'running' ? '<rect x="14.5" y="3.4" width="3" height=".4" fill="#0f2a20"/><rect x="14.5" y="4.4" width="4" height=".4" fill="#0f2a20"/><rect x="15" y="5.4" width="2.5" height=".4" fill="#0f2a20"/>' : '';
    let extra = '';
    if (state === 'needs-you') extra = '<g class="bob"><rect x="8" y="-1.5" width="4" height="3.2" rx=".6" fill="#f4ecdc"/><rect x="9.6" y="-1" width=".8" height="1.4" fill="#f07a5c"/><rect x="9.6" y=".8" width=".8" height=".5" fill="#f07a5c"/></g>';
    if (state === 'waiting') extra = '<rect class="steam" x="19.2" y="7.4" width=".5" height=".8" fill="#cfd6de"/><rect class="steam s2" x="19.9" y="7" width=".5" height=".8" fill="#cfd6de"/>';
    if (state === 'idle' || state === 'stopped') extra = '<text class="zz" x="8.5" y="1.6" font-family="Silkscreen, monospace" font-size="2.2" fill="#9aa3ad">z</text>';
    if (state === 'error') extra = '<g class="bob"><rect x="8" y="-1.5" width="4" height="3.2" rx=".6" fill="#f4ecdc"/><text x="9.2" y="1.2" font-family="Silkscreen, monospace" font-size="2.6" fill="#b2493a">x</text></g>';
    if (state === 'review') extra = '<g class="bob"><rect x="8" y="-1.5" width="4" height="3.2" rx=".6" fill="#f4ecdc"/><path d="M9 .1 L9.8 .9 L11.1 -.6" stroke="#7a5bd6" stroke-width=".5" fill="none"/></g>';
    return `<svg viewBox="0 -2 22 16" aria-hidden="true">${rects}<g class="arms-a">${arm(ARMS_A)}</g><g class="arms-b">${arm(ARMS_B)}</g>${code}${extra}</svg>`;
  }

  $('#brandMark').innerHTML = `<svg viewBox="0 0 12 12" shape-rendering="crispEdges">
    <rect x="2" y="1" width="8" height="10" fill="#9aa3ad"/><rect x="1" y="10" width="10" height="1" fill="#6d4a30"/>
    ${[2.5, 5, 7.5].map((y) => [3, 5, 7].map((x) => `<rect x="${x}" y="${y}" width="1.2" height="1.2" fill="${(x + y) % 3 < 1 ? '#f3b54e' : '#74e0b5'}"/>`).join('')).join('')}
    <rect x="5" y="8.6" width="2" height="1.4" fill="#2a2620"/></svg>`;

  // ---------- state helpers ----------
  const STATE_LABEL = {
    running: 'Typing away', 'needs-you': 'Needs you', waiting: 'Your move', error: 'Hit a snag',
    review: 'In review', idle: 'Desk is quiet', stopped: 'Stopped',
  };
  function deskState(t) {
    const w = t.work;
    if (!w) return 'idle';
    if (w.approvals?.length) return 'needs-you';
    if (w.agent?.status === 'running' || w.checksRunning) return 'running';
    if (w.agent?.status === 'needs-you') return 'needs-you';
    if (w.agent?.status === 'error') return 'error';
    if (w.agent?.status === 'waiting') return 'waiting';
    if (w.pr && w.pr.state === 'OPEN') return 'review';
    return w.agent?.status === 'stopped' ? 'stopped' : 'idle';
  }
  const activity = (t) => {
    const w = t.work || {};
    if (w.checksRunning) return 'Running checks…';
    if (w.agent?.status === 'running') return w.agent.activity || 'Thinking…';
    if (w.agent?.last) return w.agent.last.split('\n').find((l) => l.trim())?.replace(/[#*`>]/g, '').replace(/^\s*(?:[-•]|\d+[.)])\s+/, '').trim() || '';
    if (w.pr) return `PR #${w.pr.number} · ${(w.pr.state || '').toLowerCase()}`;
    if (w.branch) return w.branch;
    return '';
  };
  const onFloor = (t) => !!(t.work && !t.work.clockedOut && (t.work.worktree || t.work.pr || (t.work.agent && t.work.agent.status !== 'idle')));
  const ORDER = { 'needs-you': 0, error: 1, running: 2, waiting: 3, review: 4, stopped: 5, idle: 6 };
  const PRIO = { High: 0, Medium: 1, Low: 2 };

  const ROOMS = [
    { id: 'inbox', name: 'Inbox tray', icon: '📥', match: (t) => !t.awaitingRelease && t.stage === 'todo' },
    { id: 'desks', name: 'At the desk', icon: '⌨️', match: (t) => !t.awaitingRelease && t.stage === 'doing' },
    { id: 'review', name: 'Review room', icon: '🔍', match: (t) => !t.awaitingRelease && t.stage === 'review' },
    { id: 'ship', name: 'Ready to ship', icon: '🚀', match: (t) => t.awaitingRelease },
    { id: 'blocked', name: 'Stuck', icon: '🚧', match: (t) => !t.awaitingRelease && !['todo', 'doing', 'review'].includes(t.stage) },
  ];

  const stepsFor = (t) => S.workflow.filter((s) => !s.repos || !t.work?.repos || s.repos.some((r) => t.work.repos.includes(r)));
  const GLYPH = { badge: '🪪', keyboard: '⌨️', flask: '🧪', magnifier: '🔍', phone: '📱', mailbox: '📮', signal: '🚦', rocket: '🚀' };
  const STEP_WORD = { pass: 'Done', fail: 'Failed', running: 'Working', 'needs-you': 'Needs you', stopped: 'Stopped', waiting: 'Waiting', idle: '' };
  const KIND_WORD = { expo: 'OTA', ios: 'iOS', android: 'Android' };
  const FIX_CHECKS = 'Fix the failing Workfloor checks: run them yourself, fix the cause, and re-run until they pass.';

  // ---------- what to do next: one obvious action for every state of a task ----------
  const prsOf = (w) => (w.prs?.length ? w.prs : w.pr ? [w.pr] : []);
  const ciFailing = (p) => (p.checks || []).filter((c) => ['failure', 'error', 'timed_out', 'cancelled', 'action_required'].includes(c.status)).length;
  const ciPending = (p) => (p.checks || []).filter((c) => ['pending', 'in_progress', 'queued', 'expected', ''].includes(c.status)).length;
  const prList = (list) => list.map((p) => `${list.length > 1 ? `${p.repo} ` : ''}#${p.number}`).join(', ');
  const nb = (label, attrs, primary) => `<button type="button" class="btn small ${primary ? 'primary' : ''}" ${attrs}>${label}</button>`;
  const relWord = (r) => `${r.version} ${KIND_WORD[r.kind] || r.kind} · ${r.env}`;

  function nextUp(t) {
    const w = t.work || {};
    const s = w.steps || {};
    const a = w.agent || {};
    const has = (id) => stepsFor(t).some((x) => x.id === id);
    const prs = prsOf(w);
    const open = prs.filter((p) => p.state === 'OPEN');
    if (prs.length && prs.every((p) => p.state === 'MERGED')) {
      const ship = t.shipped || [];
      const prod = ship.filter((r) => r.env === 'production');
      const why = prod.length ? `Shipped in ${relWord(prod[prod.length - 1])}.`
        : ship.length ? `On ${relWord(ship[ship.length - 1])}; not in a production release yet.`
          : `${prs.length > 1 ? 'All PRs' : 'PR'} merged. Waiting for a release to carry it.`;
      return { step: 'ship', why, actions: w.worktree ? [nb('Finish: clock out & mark done', 'data-finish', true)] : [] };
    }
    if (!w.worktree) return { step: 'setup', why: 'Not clocked in yet.', actions: [nb('Clock in', 'data-step="setup"', true)] };
    if (a.status === 'running') return { step: a.step, why: '', actions: [nb('Stop', 'data-stop')] };
    if (w.checksRunning) return { step: 'checks', why: 'Checks are running…', actions: [nb('Stop', 'data-stop')] };
    if ((w.approvals || []).length) return { step: a.step, why: 'The agent is waiting for your OK.', actions: [nb('Review the request', 'data-tab="convo"', true)] };
    if (a.status === 'needs-you') return { step: a.step, why: 'The agent asked you something.', actions: [nb('Answer', 'data-tab="convo"', true), nb('👍 Go with your picks', 'data-q="Go with your recommendations."')] };
    if (a.status === 'error') return { step: a.step, why: 'The last turn hit an error.', actions: [nb('Continue', 'data-q="Continue."', true)] };
    if (!prs.length) {
      if (s.code?.status !== 'pass') {
        return s.code
          ? { step: 'code', why: 'The build stopped before it finished.', actions: [nb('Continue the build', 'data-q="Continue."', true)] }
          : { step: 'code', why: 'Clocked in. Ready to build.', actions: [nb('Start building', 'data-step="code"', true)] };
      }
      if (!s.checks || ['stopped', 'idle'].includes(s.checks.status)) return { step: 'checks', why: 'Built. Run the checks next.', actions: [nb('Run checks', 'data-step="checks"', true), nb('Skip to PR', 'data-step="pr"')] };
      if (s.checks.status === 'fail') return { step: 'checks', why: `Checks failed: ${s.checks.summary}.`, actions: [nb('Ask agent to fix', `data-ask="${FIX_CHECKS}"`, true), nb('Run again', 'data-step="checks"'), nb('Skip to PR', 'data-step="pr"')] };
      if (has('review') && !s.review) return { step: 'review', why: 'Checks pass. Self review is next.', actions: [nb('Self review', 'data-step="review"', true), nb('Skip to PR', 'data-step="pr"')] };
      if (has('simtest') && !s.simtest) return { step: 'simtest', why: 'Reviewed. Try it on the simulator next.', actions: [nb('📱 Test on simulator', 'data-simtest="1"', true), nb('Skip to PR', 'data-step="pr"')] };
      return { step: 'pr', why: 'Everything ran. Ready for the PR.', actions: [nb('Raise PR', 'data-step="pr"', true)] };
    }
    const failing = open.filter(ciFailing);
    const conflicts = open.filter((p) => p.mergeable === 'CONFLICTING');
    const pending = open.filter(ciPending);
    const commented = open.filter((p) => p.comments);
    const mergeLabel = open.length > 1 ? `Merge all ${open.length} PRs` : `Merge PR #${open[0].number}`;
    const mergeAttr = `data-merge="${open.length > 1 ? 'all' : open[0].number}"`;
    if (failing.length) return { step: 'ci', why: `CI is failing on ${prList(failing)}.`, actions: [nb('Fix CI & comments', 'data-fixci', true), nb('Refresh', 'data-step="ci"')] };
    if (conflicts.length) return { step: 'ci', why: `${prList(conflicts)} has merge conflicts.`, actions: [nb('Ask agent to resolve', `data-ask="Merge the latest base branch into this branch, resolve the conflicts, run the checks and push."`, true), nb('Refresh', 'data-step="ci"')] };
    if (pending.length) return { step: 'ci', why: `CI is still running on ${prList(pending)}.`, actions: [nb('Refresh', 'data-step="ci"', true), nb(`${mergeLabel} anyway`, mergeAttr)] };
    return {
      step: 'ci',
      why: `${prList(open)} ${open.every((p) => p.review === 'APPROVED') ? 'approved and' : 'is'} green.${commented.length ? ' There are review comments.' : ''}`,
      actions: [nb(mergeLabel, mergeAttr, true), commented.length ? nb('Address comments', 'data-fixci') : '', nb('Refresh', 'data-step="ci"')].filter(Boolean),
    };
  }

  function quickReplies(t) {
    const w = t.work || {};
    const a = w.agent || {};
    const q = [];
    if (stepsFor(t).some((s) => s.id === 'simtest')) q.push('<button class="sim-q" data-simtest="1">📱 Test on simulator</button>');
    if (a.status === 'needs-you') q.push('<button data-q="Go with your recommendations.">👍 Go with your picks</button>');
    if (['waiting', 'stopped', 'error', 'needs-you'].includes(a.status)) q.push('<button data-q="Continue.">▶ Continue</button>');
    q.push('<button data-q="Commit what you have with a clear message.">💾 Commit</button>');
    q.push('<button data-q="Summarize where this stands in 3 lines.">📝 Status?</button>');
    if (w.steps?.checks?.status === 'fail') q.push(`<button data-ask="${FIX_CHECKS}">🧪 Fix checks</button>`);
    if (prsOf(w).some((p) => p.state === 'OPEN' && (ciFailing(p) || p.comments))) q.push('<button data-fixci="1">🔧 Fix CI & comments</button>');
    return q.join('');
  }

  // ---------- Claude usage meter ----------
  const money = (n) => `$${(n || 0).toFixed(2)}`;
  const until = (ms) => {
    const m = Math.max(0, Math.round((ms - Date.now()) / 60000));
    return m < 60 ? `${m}m` : m < 1440 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${Math.floor(m / 1440)}d ${Math.floor((m % 1440) / 60)}h`;
  };
  const live = (w) => w && w.resetsAt > Date.now();

  function gauge(name, w) {
    const pct = live(w) ? w.pct : null;
    const lvl = pct == null ? 'stale' : pct >= 85 ? 'hot' : pct >= 60 ? 'warm' : '';
    return `<div class="gauge ${lvl}"><span class="g-name">${name}</span><span class="g-track"><i style="width:${pct ?? 0}%"></i></span>`
      + `<span class="g-pct">${pct == null ? '--' : pct + '%'}</span><span class="g-reset">${!w ? '' : pct == null ? 'reset' : until(w.resetsAt)}</span></div>`;
  }

  function meterHtml() {
    const u = S.usage || {};
    const L = u.limits;
    const hot = L && [L.fiveHour, L.sevenDay].some((w) => live(w) && w.pct >= 85);
    return `<button class="stat meter ${hot ? 'alert' : ''}" data-meter="1" title="Claude plan usage">
      <div class="meter-head"><span class="label">CLAUDE METER</span><span class="sub">${u.probing ? 'reading…' : `${money(u.today?.cost)} today`}</span></div>
      ${gauge('5H', L?.fiveHour)}${gauge('WK', L?.sevenDay)}</button>`;
  }

  const NAMES = { meter: 'Meter checks', sync: 'Notion sync' };
  function renderMeterDlg() {
    const u = S.usage || {};
    const L = u.limits;
    const at = (ms) => new Date(ms).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
    const big = (name, w) => (w ? `<div class="big-gauge">${gauge(name, w)}<div class="muted">${live(w) ? `Resets ${at(w.resetsAt)}` : 'Reset since the last reading'}</div></div>` : '');
    const max = Math.max(0.01, ...(u.byTask || []).map((b) => b.cost));
    $('#meterBody').innerHTML = `
      <p class="muted">Your Claude plan's usage limits, from the latest Claude Code run${L ? ` (${ago(L.at)})` : ''}. Claude use outside Workfloor counts too.</p>
      ${L ? `<div class="meter-big">${big('5 HOURS', L.fiveHour)}${big('THIS WEEK', L.sevenDay)}</div>` : '<p>No reading yet. Tap <b>Check now</b>.</p>'}
      ${L?.overage ? '<p class="warn-line">You are on extra usage right now.</p>' : ''}
      <div class="spend">
        <div class="spend-tot">
          <div><span class="label">TODAY</span><b>${money(u.today?.cost)}</b><small>${u.today?.runs || 0} runs</small></div>
          <div><span class="label">LAST 7 DAYS</span><b>${money(u.week?.cost)}</b><small>${u.week?.runs || 0} runs</small></div>
        </div>
        ${(u.byTask || []).length ? `<div class="spend-rows">${u.byTask.map((b) => `<div class="spend-row"><span>${h(NAMES[b.id] || b.id)}</span><span class="g-track"><i style="width:${(b.cost / max) * 100}%"></i></span><span>${money(b.cost)}</span></div>`).join('')}</div>` : ''}
        <p class="muted small">Dollar amounts are Claude Code's API-equivalent estimates for Workfloor's own runs. On a Pro or Max plan they come out of the meter above, not a bill.</p>
      </div>`;
    const btn = $('#meterRefresh');
    btn.disabled = !!u.probing;
    btn.textContent = u.probing ? 'Reading…' : 'Check now';
  }

  function refreshMeter() {
    const card = $('.stat.meter');
    if (card) card.outerHTML = meterHtml();
    if ($('#meterDlg').open) renderMeterDlg();
  }
  function openMeter() { $('#meterDlg').showModal(); renderMeterDlg(); }
  $('#meterRefresh').onclick = () => api('usage', { force: true }).then((u) => { S.usage = u; refreshMeter(); }).catch((x) => toast(x.message, 'error'));
  // The server only spends a probe when the last reading is over 10 minutes old.
  const checkUsage = () => { if (S && !document.hidden) api('usage', {}).then((u) => { S.usage = u; refreshMeter(); }).catch(() => {}); };
  setInterval(checkUsage, 5 * 60e3);
  document.addEventListener('visibilitychange', checkUsage);

  // ---------- sounds and voice on this device ----------
  // Retro sounds are synthesized (nothing to download). The Mac plays its own through the server, so a
  // page on the Mac stays quiet by default and phones make the noise.
  let P = (() => { try { return JSON.parse(localStorage.getItem('wf-sound') || 'null'); } catch { return null; } })();
  const prefs = () => (P ||= { sounds: !S?.local, voice: !S?.local, ambient: false, volume: 0.6 });
  const savePrefs = () => { try { localStorage.setItem('wf-sound', JSON.stringify(P)); } catch {} };
  let actx = null;
  const audio = () => (actx ||= new (window.AudioContext || window.webkitAudioContext)());
  document.addEventListener('pointerdown', () => {
    // Phones only allow sound after a tap: wake the audio and speech engines on the first one.
    if (!actx) { audio(); try { speechSynthesis.speak(new SpeechSynthesisUtterance('')); } catch {} }
    else if (actx.state === 'suspended') actx.resume();
  }, { passive: true });

  function tone(freq, at, dur, type = 'square', gain = 0.1, slideTo) {
    const a = audio();
    const t0 = a.currentTime + at;
    const o = a.createOscillator();
    const v = a.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t0);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t0 + dur);
    v.gain.setValueAtTime(0.0001, t0);
    v.gain.linearRampToValueAtTime(gain * prefs().volume, t0 + 0.01);
    v.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(v).connect(a.destination);
    o.start(t0);
    o.stop(t0 + dur + 0.05);
  }
  const SFX = {
    'needs-you': () => { for (let r = 0; r < 2; r++) for (let i = 0; i < 8; i++) tone(i % 2 ? 1180 : 940, r * 0.6 + i * 0.045, 0.045, 'square', 0.07); }, // desk phone ring
    approval: () => { tone(880, 0, 0.12, 'square', 0.09); tone(1320, 0.14, 0.22, 'square', 0.09); tone(880, 0.42, 0.12, 'square', 0.09); tone(1320, 0.56, 0.22, 'square', 0.09); },
    done: () => { tone(1568, 0, 0.7, 'triangle', 0.14); tone(3136, 0, 0.35, 'sine', 0.03); }, // typewriter bell
    error: () => tone(150, 0, 0.5, 'sawtooth', 0.1, 90), // buzzer
    'checks-fail': () => { tone(196, 0, 0.18, 'sawtooth', 0.08); tone(147, 0.2, 0.3, 'sawtooth', 0.08); },
    'checks-pass': () => { tone(784, 0, 0.08, 'square', 0.06); tone(1047, 0.09, 0.14, 'square', 0.06); },
    'ci-fail': () => { tone(220, 0, 0.22, 'sawtooth', 0.09); tone(185, 0.24, 0.4, 'sawtooth', 0.09); },
    'review-comment': () => { tone(660, 0, 0.08, 'triangle', 0.1); tone(990, 0.09, 0.14, 'triangle', 0.1); },
    merged: () => { [523, 659, 784, 1047].forEach((f, i) => tone(f, i * 0.09, i === 3 ? 0.5 : 0.12, 'square', 0.08)); tone(2093, 0.45, 0.25, 'triangle', 0.05); }, // fanfare
    report: () => [1047, 1319, 1568].forEach((f, i) => tone(f, i * 0.08, 0.14, 'triangle', 0.09)),
    paused: () => [440, 330, 247].forEach((f, i) => tone(f, i * 0.16, 0.2, 'square', 0.07)),
    standup: () => [659, 523, 587, 392].forEach((f, i) => tone(f, i * 0.32, 0.6, 'sine', 0.12)), // office chime
    checkout: () => [392, 587, 523, 659].forEach((f, i) => tone(f, i * 0.32, 0.6, 'sine', 0.12)), // the chime, backwards
    'release-ask': () => { tone(988, 0, 0.1, 'square', 0.09); tone(1319, 0.12, 0.25, 'square', 0.09); },
    'release-done': () => [523, 784, 1047, 1568].forEach((f, i) => tone(f, i * 0.1, 0.3, 'triangle', 0.1)), // lift-off
    'release-fail': () => { tone(220, 0, 0.25, 'sawtooth', 0.1); tone(165, 0.27, 0.45, 'sawtooth', 0.1); },
  };
  // One voice per event: on this Mac the server already speaks through `say` when Mac voice is on, and
  // when several tabs or windows are open only the first one to claim a line says it.
  function speakOnce(key, text) {
    if (S?.local && S.settings?.mac?.voice) return;
    try {
      if (localStorage.getItem('wf-spoke') === key) return;
      localStorage.setItem('wf-spoke', key);
    } catch {}
    speak(text);
  }
  function speak(text) {
    if (!text || !('speechSynthesis' in window)) return;
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 1.05;
    u.volume = prefs().volume;
    speechSynthesis.speak(u);
  }
  function quietNow() {
    const m = S?.settings?.mac || {};
    const mins = (x) => { const [a, b] = String(x || '').split(':').map(Number); return (a || 0) * 60 + (b || 0); };
    if (!m.quietFrom || !m.quietTo || m.quietFrom === m.quietTo) return false;
    const d = new Date();
    const n = d.getHours() * 60 + d.getMinutes();
    const a = mins(m.quietFrom);
    const b = mins(m.quietTo);
    return a < b ? n >= a && n < b : n >= a || n < b;
  }
  // Office ambience: soft key clicks while an agent is typing.
  setInterval(() => {
    if (!prefs().ambient || document.hidden || !actx || quietNow()) return;
    const typing = S?.tasks.filter((t) => t.work?.agent?.status === 'running').length || 0;
    if (typing && Math.random() < 0.35 + typing * 0.1) tone(1800 + Math.random() * 1800, 0, 0.012, 'square', 0.02);
  }, 120);

  const EV_LABEL = {
    'needs-you': 'needs you', approval: 'wants your OK', done: 'turn finished', error: 'hit a snag', 'checks-pass': 'checks passed',
    'checks-fail': 'checks failed', 'ci-fail': 'CI failed', 'review-comment': 'new review comment', merged: 'PR merged 🎉',
    report: 'test report ready', paused: 'Autopilot paused', standup: 'Standup', checkout: 'Time to check out',
    'release-ask': 'Release needs your answer', 'release-done': 'Release step finished 🚀', 'release-fail': 'Release step failed',
  };
  const EV_LEVEL = { 'needs-you': 'warn', approval: 'warn', error: 'error', 'checks-fail': 'error', 'ci-fail': 'error', paused: 'warn' };
  function onEvent(ev) {
    if (S) {
      S.recent = [ev, ...(S.recent || [])].slice(0, 14);
      tickIdx = 0;
      renderTicker();
      $('#ticker').classList.remove('fresh');
      void $('#ticker').offsetWidth;
      $('#ticker').classList.add('fresh');
    }
    const label = EV_LABEL[ev.kind] || ev.kind;
    const text = `${ev.id ? ev.id + ' ' : ''}${label}${ev.text ? ': ' + ev.text : ''}`;
    if (ev.kind !== 'checks-pass' || ev.id === openId) toast(text, EV_LEVEL[ev.kind] || 'info', ev.id ? () => openTask(ev.id, 'convo') : ev.kind === 'standup' ? openStandupTab : ev.kind === 'checkout' ? () => openDaily('checkout') : ev.kind.startsWith('release') ? openRelease : undefined);
    if (!quietNow()) {
      if (prefs().sounds) SFX[ev.kind]?.();
      if (prefs().voice && ev.speech && ev.kind !== 'checks-pass') speakOnce(`${ev.kind}:${ev.id || ''}:${ev.at}`, ev.speech);
    }
    if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
      new Notification(`Workfloor · ${ev.id || label}`, { body: text, tag: ev.id || ev.kind });
    }
    if (['needs-you', 'approval', 'error'].includes(ev.kind)) navigator.vibrate?.([80, 60, 80]);
    if (['needs-you', 'approval', 'error', 'done', 'merged'].includes(ev.kind)) mac?.postMessage({ attention: true });
    if (ev.kind === 'merged') confetti();
  }

  function confetti() {
    const box = document.createElement('div');
    box.className = 'confetti';
    const colors = ['#74e0b5', '#f3b54e', '#f07a5c', '#b59cf5', '#6fb7ff'];
    for (let i = 0; i < 90; i++) {
      const c = document.createElement('i');
      c.style.cssText = `left:${Math.random() * 100}%;background:${colors[i % colors.length]};animation-delay:${Math.random() * 0.6}s;animation-duration:${1.8 + Math.random() * 1.4}s;--drift:${(Math.random() - 0.5) * 160}px`;
      box.append(c);
    }
    document.body.append(box);
    setTimeout(() => box.remove(), 4000);
  }

  // ---------- settings ----------
  let macState = {};
  window.wfMac = (m) => {
    macState = { ...macState, ...m };
    if (m.folder && ob) obAddRepo(m.folder);
    if ($('#settingsDlg').open) renderSettings();
  };
  const nest = (path, value) => path.split('.').reduceRight((acc, k) => ({ [k]: acc }), value);
  const getPath = (obj, path) => path.split('.').reduce((o, k) => o?.[k], obj);
  function row(title, hint, control) { return `<label class="set-row"><span><b>${title}</b>${hint ? `<small>${hint}</small>` : ''}</span>${control}</label>`; }
  const sw = (attr, on) => `<input type="checkbox" class="switch" ${attr} ${on ? 'checked' : ''}>`;
  const field = (attr, value, type = 'text', extra = '') => `<input type="${type}" class="set-input" ${attr} value="${h(value ?? '')}" ${extra}>`;

  function renderSettings() {
    const st = S.settings;
    const pr = prefs();
    $('#settingsBody').innerHTML = `
      <section><div class="subhead">THIS ${S.local ? 'BROWSER' : 'PHONE'}</div>
        ${row('Sounds', 'Phone ring when a desk needs you, a bell when a turn ends, a buzzer on failures.', sw('data-pref="sounds"', pr.sounds))}
        ${row('Voice', 'Reads the question out loud: “Desk 42 needs you…”.', sw('data-pref="voice"', pr.voice))}
        ${row('Office ambience', 'Soft keyboard clicks while agents are typing.', sw('data-pref="ambient"', pr.ambient))}
        ${row('Volume', '', `<input type="range" min="0" max="1" step="0.05" data-pref="volume" value="${pr.volume}">`)}
        <div class="set-actions"><button type="button" class="btn small" data-settest="sound">Play a sound</button><button type="button" class="btn small" data-settest="voice">Test the voice</button></div>
      </section>
      <section><div class="subhead">MAC SPEAKERS · EVEN WITH THE WINDOW CLOSED</div>
        ${row('Sounds', '', sw('data-set="mac.sounds"', st.mac.sounds))}
        ${row('Voice', 'Uses the Mac’s “say”. Leave the name empty for the system voice, or try Samantha, Daniel, Karen.', sw('data-set="mac.voice"', st.mac.voice))}
        ${row('Voice name', '', field('data-set="mac.voiceName"', st.mac.voiceName, 'text', 'placeholder="System voice"'))}
        ${row('Quiet hours', 'No sounds or voice on any device between these times.', `<span class="set-pair">${field('data-set="mac.quietFrom"', st.mac.quietFrom, 'time')}–${field('data-set="mac.quietTo"', st.mac.quietTo, 'time')}</span>`)}
        <div class="set-actions"><button type="button" class="btn small" data-settest="mac">Speak on the Mac</button></div>
      </section>
      <section><div class="subhead">PHONE PUSH · NTFY</div>
        ${row('Push notifications', 'Arrive even when Workfloor is closed, with buttons: Allow / Deny, Go with your picks, Fix CI.', sw('data-set="push.enabled"', st.push.enabled))}
        ${row('Topic', 'Install the free ntfy app and subscribe to this topic. Keep it secret: anyone with it can read your alerts.', field('data-set="push.topic"', st.push.topic))}
        ${row('Server', 'Task titles and agent questions pass through this server. Run your own ntfy to keep them private.', field('data-set="push.server"', st.push.server, 'url'))}
        <div class="set-actions"><button type="button" class="btn small" data-settest="push">Send a test push</button></div>
      </section>
      <section><div class="subhead">ALWAYS ON</div>
        ${row('Keep the Mac awake', 'While any agent or check is running (closing the lid still sleeps it).', sw('data-set="keepAwake"', st.keepAwake))}
        ${mac ? row('Open at login', 'Start Workfloor when you log in to the Mac.', sw('data-login', macState.loginItem)) : ''}
        ${S.local ? row('Setup', 'Your name, tools, Notion database and repos.', '<button type="button" class="btn small" data-setupagain>Run setup again</button>') : ''}
        ${row('Open the tunnel at start', 'So the phone reaches the floor away from Wi-Fi without touching the Mac.', sw('data-set="tunnel.atStart"', st.tunnel.atStart))}
        ${row('Named tunnel', 'Optional. Create it once with <code>cloudflared tunnel create workfloor</code> and route a hostname to it; the address then never changes.', field('data-set="tunnel.name"', st.tunnel.name, 'text', 'placeholder="workfloor"'))}
        ${row('Its address', '', field('data-set="tunnel.url"', st.tunnel.url, 'url', 'placeholder="https://floor.example.com"'))}
      </section>
      <section><div class="subhead">AUTOPILOT</div>
        ${row('Run checks after Build', '', sw('data-set="autopilot.checksAfterBuild"', st.autopilot.checksAfterBuild))}
        ${row('Test on the simulator after Build', 'Mobile tasks: when Build ends with no questions and checks pass, boot a simulator if needed and run the Sim test.', sw('data-set="autopilot.testAfterBuild"', st.autopilot.testAfterBuild))}
        ${row('Fix failing CI', 'When a PR’s CI fails, send the agent at it once per failure.', sw('data-set="autopilot.fixCi"', st.autopilot.fixCi))}
        ${row('Fix new review comments', 'When someone comments on a PR, send the agent to address it.', sw('data-set="autopilot.fixReviews"', st.autopilot.fixReviews))}
        ${row('Pause autopilot at', '5-hour Claude meter, in percent. 0 never pauses.', field('data-set="autopilot.pauseAt" data-num', st.autopilot.pauseAt, 'number', 'min="0" max="100"'))}
      </section>
      <section><div class="subhead">DAILY CHECKOUT</div>
        ${row('Checkout for', 'Who the “What I need from you” part is addressed to.', field('data-set="daily.manager"', st.daily.manager))}
        ${row('Remind me at', 'A chime and a push with your checkout draft ready.', field('data-set="daily.checkoutTime"', st.daily.checkoutTime, 'time'))}
        ${row('Discord webhook', 'Optional. In Discord: channel settings → Integrations → Webhooks. Paste the URL to post checkouts from here.', field('data-set="daily.discordWebhook"', st.daily.discordWebhook, 'url', 'placeholder="https://discord.com/api/webhooks/…"'))}
      </section>
      <section><div class="subhead">STANDUP</div>
        ${row('Daily standup at', 'A summary of the last day, as a chime, a push and (optionally) read on the Mac.', field('data-set="standup.time"', st.standup.time, 'time'))}
        ${row('Read it on the Mac', '', sw('data-set="standup.speak"', st.standup.speak))}
      </section>`;
  }
  function openSettings() { mac?.postMessage({ getLoginItem: true }); $('#settingsDlg').showModal(); renderSettings(); }
  $('#settingsBtn').onclick = openSettings;
  $('#settingsBody').addEventListener('change', (e) => {
    const el = e.target;
    if (el.dataset.pref) {
      prefs()[el.dataset.pref] = el.type === 'checkbox' ? el.checked : Number(el.value);
      savePrefs();
      if (el.checked) audio();
    } else if (el.dataset.set) {
      const value = el.type === 'checkbox' ? el.checked : el.hasAttribute('data-num') ? Number(el.value) : el.value.trim();
      api('settings', nest(el.dataset.set, value)).then((st) => { S.settings = st; }).catch((x) => toast(x.message, 'error'));
    } else if (el.hasAttribute('data-login')) mac?.postMessage({ loginItem: el.checked });
  });
  function settingsTest(what) {
    if (what === 'sound') { audio(); SFX['needs-you'](); setTimeout(() => SFX.done(), 1400); }
    if (what === 'voice') speak('Desk 42 needs you. Which screen should I change?');
    if (what === 'mac') api('settings/say', { text: 'Hello from the office. Desk 42 needs you.' }).catch((x) => toast(x.message, 'error'));
    if (what === 'push') api('settings/push-test', {}).then(() => toast('Test push sent. It should arrive in a few seconds.')).catch((x) => toast(x.message, 'error'));
  }

  // ---------- approvals ----------
  async function approve(el) {
    const aid = el.dataset.approve;
    const note = $(`[data-apnote="${aid}"]`)?.value.trim();
    el.closest('.approval')?.querySelectorAll('button').forEach((b) => { b.disabled = true; });
    try { await api(`approvals/${aid}`, { allow: el.dataset.allow === '1', always: !!el.dataset.always, note }); } catch (x) { toast(x.message, 'error'); }
  }

  // ---------- diff with inline comments ----------
  const diffs = {};
  const comments = (() => { try { return JSON.parse(localStorage.getItem('wf-comments') || '{}'); } catch { return {}; } })();
  const saveComments = () => { try { localStorage.setItem('wf-comments', JSON.stringify(comments)); } catch {} };
  let commenting = null; // { key, repo, path, line, side, code }

  function parseDiff(text) {
    const files = [];
    let f = null;
    let o = 0;
    let n = 0;
    for (const line of text.split('\n')) {
      if (line.startsWith('diff --git ')) { f = { path: line.replace(/^diff --git a\/(.*?) b\/.*$/, '$1'), lines: [], add: 0, del: 0, status: '' }; files.push(f); continue; }
      if (!f) continue;
      let m;
      if ((m = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)/))) { o = +m[1]; n = +m[2]; f.lines.push({ k: 'hunk', text: m[3].trim() }); continue; }
      if (!f.lines.length) {
        if (line.startsWith('+++ ') && line !== '+++ /dev/null') f.path = line.slice(4).replace(/^b\//, '');
        else if (line === '--- /dev/null' || line.startsWith('new file')) f.status = 'new';
        else if (line.startsWith('deleted file')) f.status = 'deleted';
        else if (line.startsWith('rename to ')) { f.path = line.slice(10); f.status = 'renamed'; }
        else if (line.startsWith('Binary files')) f.binary = true;
        continue;
      }
      if (line[0] === '+') { f.lines.push({ k: 'add', n: n++, text: line.slice(1) }); f.add++; }
      else if (line[0] === '-') { f.lines.push({ k: 'del', o: o++, text: line.slice(1) }); f.del++; }
      else if (line[0] === ' ') f.lines.push({ k: 'ctx', o: o++, n: n++, text: line.slice(1) });
    }
    return files;
  }

  function diffHtml(t) {
    const w = t.work || {};
    if (!w.worktree) return emptyState('🧾', 'No worktree yet', 'The diff shows what the agent changed on this task’s branch.', '<button class="btn primary" data-step="setup">Clock in</button>');
    const d = diffs[t.id];
    if (!d || (!d.data && !d.loading && !d.error)) { loadDiff(t.id); return '<p class="muted">Reading the branch…</p>'; }
    if (d.loading && !d.data) return '<p class="muted">Reading the branch…</p>';
    if (d.error) return `<p class="warn-line">${h(d.error)}</p><button class="btn small" data-diffrefresh="1">Try again</button>`;
    const mine = comments[t.id] || [];
    let total = 0;
    const repos = d.data.repos.map((r) => {
      const files = parseDiff(r.diff);
      const fileHtml = files.map((f, fi) => {
        const lines = f.lines.slice(0, 800);
        total += lines.length;
        const rows = lines.map((l) => {
          if (l.k === 'hunk') return `<tr class="hunk"><td colspan="3">${h(l.text) || '···'}</td></tr>`;
          const side = l.k === 'del' ? 'old' : 'new';
          const num = side === 'old' ? l.o : l.n;
          const key = `${r.repo}|${f.path}|${side}|${num}`;
          const here = mine.filter((c) => c.key === key);
          return `<tr class="${l.k}" data-cl="${h(key)}" data-code="${h(l.text.slice(0, 160))}"><td class="ln">${l.o ?? ''}</td><td class="ln">${l.n ?? ''}</td><td class="tx">${h(l.text) || ' '}</td></tr>`
            + here.map((c) => `<tr class="cmt"><td colspan="3"><div class="cmt-box"><span>💬 ${h(c.text)}</span><button type="button" class="linkish" data-cdel="${h(c.id)}">remove</button></div></td></tr>`).join('')
            + (commenting?.key === key ? `<tr class="cmt"><td colspan="3"><div class="cmt-edit"><textarea id="cmtText" rows="2" placeholder="What should the agent change here?"></textarea><div><button type="button" class="btn small primary" data-csave="1">Add comment</button><button type="button" class="btn small ghost" data-ccancel="1">Cancel</button></div></div></td></tr>` : '');
        }).join('');
        const more = f.lines.length > lines.length ? `<tr class="hunk"><td colspan="3">${f.lines.length - lines.length} more lines not shown</td></tr>` : '';
        const open = fi < 6 && f.lines.length < 400;
        return `<details class="dfile" ${open || mine.some((c) => c.path === f.path) ? 'open' : ''}><summary><span class="dpath">${h(f.path)}${f.status ? ` <em>${f.status}</em>` : ''}</span><span class="dstat"><i class="a">+${f.add}</i><i class="d">−${f.del}</i></span></summary>
          ${f.binary ? '<p class="muted small">Binary file</p>' : `<div class="dcode"><table>${rows}${more}</table></div>`}</details>`;
      }).join('');
      const adds = files.reduce((a, f) => a + f.add, 0);
      const dels = files.reduce((a, f) => a + f.del, 0);
      return `<div class="drepo">${d.data.repos.length > 1 ? `<div class="subhead">${h(r.repo.toUpperCase())}</div>` : ''}
        <div class="dsum">${files.length} files · <i class="a">+${adds}</i> <i class="d">−${dels}</i>${r.truncated ? ' · truncated' : ''}</div>${fileHtml || '<p class="muted">No changes on this branch yet.</p>'}</div>`;
    }).join('');
    return `<div class="diff-top"><span class="muted small">Tap a line to leave a comment for the agent.</span><button class="btn small ghost" data-diffrefresh="1">${d.loading ? 'Reading…' : 'Refresh'}</button></div>
      ${repos}
      ${mine.length ? `<div class="cmt-bar"><span>${mine.length} comment${mine.length > 1 ? 's' : ''} waiting</span><button class="btn small ghost" data-cclear="1">Clear</button><button class="btn small primary" data-csend="1">Send to agent</button></div>` : ''}`;
  }

  async function loadDiff(id) {
    diffs[id] = { ...(diffs[id] || {}), loading: true, error: null };
    try { diffs[id] = { data: await api(`tasks/${id}/diff`), loading: false, at: Date.now() }; } catch (e) { diffs[id] = { loading: false, error: e.message }; }
    if (openId === id && tab === 'diff') renderPane();
  }

  function diffClick(el) {
    const id = openId;
    if (el.dataset.diffrefresh) return loadDiff(id).then(() => renderPane());
    if (el.dataset.cl) {
      if (commenting?.key === el.dataset.cl) return;
      const [repo, file, side, line] = el.dataset.cl.split('|');
      commenting = { key: el.dataset.cl, repo, path: file, side, line: Number(line), code: el.dataset.code };
      renderPane();
      return $('#cmtText')?.focus();
    }
    if (el.dataset.ccancel) { commenting = null; return renderPane(); }
    if (el.dataset.csave) {
      const text = $('#cmtText')?.value.trim();
      if (!text) return;
      (comments[id] ||= []).push({ ...commenting, id: Math.random().toString(36).slice(2), text });
      commenting = null;
      saveComments();
      return renderDrawer();
    }
    if (el.dataset.cdel) { comments[id] = (comments[id] || []).filter((c) => c.id !== el.dataset.cdel); saveComments(); return renderDrawer(); }
    if (el.dataset.cclear) { comments[id] = []; saveComments(); return renderDrawer(); }
    if (el.dataset.csend) {
      const list = comments[id] || [];
      const text = 'Review comments on your changes. Address each one, then commit:\n\n'
        + list.map((c, i) => `${i + 1}. ${c.path}:${c.line}${c.side === 'old' ? ' (removed line)' : ''}${c.code ? ` — \`${c.code.trim().slice(0, 100)}\`` : ''}\n   ${c.text}`).join('\n');
      comments[id] = [];
      saveComments();
      tab = 'convo';
      renderDrawer();
      return send(text);
    }
  }

  // ---------- standup and timesheet ----------
  async function openStandup() {
    $('#standupBody').innerHTML = '<p class="muted">Gathering the office…</p>';
    const s = await api('standup').catch((e) => ({ error: e.message }));
    if (s.error) return ($('#standupBody').innerHTML = `<p class="warn-line">${h(s.error)}</p>`);
    $('#standupDlg').dataset.speech = s.speech;
    const days = [];
    const today = new Date();
    for (let i = 83; i >= 0; i--) { const d = new Date(today); d.setDate(d.getDate() - i); days.push(d); }
    const max = Math.max(1, ...Object.values(s.timesheet.days));
    const lvl = (n) => (!n ? 0 : Math.min(4, Math.ceil((n / max) * 4)));
    const star = s.timesheet.star && S.tasks.find((t) => t.id === s.timesheet.star);
    $('#standupBody').innerHTML = `
      <div class="su-totals">
        <div><b>${s.totals.turns}</b><small>agent turns</small></div>
        <div><b>${s.lines.length}</b><small>desks active</small></div>
        <div><b>${s.totals.merged}</b><small>PRs merged</small></div>
        <div class="${s.totals.needs ? 'hot' : ''}"><b>${s.totals.needs}</b><small>need you</small></div>
      </div>
      <div class="su-lines">${s.lines.length ? s.lines.map((l) => `<button class="su-line" data-open="${l.id}">
          <span class="tid">${l.id}</span><span><b>${h(l.title)}</b><small>${h(l.did)} · <em>${h(l.now)}</em>${l.cost ? ` · ${money(l.cost)}` : ''}</small></span></button>`).join('') : '<p class="muted">A quiet day: nothing happened in the last 24 hours.</p>'}</div>
      <div class="subhead">TIMESHEET · LAST 12 WEEKS</div>
      <div class="heat">${days.map((d) => { const k = d.toLocaleDateString('en-CA'); const n = s.timesheet.days[k] || 0; return `<i class="l${lvl(n)}" title="${k}: ${n} turns"></i>`; }).join('')}</div>
      ${star ? `<div class="eotw-card"><div class="eotw-art">${worker(star.id, 'running')}</div><div><span class="pix">EMPLOYEE OF THE WEEK</span><b>${star.id} · ${h(star.title)}</b><small>${s.timesheet.starTurns} agent turns in 7 days</small></div></div>` : ''}
      <div class="set-actions"><button type="button" class="btn ghost" data-daily="say-mac">Read on the Mac</button><button type="button" class="btn" data-daily="say-here">🔊 Read it here</button></div>`;
  }

  // ---------- Daily: standup, checkout, check-in topics, new task ----------
  let dtab = 'standup';
  const today = () => new Date().toLocaleDateString('en-CA');
  const store = (k, v) => { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch { return null; } };
  function openDaily(which) {
    if (which) dtab = which;
    // Check-in topics only exist when setup (or notion.checkin) names the property that marks them.
    const topicsOn = S.notionCheckin !== false;
    $('#dailyTabs [data-dtab="topics"]').hidden = !topicsOn;
    if (dtab === 'topics' && !topicsOn) dtab = 'standup';
    const dlg = $('#standupDlg');
    if (!dlg.open) dlg.showModal();
    $('#dailyTabs').querySelectorAll('button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.dtab === dtab)));
    ({ standup: openStandup, checkout: renderCheckout, topics: renderTopics, newtask: renderNewTask })[dtab]();
  }
  const openStandupTab = () => openDaily('standup');
  $('#standupBtn').onclick = () => openDaily();
  $('#newTaskBtn').onclick = () => openDaily('newtask');
  $('#dailyTabs').onclick = (e) => { const b = e.target.closest('[data-dtab]'); if (b) openDaily(b.dataset.dtab); };

  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); return true; } catch {}
    // Plain-http pages on a phone have no clipboard API: fall back to a hidden textarea.
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;opacity:0';
    $('#standupDlg').append(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }

  async function renderCheckout(reset) {
    const key = `wf-checkout-${today()}`;
    $('#standupBody').innerHTML = '<p class="muted">Looking at today…</p>';
    const c = await api('daily/checkout').catch((e) => ({ error: e.message }));
    if (c.error) return ($('#standupBody').innerHTML = `<p class="warn-line">${h(c.error)}</p>`);
    const saved = !reset && store(key);
    $('#standupBody').innerHTML = `
      <p class="muted small">Today's checkout for ${h(c.manager)}, in the team's format. Edit freely; it's saved on this device.</p>
      <textarea id="coText" class="co-text" rows="14" spellcheck="true">${h(saved || c.draft)}</textarea>
      <div class="set-actions">
        <button type="button" class="btn primary" data-daily="co-write">✨ Write it with Claude</button>
        <button type="button" class="btn" data-daily="co-copy">Copy</button>
        ${c.discord ? '<button type="button" class="btn" data-daily="co-discord">Send to Discord</button>' : ''}
        <button type="button" class="btn ghost" data-daily="co-reset">Start over from today</button>
      </div>
      ${c.discord ? '' : '<p class="muted small">Add a Discord webhook in ⚙ Settings → Daily checkout to post it straight to your channel.</p>'}`;
    $('#coText').oninput = (e) => store(key, e.target.value);
  }

  async function renderTopics(fresh) {
    const mine = (S.tasks || []).filter((t) => t.work?.agent?.status === 'needs-you' && t.work.agent.last);
    const pickQ = (txt) => (txt || '').split('\n').map((l) => l.replace(/[#*_`>]/g, '').replace(/^\s*(?:[-•]|\d+[.)])\s+/, '').trim()).find((l) => l.endsWith('?')) || '';
    const ideas = mine.map((t) => ({ id: t.id, q: pickQ(t.work.agent.last) })).filter((x) => x.q).slice(0, 4);
    $('#standupBody').innerHTML = `
      <div class="topic-add">
        <input id="topicTitle" class="set-input wide" placeholder="Topic to raise at the next check-in" autocomplete="off">
        <textarea id="topicBody" class="set-input wide" rows="2" placeholder="Context (optional): what you need decided and why"></textarea>
        ${ideas.length ? `<div class="chips"><span class="muted small">From your desks:</span>${ideas.map((x) => `<button type="button" class="chip-btn" data-topicidea="${h(`${x.id}: ${x.q}`)}">${h(x.id)} · ${h(x.q.slice(0, 60))}</button>`).join('')}</div>` : ''}
        <div class="set-actions"><button type="button" class="btn primary" data-daily="topic-add">Add check-in topic</button></div>
      </div>
      <div class="subhead">OPEN TOPICS ON NOTION <button type="button" class="linkish" data-daily="topic-refresh">refresh</button></div>
      <div id="topicList"><p class="muted">Reading Notion…${S.notion?.hasToken ? '' : ' (about a minute without an API token)'}</p></div>`;
    const res = await api(`notion/topics${fresh ? '?fresh=1' : ''}`).catch((e) => ({ error: e.message }));
    if (!$('#topicList')) return;
    $('#topicList').innerHTML = res.error ? `<p class="warn-line">${h(res.error)}</p>`
      : res.topics.length ? res.topics.map((t) => `<a class="topic-row" href="${h(t.url)}" target="_blank" rel="noopener"><span class="tid">TASK-${h(t.TASK)}</span><span><b>${h(t.title)}</b><small>${h(t.status || 'not-started')}${t.priority ? ` · ${h(t.priority)}` : ''}${t.mine ? ' · yours' : ''}</small></span></a>`).join('')
      : '<p class="muted">No open check-in topics.</p>';
  }

  let notionOptions = null;
  async function renderNewTask() {
    notionOptions ||= await api('notion/options').catch(() => null);
    const o = notionOptions || { priority: [], tags: [], complexity: [], testingType: [] };
    // Only the fields your database has: setup saved their options.
    const field = (label, name, list) => (list?.length ? `<label class="field">${label}${sel(name, list)}</label>` : '');
    const sel = (name, list) => `<select class="set-input" name="${name}"><option value="">—</option>${list.map((v) => `<option>${h(v)}</option>`).join('')}</select>`;
    const checks = (name, list, on = []) => `<div class="chips">${list.map((v) => `<label class="chip-check"><input type="checkbox" name="${name}" value="${h(v)}" ${on.includes(v) ? 'checked' : ''}><span>${h(v)}</span></label>`).join('')}</div>`;
    $('#standupBody').innerHTML = `
      <div class="nt-form" id="ntForm">
        <label class="field">TASK NAME<input class="set-input wide" name="title" placeholder="What needs doing" autocomplete="off"></label>
        <label class="field">DETAILS<textarea class="set-input wide" name="description" rows="4" placeholder="Acceptance criteria, links, what done looks like…"></textarea></label>
        <div class="nt-grid">
          ${field('PRIORITY', 'priority', o.priority)}
          ${field('COMPLEXITY', 'complexity', o.complexity)}
          ${field('AUDIENCE', 'testingType', o.testingType)}
          <label class="field">DUE DATE<input class="set-input" type="date" name="due"></label>
        </div>
        ${o.tags?.length ? `<div class="field">TAGS${checks('tags', o.tags)}</div>` : ''}
        <label class="check"><input type="checkbox" name="assignToMe" checked> Assign to me (it shows up on the board right away)</label>
        <div class="set-actions"><button type="button" class="btn primary" data-daily="task-create">Create in Notion</button></div>
        <p class="muted small" id="ntNote">${S.notion?.hasToken ? 'Created through the Notion API.' : 'Created through Claude and your Notion connector: takes about a minute.'}</p>
      </div>`;
  }
  function formValues(form) {
    const v = {};
    for (const el of form.querySelectorAll('[name]')) {
      if (el.type === 'checkbox' && el.name === 'tags') { v[el.name] ||= []; if (el.checked) v[el.name].push(el.value); }
      else if (el.type === 'checkbox') v[el.name] = el.checked;
      else v[el.name] = el.value.trim();
    }
    return v;
  }

  async function dailyAction(el) {
    const a = el.dataset.daily;
    const busy = (label) => { el.disabled = true; el.dataset.label = el.textContent; el.textContent = label; };
    const done = () => { el.disabled = false; if (el.dataset.label) el.textContent = el.dataset.label; };
    if (a === 'say-here') return speak($('#standupDlg').dataset.speech);
    if (a === 'say-mac') return api('settings/say', { text: $('#standupDlg').dataset.speech }).catch((x) => toast(x.message, 'error'));
    if (a === 'co-copy') return copyText($('#coText').value).then((ok) => toast(ok ? 'Copied. Paste it in your channel.' : 'Could not copy: select the text and copy it.', ok ? 'info' : 'warn'));
    if (a === 'co-reset') return renderCheckout(true);
    if (a === 'co-write') {
      busy('Writing… (about 30s)');
      try {
        const { text } = await api('daily/checkout', { text: $('#coText').value });
        $('#coText').value = text;
        store(`wf-checkout-${today()}`, text);
      } catch (x) { toast(x.message, 'error'); }
      return done();
    }
    if (a === 'co-discord') {
      if (!armed(el, 'Tap again to post it')) return;
      delete el.dataset.armed;
      el.classList.remove('armed');
      busy('Posting…');
      try { await api('daily/discord', { text: $('#coText').value }); toast('Posted to Discord.'); } catch (x) { toast(x.message, 'error'); }
      el.dataset.label = 'Send to Discord';
      return done();
    }
    if (a === 'topic-refresh') return renderTopics(true);
    if (a === 'topic-add') {
      const title = $('#topicTitle').value.trim();
      if (!title) return $('#topicTitle').focus();
      busy('Adding…');
      try {
        const r = await api('notion/tasks', { title, description: $('#topicBody').value, checkin: true, assignToMe: true });
        toast(`Added ${r.task ? 'TASK-' + r.task : 'the topic'} to check-in topics.`);
        return renderTopics(true);
      } catch (x) { toast(x.message, 'error'); return done(); }
    }
    if (a === 'task-create') {
      const v = formValues($('#ntForm'));
      if (!v.title) return $('#ntForm [name=title]').focus();
      busy('Creating…');
      try {
        const r = await api('notion/tasks', v);
        $('#ntNote').innerHTML = `Created <a href="${h(r.url)}" target="_blank" rel="noopener">${r.task ? 'TASK-' + r.task : 'the task'} ↗</a>${v.assignToMe && r.task ? ` · <button type="button" class="linkish" data-open="TASK-${r.task}">open it on the board</button>` : ''}`;
        $('#ntForm [name=title]').value = '';
        $('#ntForm [name=description]').value = '';
      } catch (x) { toast(x.message, 'error'); }
      return done();
    }
  }
  document.addEventListener('click', (e) => {
    const chip = e.target.closest('[data-topicidea]');
    if (chip) { $('#topicTitle').value = chip.dataset.topicidea; $('#topicTitle').focus(); }
  });

  // ---------- clock out ----------
  async function clockOut(el, force) {
    if (!armed(el, force ? 'Tap again: discard and remove' : 'Tap again to clock out')) return;
    el.disabled = true;
    el.textContent = 'Clocking out…';
    const deleteBranch = !!$('#coBranch')?.checked;
    try {
      const res = await fetch(`/api/tasks/${encodeURIComponent(openId)}/clockout`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ deleteBranch, force }) });
      const body = await res.json().catch(() => ({}));
      if (res.status === 409) {
        $('#clockoutBox').innerHTML = `<p class="warn-line">${h(body.error)}</p>
          <div class="set-actions"><button type="button" class="btn danger" data-clockout="force">Discard them and clock out</button><button type="button" class="btn ghost" data-tab="diff">See the diff</button></div>`;
        return;
      }
      if (!res.ok) throw new Error(body.error || res.statusText);
      toast('Clocked out. The worktree is gone and the desk is free.');
      closeTask();
    } catch (x) { toast(x.message, 'error'); el.disabled = false; el.textContent = 'Clock out'; }
  }
  const clockoutHtml = (w) => `<div class="clockout ${w.pr?.state === 'MERGED' ? 'merged' : ''}" id="clockoutBox">
      <b>${w.pr?.state === 'MERGED' ? '🎉 Merged. Time to clock out?' : 'Clock out'}</b>
      <small>Ends the agent's conversation and removes the worktree${(w.extra || []).length ? 's' : ''}. ${w.pr?.state === 'MERGED' ? 'The work is safe on main.' : 'The PR is not merged yet: only do this if you are dropping the task.'}</small>
      <label class="check"><input type="checkbox" id="coBranch" ${w.pr?.state === 'MERGED' ? 'checked' : ''}> Also delete the local branch <code>${h(w.branch || '')}</code></label>
      <div class="set-actions"><button type="button" class="btn ${w.pr?.state === 'MERGED' ? 'primary' : 'danger'}" data-clockout="1">Clock out</button></div>
    </div>`;

  // ---------- severity and model ----------
  // A quick read from the task's own fields; "Read the task" asks Claude to read the Notion page too.
  const MODEL_FOR = [null, 'haiku', 'sonnet', 'sonnet', 'opus', 'fable'];
  function rateTask(t) {
    let score = 2;
    const why = [];
    const title = t.title || '';
    if (t.complexity === 'High') { score += 1.5; why.push('marked high complexity'); }
    if (t.complexity === 'Low') { score -= 1; why.push('marked low complexity'); }
    if (t.priority === 'High') { score += 0.5; why.push('high priority'); }
    if (/security|auth|payment|billing|money|migrat|privacy|leak|data loss|encrypt|token|permission|fraud/i.test(title)) { score += 1.5; why.push('touches security, money or data'); }
    if (/architecture|refactor|rewrite|performance|race|crash|sync|offline/i.test(title)) { score += 1; why.push('cross-cutting or performance work'); }
    if (/\b(copy|typo|text|spacing|padding|colou?r|label|icon|rename|wording)\b/i.test(title)) { score -= 1; why.push('looks like a UI or copy tweak'); }
    if ((t.tags || []).includes('redesign')) { score += 0.5; why.push('redesign'); }
    if (/production/i.test(title)) why.push('production issue');
    const severity = Math.min(5, Math.max(1, Math.round(score)));
    return { severity, model: MODEL_FOR[severity], reasons: why.slice(0, 3).length ? why.slice(0, 3) : ['a normal-sized task'] };
  }
  function renderSeverity(g, deep) {
    $('#sevBox').innerHTML = `<div class="sev-bar">${[1, 2, 3, 4, 5].map((n) => `<i class="${n <= g.severity ? `on s${g.severity}` : ''}"></i>`).join('')}<b>${g.severity}/5</b></div>
      <small>${h(g.reasons.join(' · '))}. Suggested: <b>${h(g.model[0].toUpperCase() + g.model.slice(1))}</b>${deep ? ' (Claude read the task)' : ''}.</small>
      ${deep ? '' : '<button type="button" class="linkish" id="gaugeDeep">Read the task and gauge it with Claude (about a minute)</button>'}`;
    $('#modelSeg').querySelectorAll('label').forEach((l) => l.classList.toggle('suggested', l.querySelector('input').value === g.model));
  }

  // ---------- remote control for a simulator ----------
  let remote = null; // { id, timer }
  function openRemote(id) {
    const d = D.booted.find((x) => x.id === id);
    if (!d) return;
    remote = { id };
    $('#remoteName').textContent = d.name;
    const img = $('#remoteImg');
    const refresh = () => { img.src = `/api/devices/${encodeURIComponent(id)}/screen?t=${Date.now()}`; };
    refresh();
    remote.timer = setInterval(() => { if (!document.hidden && !remote?.busy) refresh(); }, 2500);
    remote.refresh = refresh;
    const dlg = $('#remoteDlg');
    dlg.showModal();
    dlg.onclose = () => { clearInterval(remote?.timer); remote = null; };
  }
  async function remoteSend(body) {
    if (!remote || remote.busy) return;
    remote.busy = true;
    $('#remoteBusy').hidden = false;
    try { await api(`devices/${encodeURIComponent(remote.id)}/input`, body); } catch (e) { toast(e.message, 'error'); }
    if (!remote) return;
    remote.busy = false;
    $('#remoteBusy').hidden = true;
    setTimeout(() => remote?.refresh(), 350);
  }
  (() => {
    const img = $('#remoteImg');
    let start = null;
    const frac = (e) => { const r = img.getBoundingClientRect(); return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height }; };
    img.addEventListener('pointerdown', (e) => { e.preventDefault(); start = frac(e); });
    img.addEventListener('pointerup', (e) => {
      if (!start) return;
      const end = frac(e);
      const moved = Math.hypot(end.x - start.x, end.y - start.y) > 0.03;
      remoteSend(moved ? { type: 'swipe', x: start.x, y: start.y, x2: end.x, y2: end.y } : { type: 'tap', x: end.x, y: end.y });
      start = null;
    });
  })();
  function remoteKey(k) {
    if (k === 'text') { const v = $('#remoteText').value; if (!v) return; $('#remoteText').value = ''; return remoteSend({ type: 'text', text: v }); }
    return remoteSend({ type: k });
  }

  // ---------- release room ----------
  // Two jobs: ship a new version (rc branch → bump PR → store build → OTA), or run a script on a
  // branch that already exists (an OTA for what's live on main, say). The terminal sits beside them.
  let relInfo = null;
  let relOut = '';
  let relMode = null;
  const quick = { ref: null, kind: 'ota', dry: true, ignoreFp: false };
  const relBusy = (r) => ['running', 'waiting'].includes(r?.run?.status);
  const ago2 = (t) => { const m = Math.round((Date.now() - t) / 60000); return m < 60 ? `${m}m ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`; };

  // Top-right button: lights up while a script runs and when one is waiting for you.
  function renderReleaseStrip() {
    const r = S?.release || {};
    const btn = $('#releaseBtn');
    if (!btn) return;
    const st = r.run?.status === 'waiting' ? 'needs-you' : r.run?.status === 'running' ? 'running' : '';
    btn.classList.toggle('rel-running', st === 'running');
    btn.classList.toggle('rel-waiting', st === 'needs-you');
    btn.title = st === 'needs-you' ? `Release is waiting for you: ${r.run.prompt}` : st === 'running' ? `yarn release:${r.run.kind} is running on ${r.run.ref}` : r.version ? `Release ${r.version} in progress` : 'Release room';
    $('#releaseLbl').textContent = r.version ? `Release ${r.version}` : 'Release';
  }

  async function openRelease() {
    $('#releaseDlg').showModal();
    relOut = (await api('release/log').catch(() => ({ out: '' }))).out;
    renderRelease();
    relInfo = await api('release?fresh=1').catch((e) => ({ error: e.message }));
    if ($('#releaseDlg').open) renderRelease();
  }
  $('#releaseBtn').onclick = openRelease;
  $('#ticker').onclick = () => { const id = $('#ticker').dataset.id; if (id && S.tasks.some((t) => t.id === id)) openTask(id, 'convo'); else openDaily('standup'); };

  function relStepState(r) {
    const bumpsDone = (r.bumps || []).length && r.bumps.every((b) => b.skipped || b.state === 'MERGED');
    const runDone = (k) => r.runs?.[k]?.status === 'done' && !r.runs[k].dryRun;
    return [!!r.rc, !!bumpsDone, runDone('native'), runDone('ota')];
  }

  function renderRelease() {
    const r = S.release || {};
    const info = relInfo || {};
    const busy = relBusy(r);
    relMode ||= r.version ? 'new' : 'quick';
    const when = (t) => new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

    // header status
    const run = r.run;
    $('#relTitle').innerHTML = run && busy
      ? `<span class="rel-pill ${run.status}">${run.status === 'waiting' ? 'WAITING FOR YOU' : 'RUNNING'}</span>`
      : r.version ? `<span class="rel-pill">${h(r.version)} · ${h(r.env)}</span>` : '';

    // what's live, from the GitHub releases the scripts publish
    const chip = (x, label) => (x ? `<a class="live-chip" href="${h(x.url)}" target="_blank" rel="noopener" title="${h(x.tag)} · ${when(x.at)}"><b>${h(x.version)}</b>${label}<small>${ago2(x.at)}</small></a>` : '');
    const live = info.live ? `<div class="rel-live">${['production', 'staging'].map((env) => {
      const l = info.live[env];
      return `<div class="live-row ${env}"><span class="pix">${env.toUpperCase()}</span>${chip(l.ios, 'iOS')}${chip(l.android, 'Android')}${l.ota[0] ? chip(l.ota[0], 'OTA') : ''}${!l.ios && !l.android && !l.ota[0] ? '<span class="muted small">nothing yet</span>' : ''}</div>`;
    }).join('')}</div>` : `<div class="rel-live"><span class="muted small">${info.error ? h(info.error) : 'Reading what’s live…'}</span></div>`;

    const tabs = `<div class="rel-tabs" role="tablist">
        <button type="button" data-rel="mode" data-mode="new" aria-selected="${relMode === 'new'}">🚀 Ship a new version</button>
        <button type="button" data-rel="mode" data-mode="quick" aria-selected="${relMode === 'quick'}">⚡ OTA or build an existing branch</button>
      </div>`;

    $('#relBody').innerHTML = live + tabs + (relMode === 'new' ? newReleaseHtml(r, info, busy) : quickHtml(r, info, busy));
    renderTerm(r);
  }

  function newReleaseHtml(r, info, busy) {
    const done = relStepState(r);
    const current = done.findIndex((d) => !d);
    const runState = (k) => (r.run?.kind === k && r.run.ref === r.rc?.branch && relBusy(r) ? (r.run.status === 'waiting' ? 'waiting for you' : 'running…')
      : r.runs?.[k] ? `${r.runs[k].dryRun ? 'dry run ' : ''}${r.runs[k].status} · ${ago2(r.runs[k].at)}` : '');
    // Done steps collapse to their title; steps not reached yet show one line, no controls.
    const step = (i, title, body, status, later) => {
      const state = done[i] ? 'done' : i === current || (current === -1 && i === 3) ? 'current' : i < current ? 'current' : 'todo';
      const content = state === 'todo' ? `<p class="muted small">${later}</p>` : done[i] && !status ? '' : body;
      return `<li class="rel-step ${state}"><span class="dot">${done[i] ? '✓' : i + 1}</span>
        <div class="step-main"><div class="step-top"><b>${title}</b>${status ? `<small>${status}</small>` : ''}</div>${content}</div></li>`;
    };
    const gh = info.owner ? `https://github.com/${info.owner}/${info.repo}` : '';
    const s1 = r.rc
      ? `<p><code>${h(r.rc.branch)}</code> ${r.rc.existed ? 'already existed' : `from ${h(r.rc.from || 'main')}`} at <code>${h((r.rc.sha || '').slice(0, 9))}</code>${gh ? ` · <a href="${gh}/tree/${h(r.rc.branch)}" target="_blank" rel="noopener">GitHub ↗</a>` : ''}</p>`
      : `<div class="ver-pick"><input id="relVersion" class="set-input ver" value="${h(r.version || info.suggestions?.[0]?.version || '')}" placeholder="5.10.3" autocomplete="off" inputmode="decimal">
          ${(info.suggestions || []).map((x) => `<button type="button" class="chip-btn" data-relver="${x.version}">${x.version}<small> ${x.env}</small></button>`).join('')}</div>
        <p class="muted small">${info.mainVersion ? `main is on ${h(info.mainVersion)}, latest rc is ${h(info.rcBranches?.[0] || 'none')}. Odd patch = production, even = staging.` : ''} The branch is created on GitHub from <code>origin/${h(info.base || 'main')}</code>; local checkouts aren't touched.</p>
        <button type="button" class="btn primary" data-rel="rc" ${busy ? 'disabled' : ''}>Create the rc branch</button>`;
    const prs = (r.bumps || []).map((b) => (b.skipped ? `<p class="muted small">${h(b.base)}: ${h(b.skipped)}</p>`
      : `<div class="rel-pr"><a href="${h(b.url)}" target="_blank" rel="noopener">#${b.number}</a><span>→ ${h(b.base)}</span><span class="chip">${h((b.state || '').toLowerCase())}</span>${b.ci ? `<small>${h(b.ci)}</small>` : ''}${b.state === 'OPEN' ? `<button type="button" class="btn tiny" data-rel="merge" data-num="${b.number}">Squash & merge</button>` : ''}</div>`)).join('');
    const s2 = !r.rc ? '<p class="muted small">After the rc branch.</p>'
      : (r.bumps || []).length ? `${prs}<button type="button" class="linkish" data-rel="prs">refresh</button>`
      : `<p>Sets <code>APP_VERSION</code> to <b>${h(r.version)}</b> in app.config.ts and opens a PR into <code>${h(r.rc.branch)}</code>.</p>
        <label class="check"><input type="checkbox" id="relAlsoMain" checked> Also into ${h(info.base || 'main')}${info.mainVersion ? ` (now ${h(info.mainVersion)})` : ''}</label>
        <button type="button" class="btn primary" data-rel="bump" ${busy ? 'disabled' : ''}>Open the bump PR</button>`;
    const runBtns = (k, label) => (!r.rc ? '<p class="muted small">After the rc branch.</p>'
      : `<div class="set-actions"><button type="button" class="btn" data-rel="run" data-kind="${k}" data-dry="1" ${busy ? 'disabled' : ''}>Dry run</button><button type="button" class="btn primary" data-rel="run" data-kind="${k}" ${busy ? 'disabled' : ''}>${label}</button></div>`);
    return `<ol class="steps">
      ${step(0, `Version and rc branch${r.version ? ` · ${h(r.version)}` : ''}`, s1, r.rc ? `${h(r.rc.branch)} ✓` : '', '')}
      ${step(1, 'Version bump PR', s2, (r.bumps || []).filter((b) => b.number).map((b) => `#${b.number} ${(b.state || '').toLowerCase()}`).join(' · '), 'Sets APP_VERSION and opens a PR into the rc branch.')}
      ${step(2, 'Store build', `<p><code>yarn release:native</code> on <code>${h(r.rc?.branch || 'the rc')}</code>: EAS build and store submit (20–40 min), then tags and the GitHub release.</p>${runBtns('native', 'Build & submit')}`, runState('native'), 'yarn release:native on the rc: EAS build, store submit, tags and the GitHub release.')}
      ${step(3, 'OTA update <small class="opt">optional</small>', `<p><code>yarn release:ota</code> on <code>${h(r.rc?.branch || 'the rc')}</code>: fingerprint check, eas update, tag and the GitHub release.</p>
          <label class="check"><input type="checkbox" id="relIgnoreFp"> --ignore-fingerprint</label>${runBtns('ota', 'Publish OTA')}`, runState('ota'), 'yarn release:ota on the rc, if you ship fixes after the store build.')}
    </ol>
    ${r.version ? `<button type="button" class="linkish rel-reset" data-rel="new" ${busy ? 'disabled' : ''}>Forget this release and start another</button>` : ''}`;
  }

  function quickHtml(r, info, busy) {
    if (!info.branches) return `<p class="muted">${info.error ? h(info.error) : 'Reading branches…'}</p>`;
    quick.ref ||= info.branches[0]?.name;
    const liveVersions = new Set(['ios', 'android'].map((k) => info.live?.production?.[k]?.version).concat(info.live?.production?.ota?.map((x) => x.version) || []).filter(Boolean));
    const b = info.branches.find((x) => x.name === quick.ref) || info.branches[0];
    const verb = quick.kind === 'ota' ? (quick.dry ? 'Dry run the OTA' : 'Publish the OTA') : quick.dry ? 'Dry run the store build' : 'Build & submit';
    const last = r.adhoc ? `<p class="muted small">Last: ${r.adhoc.dryRun ? 'dry run of ' : ''}${r.adhoc.kind === 'ota' ? 'OTA' : 'store build'} on <code>${h(r.adhoc.ref)}</code> (${h(r.adhoc.version)}) · ${h(r.adhoc.status)} · ${ago2(r.adhoc.at)}</p>` : '';
    return `<div class="rel-quick">
        <div class="q-label">BRANCH</div>
        <div class="branch-list">${info.branches.map((x) => `<label class="branch-opt"><input type="radio" name="qref" value="${h(x.name)}" ${x.name === b.name ? 'checked' : ''}>
            <span><b>${h(x.name)}</b><code>${h(x.version || '?')}</code>${liveVersions.has(x.version) ? '<em>live</em>' : ''}</span></label>`).join('')}</div>
        <div class="q-label">WHAT</div>
        <div class="seg q-kind">
          <label><input type="radio" name="qkind" value="ota" ${quick.kind === 'ota' ? 'checked' : ''}><span>OTA update<small>yarn release:ota</small></span></label>
          <label><input type="radio" name="qkind" value="native" ${quick.kind === 'native' ? 'checked' : ''}><span>Store build<small>yarn release:native</small></span></label>
        </div>
        <label class="check"><input type="checkbox" name="qdry" ${quick.dry ? 'checked' : ''}> Dry run: show the plan, publish nothing</label>
        ${quick.kind === 'ota' ? `<label class="check"><input type="checkbox" name="qfp" ${quick.ignoreFp ? 'checked' : ''}> --ignore-fingerprint</label>` : ''}
        <button type="button" class="btn ${quick.dry ? '' : 'primary'} q-go" data-rel="qrun" ${busy ? 'disabled' : ''}>${verb} on ${h(b.name)} (${h(b.version || '?')})</button>
        ${quick.kind === 'ota' ? `<p class="muted small">An OTA reaches every store build of ${h(b.version || 'that version')} on the channel you pick when it asks.</p>` : ''}
        ${last}
      </div>`;
  }

  // One-tap answers read from the prompt itself: [y/N], (a/b/c) options, or a [default].
  function promptChoices(p) {
    if (/\[y\/N\]\s*$/i.test(p)) return [['Yes', 'y', 'primary'], ['No', 'n', '']];
    const def = p.match(/\[([^\]]+)\]\s*:?\s*$/)?.[1];
    const opts = p.match(/\(([^()]+\/[^()]+)\)/)?.[1].split('/').map((x) => x.trim());
    if (opts) return opts.map((o) => [o, o, o === def ? 'primary' : '']);
    return def ? [[`Use ${def}`, '', 'primary']] : [];
  }

  function renderTerm(r) {
    const run = r.run;
    const show = !!relOut || relBusy(r);
    $('#releaseDlg').classList.toggle('has-term', show);
    $('#relTerm').hidden = !show;
    if (!show) return;
    $('#relTermHead').innerHTML = run ? `<code>yarn release:${h(run.kind)}${run.dryRun ? ' --dry-run' : ''}</code> on <b>${h(run.ref || '')}</b>${run.version ? ` (${h(run.version)})` : ''}
        <span class="state ${run.status === 'waiting' ? 'needs-you' : run.status === 'running' ? 'running' : run.status === 'done' ? 'pass' : 'fail'}">${h(run.status)}</span>
        ${relBusy(r) ? '<button type="button" class="btn tiny danger" data-rel="ctrlc" title="Interrupt (Ctrl-C)">Stop</button>' : ''}` : '';
    const waiting = run?.status === 'waiting';
    $('#relPrompt').hidden = !waiting;
    if (waiting) {
      $('#relPrompt').innerHTML = `<div class="q">${h(run.prompt)}</div>
        <div class="answers">${promptChoices(run.prompt).map(([label, text, cls]) => `<button type="button" class="btn ${cls}" data-rel="answer" data-text="${h(text)}">${h(label)}</button>`).join('')}</div>
        <div class="term-input"><input id="relInput" placeholder="Or type an answer" autocomplete="off" enterkeyhint="send"><button type="button" class="btn small" data-rel="send">Send</button></div>`;
      $('#relInput').onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); $('[data-rel="send"]').click(); } };
    }
    paintTerm();
  }

  // The scripts write colors and carriage returns; show plain lines, colored by their markers.
  function paintTerm() {
    const pre = $('#relOut');
    if (!pre) return;
    const plain = relOut.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');
    const lines = plain.split('\n').map((l) => l.split('\r').filter(Boolean).pop() || '').slice(-600);
    const cls = (l) => (/^\s*✔/.test(l) ? 'ok' : /^\s*✖/.test(l) ? 'bad' : /^\s*⚠/.test(l) ? 'warn' : /^\s*›/.test(l) ? 'info' : '');
    const near = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 60;
    pre.innerHTML = lines.map((l) => `<span class="${cls(l)}">${h(l)}</span>`).join('\n') || '<span class="muted">Starting…</span>';
    if (near) pre.scrollTop = pre.scrollHeight;
  }

  $('#relBody').addEventListener('change', (e) => {
    const el = e.target;
    if (el.name === 'qref') quick.ref = el.value;
    else if (el.name === 'qkind') quick.kind = el.value;
    else if (el.name === 'qdry') quick.dry = el.checked;
    else if (el.name === 'qfp') quick.ignoreFp = el.checked;
    else return;
    renderRelease();
  });

  async function releaseAction(el) {
    const a = el.dataset.rel;
    const r = S.release || {};
    const call = async (path, body, label) => {
      el.disabled = true;
      const old = el.textContent;
      if (label) el.textContent = label;
      try { S.release = await api(path, body); renderReleaseStrip(); renderRelease(); } catch (x) { toast(x.message, 'error'); el.disabled = false; el.textContent = old; }
    };
    const start = (body) => { relOut = ''; return call('release/run', body, 'Starting…'); };
    if (a === 'open') return openRelease();
    if (a === 'mode') { relMode = el.dataset.mode; return renderRelease(); }
    if (a === 'rc') {
      const v = $('#relVersion')?.value.trim() || r.version;
      if (!/^\d+\.\d+\.\d+$/.test(v || '')) return toast('Use a version like 5.10.3', 'warn');
      if (!armed(el, `Tap again: create rc-${v} on GitHub`)) return;
      return call('release/rc', { version: v }, 'Creating…');
    }
    if (a === 'bump') { if (!armed(el, 'Tap again: push and open the PR')) return; return call('release/bump', { alsoMain: $('#relAlsoMain')?.checked }, 'Opening…'); }
    if (a === 'prs') return call('release/prs', {}, 'Refreshing…');
    if (a === 'merge') { if (!armed(el, `Tap again: merge #${el.dataset.num}`)) return; return call('release/merge', { number: Number(el.dataset.num) }, 'Merging…'); }
    if (a === 'run') {
      const dry = !!el.dataset.dry;
      if (!dry && !armed(el, `Tap again: run on ${r.rc.branch}`)) return;
      return start({ kind: el.dataset.kind, ref: r.rc.branch, dryRun: dry, ignoreFingerprint: $('#relIgnoreFp')?.checked });
    }
    if (a === 'qrun') {
      if (!quick.dry && !armed(el, `Tap again: really ${quick.kind === 'ota' ? 'publish' : 'build'} on ${quick.ref}`)) return;
      return start({ kind: quick.kind, ref: quick.ref, dryRun: quick.dry, ignoreFingerprint: quick.kind === 'ota' && quick.ignoreFp });
    }
    if (a === 'new') { if (!armed(el, 'Tap again: forget this release')) return; relOut = ''; relMode = 'new'; return call('release/new', {}); }
    const send = (body) => api('release/input', body).then((rel) => { S.release = rel; renderRelease(); }).catch((x) => toast(x.message, 'error'));
    if (a === 'answer') return send({ text: el.dataset.text });
    if (a === 'send') { const v = $('#relInput').value; $('#relInput').value = ''; return send({ text: v }); }
    if (a === 'ctrlc') { if (!armed(el, 'Stop it?')) return; return send({ key: 'ctrl-c' }); }
  }

  // ---------- device lab ----------
  let D = { booted: [], available: [] };
  const KIND = { 'ios-sim': 'Simulator', 'android-emu': 'Android emulator', android: 'Android device', 'ios-device': 'iPhone · connected' };
  const shotUrl = (id) => `/api/devices/${encodeURIComponent(id)}/screen?t=${Math.floor(Date.now() / 15000)}`;
  // Which task is testing on which simulator, from the tasks' own state.
  const testingOn = (devId) => S?.tasks.find((t) => t.work?.simtest?.device === devId && t.work?.agent?.status === 'running');

  async function loadDevices(force) {
    if (force) $('#lab').classList.add('loading');
    try { D = await api('devices'); } catch {}
    $('#lab').classList.remove('loading');
    renderLab();
  }

  function renderLab() {
    // The topbar button carries the count of running devices; amber while an agent is testing on one.
    const count = $('#devCount');
    count.hidden = !D.booted.length;
    count.textContent = D.booted.length;
    $('#devicesBtn').classList.toggle('dev-testing', D.booted.some((d) => testingOn(d.id)));
    $('#labActions').innerHTML = '<button type="button" class="btn small ghost" data-labrefresh="1" title="Refresh devices">↻</button>';
    const act = (d, a, label, cls = '') => `<button type="button" class="btn tiny ${cls}" data-devact="${a}" data-dev="${h(d.id)}">${label}</button>`;
    const on = D.booted.map((d) => {
      const busy = testingOn(d.id);
      const screen = d.kind === 'ios-device' ? '<div class="handset-off">📱<small>Screen not shared</small></div>' : `<img src="${shotUrl(d.id)}" alt="${h(d.name)} screen" loading="lazy">`;
      const actions = (d.kind !== 'ios-device' ? act(d, 'remote', 'Remote', 'primary') : '')
        + (d.kind === 'ios-sim' ? act(d, 'shutdown', 'Shut down') + act(d, 'delete', 'Delete', 'danger') : d.kind === 'android-emu' ? act(d, 'shutdown', 'Shut down') : '');
      return `<div class="rig ${busy ? 'busy' : ''}">
        <a class="handset" ${d.kind === 'ios-device' ? '' : `href="${shotUrl(d.id)}" target="_blank"`}>${screen}${busy ? '<span class="rec">REC</span>' : ''}</a>
        <div class="rig-plate"><b>${h(d.name)}</b><small>${h(d.os)} · ${KIND[d.kind]}</small>
          <span class="state ${busy ? 'running' : 'idle'}">${busy ? `Testing ${busy.id}` : 'Free'}</span></div>
        ${actions ? `<div class="rig-actions">${actions}</div>` : ''}
      </div>`;
    });
    const off = D.available.map((d) => `<div class="rig off">
        <div class="handset"><div class="handset-off">⏻<small>Shut down</small></div></div>
        <div class="rig-plate"><b>${h(d.name)}</b><small>${h(d.os)} · Simulator</small></div>
        <div class="rig-actions">${act(d, 'boot', 'Boot')}${act(d, 'delete', 'Delete', 'danger')}</div>
      </div>`);
    $('#lab').innerHTML = on.length || off.length ? [...on, ...off].join('') : '<div class="lab-empty muted">No simulators or devices found.</div>';
  }

  // Destructive buttons ask twice: the first tap arms the button for 4 seconds.
  function armed(el, label) {
    if (el.dataset.armed) return true;
    const old = el.textContent;
    el.dataset.armed = '1';
    el.textContent = label;
    el.classList.add('armed');
    setTimeout(() => { if (!el.isConnected) return; delete el.dataset.armed; el.textContent = old; el.classList.remove('armed'); }, 4000);
    return false;
  }

  async function devAction(el) {
    const { devact: act, dev } = el.dataset;
    if (act === 'remote') return openRemote(dev);
    const busy = testingOn(dev);
    if (act === 'delete' && !armed(el, busy ? `${busy.id} is testing — delete?` : 'Tap again to delete')) return;
    if (act === 'shutdown' && busy && !armed(el, `${busy.id} is testing — stop?`)) return;
    el.disabled = true;
    el.textContent = { boot: 'Booting…', shutdown: 'Shutting down…', delete: 'Deleting…' }[act];
    try {
      D = await api(`devices/${encodeURIComponent(dev)}/${act}`, {});
      toast({ boot: 'Simulator booted.', shutdown: 'Shut down.', delete: 'Simulator deleted.' }[act]);
    } catch (e) { toast(e.message, 'error'); }
    renderLab();
    if ($('#simDlg').open) renderSimPick();
  }

  // Thumbnails every 15s and the device list every 30s, while the page is visible.
  function openDevices() { $('#devicesDlg').showModal(); loadDevices(true); }
  $('#devicesBtn').onclick = openDevices;

  setInterval(() => { if (!document.hidden && $('#devicesDlg').open) $('#lab').querySelectorAll('img').forEach((img, i) => { const d = D.booted.filter((x) => x.kind !== 'ios-device')[i]; if (d) img.src = shotUrl(d.id); }); }, 15000);
  setInterval(() => { if (!document.hidden) loadDevices(); }, 30000);

  // ---------- Mac storage ----------
  const bytes = (b) => (b == null ? '?' : b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : b >= 1e6 ? `${Math.round(b / 1e6)} MB` : b > 0 ? `${Math.max(1, Math.round(b / 1e3))} KB` : '0');
  const cleanSel = new Set();

  function diskHtml() {
    const st = S.storage || {};
    const usedPct = st.total ? Math.round((1 - st.free / st.total) * 100) : 0;
    const cleanable = (st.items || []).reduce((a, i) => a + (i.size || 0), 0);
    return `<button class="stat disk ${st.free && st.free < 15e9 ? 'alert' : ''}" data-storage="1" title="Free space and cleaning">
      <div class="disk-top"><div><div class="label">MAC DISK</div><div class="sub">${st.cleaning ? 'cleaning…' : st.scanning || !st.scannedAt ? 'scanning…' : `${bytes(cleanable)} cleanable`}</div></div>
        <div class="disk-num">${flap(Math.round((st.free || 0) / 1e9))}<span>GB<br>FREE</span></div></div>
      <div class="disk-bar"><i style="width:${usedPct}%"></i></div></button>`;
  }

  function renderStorage() {
    const st = S.storage || {};
    const items = st.items || [];
    const usedPct = st.total ? (1 - st.free / st.total) * 100 : 0;
    const selBytes = items.filter((i) => cleanSel.has(i.id)).reduce((a, i) => a + (i.size || 0), 0);
    const groups = [...new Set(items.map((i) => i.group))];
    const stateTag = (i) => (i.state === 'cleaning' ? '<span class="cr-state run">cleaning…</span>' : i.state === 'done' ? '<span class="cr-state ok">cleaned</span>' : i.state === 'partial' ? `<span class="cr-state warn" title="${h(i.error || '')}">partly</span>` : '');
    $('#storageBody').innerHTML = `
      <div class="disk-big">
        <div class="disk-big-top"><b>${bytes(st.free)}</b> free of ${bytes(st.total)}${st.scanning ? ' · scanning…' : st.scannedAt ? ` · scanned ${ago(st.scannedAt)}` : ''}</div>
        <div class="disk-bar big"><i style="width:${usedPct}%"></i><s style="left:calc(${usedPct}% - ${st.total ? (selBytes / st.total) * 100 : 0}%);width:${st.total ? (selBytes / st.total) * 100 : 0}%"></s></div>
        <div class="muted small">Everything below is rebuilt or downloaded again when needed, except items marked <em class="careful">careful</em>. <button type="button" class="linkish" data-cleanpick="1">Select all safe items</button></div>
      </div>
      ${groups.map((g) => `<div class="clean-group"><div class="subhead">${h(g.toUpperCase())}</div>
        ${items.filter((i) => i.group === g).sort((a, b) => (b.size ?? 1) - (a.size ?? 1)).map((i) => `<label class="clean-row ${i.caution ? 'caution' : ''} ${i.size === 0 ? 'zero' : ''}">
          <input type="checkbox" value="${i.id}" ${cleanSel.has(i.id) ? 'checked' : ''} ${st.cleaning || i.size === 0 ? 'disabled' : ''}>
          <span class="cr-main"><b>${h(i.label)}${i.caution ? ' <em class="careful">careful</em>' : ''}</b><small>${h(i.note || i.detail)}</small></span>
          <span class="cr-size">${i.size === undefined ? '…' : bytes(i.size)}</span>${stateTag(i)}
        </label>`).join('')}</div>`).join('')}`;
    $('#storageBody').querySelectorAll('input[type=checkbox]').forEach((cb) => { cb.onchange = () => { cb.checked ? cleanSel.add(cb.value) : cleanSel.delete(cb.value); renderStorage(); }; });
    const btn = $('#storageClean');
    if (!btn.dataset.armed) btn.textContent = st.cleaning ? 'Cleaning…' : cleanSel.size ? `Clean ${cleanSel.size} item${cleanSel.size > 1 ? 's' : ''} · ${bytes(selBytes)}` : 'Clean';
    btn.disabled = !cleanSel.size || st.cleaning;
    $('#storageScan').disabled = st.scanning || st.cleaning;
  }

  function pickSafe() {
    for (const i of S.storage?.items || []) if (!i.caution && i.size) cleanSel.add(i.id);
    renderStorage();
  }

  function openStorage() {
    $('#storageDlg').showModal();
    renderStorage();
    if (!S.storage?.scanning && Date.now() - (S.storage?.scannedAt || 0) > 10 * 60e3) api('storage/scan', {}).catch(() => {});
  }
  $('#storageScan').onclick = () => api('storage/scan', {}).catch((e) => toast(e.message, 'error'));
  $('#storageClean').onclick = async (e) => {
    const btn = e.currentTarget;
    const careful = (S.storage?.items || []).filter((i) => i.caution && cleanSel.has(i.id)).map((i) => i.label);
    if (!armed(btn, careful.length ? `Delete for good, incl. ${careful.join(' & ')}?` : 'Tap again to delete')) return;
    delete btn.dataset.armed;
    btn.classList.remove('armed');
    try { await api('storage/clean', { ids: [...cleanSel] }); cleanSel.clear(); } catch (x) { toast(x.message, 'error'); }
  };
  function refreshStorage() {
    const card = $('.stat.disk');
    if (card) card.outerHTML = diskHtml();
    if ($('#storageDlg').open) renderStorage();
  }

  // ---------- sim test ----------
  function renderSimPick() {
    const sims = D.booted.filter((d) => d.kind === 'ios-sim');
    $('#simPick').innerHTML = sims.length ? sims.map((d, i) => {
      const busy = testingOn(d.id);
      return `<label class="sim-opt"><input type="radio" name="sim" value="${d.id}" ${i === 0 ? 'checked' : ''}>
        <span><img src="${shotUrl(d.id)}" alt=""><b>${h(d.name)}</b><small>iOS ${h(d.os.replace(/^iOS /, ''))}${busy ? ` · busy with ${busy.id}` : ''}</small></span></label>`;
    }).join('') : `<div class="sim-none">No iOS simulator is booted.${D.available.length ? ` <button type="button" class="btn small" data-devact="boot" data-dev="${h(D.available[0].id)}">Boot ${h(D.available[0].name)}</button>` : ''}</div>`;
    $('#simGo').disabled = !sims.length;
  }

  async function openSimTest(t) {
    $('#simTask').textContent = t.id;
    $('#simFocus').value = '';
    renderSimPick();
    const dlg = $('#simDlg');
    dlg.returnValue = '';
    dlg.showModal();
    loadDevices().then(renderSimPick);
    dlg.onclose = () => {
      const device = $('#simPick input:checked')?.value;
      if (dlg.returnValue !== 'ok' || !device) return;
      runStep('simtest', { device, focus: $('#simFocus').value, notion: $('#simNotion').checked });
    };
  }

  // ---------- QA reports ----------
  const reportBase = (rid) => `/api/tasks/${encodeURIComponent(openId)}/reports/${encodeURIComponent(rid)}/`;
  function reportCard(r) {
    const base = reportBase(r.rid);
    return `<div class="report-card ${r.fail || r.result === 'FAIL' ? 'fail' : 'pass'}">
      <div class="rc-top"><span class="pix">QA REPORT</span><span class="rc-result">${h(r.result)}</span></div>
      <b>${h(r.title)}</b>
      <div class="rc-counts"><span class="ok">${r.pass} pass</span><span class="bad">${r.fail} fail</span>${r.skip ? `<span>${r.skip} skipped</span>` : ''}<span class="muted">${h(r.device || '')}</span></div>
      ${r.images?.length ? `<div class="rc-shots">${r.images.map((f) => `<img src="${base}${encodeURIComponent(f)}" alt="" loading="lazy">`).join('')}</div>` : ''}
      <button class="btn small" data-report="${h(r.rid)}">Open report</button>
    </div>`;
  }

  async function openReport(rid) {
    const base = reportBase(rid);
    $('#reportBody').innerHTML = '<p class="muted">Loading…</p>';
    $('#reportDlg').showModal();
    try {
      const res = await fetch(base + 'report.md');
      if (!res.ok) throw new Error('The report file is gone.');
      $('#reportBody').innerHTML = md(await res.text(), base);
    } catch (e) { $('#reportBody').innerHTML = `<p class="warn-line">${h(e.message)}</p>`; }
  }

  // ---------- render: stats, floor, board ----------
  function flap(n) { return `<span class="flap">${String(n).padStart(2, '0').split('').map((d) => `<span>${d}</span>`).join('')}</span>`; }

  // ---------- Your moves: every task's next step that is yours, most urgent first ----------
  const MOVE_KIND = {
    approval: ['Wants your OK', 0], ask: ['Asked you', 1], error: ['Hit a snag', 2], ci: ['CI', 3],
    checks: ['Checks failed', 4], merge: ['Ready to merge', 5], other: ['Next step', 6], ship: ['Wrap up', 7],
  };
  let shownMoves = new Set();
  const btnLabel = (html) => (html || '').replace(/<[^>]+>/g, '').trim();

  function myMoves(tasks) {
    const out = [];
    for (const t of tasks) {
      const w = t.work;
      if (!w || (!w.worktree && !prsOf(w).length)) continue;
      if (w.agent?.status === 'running' || w.checksRunning) continue; // the agent's move, not yours
      const n = nextUp(t);
      if (!n.actions.length) continue;
      const kind = (w.approvals || []).length ? 'approval' : w.agent?.status === 'needs-you' ? 'ask' : w.agent?.status === 'error' ? 'error'
        : n.step === 'ci' && /failing|conflict/i.test(n.why) ? 'ci' : n.step === 'checks' && /failed/i.test(n.why) ? 'checks'
          : /Merge/.test(n.actions[0]) ? 'merge' : n.step === 'ship' ? 'ship' : 'other';
      out.push({ t, n, kind });
    }
    return out.sort((a, b) => MOVE_KIND[a.kind][1] - MOVE_KIND[b.kind][1]);
  }

  function movesHtml(moves, tasks) {
    if (!moves.length) {
      const busy = tasks.filter((t) => t.work?.agent?.status === 'running').length;
      const pick = tasks.filter((t) => t.stage === 'todo' && !t.work?.worktree)
        .sort((a, b) => (PRIO[a.priority] ?? 3) - (PRIO[b.priority] ?? 3))[0];
      return `<div class="move calm"><span class="calm-art" aria-hidden="true">☕</span><div class="calm-txt">
          <b>Nothing needs you right now.</b>
          <span class="why">${busy ? `${busy} agent${busy > 1 ? 's are' : ' is'} working. You'll hear a chime when one needs you.` : 'Every desk is quiet.'}</span></div>
          ${pick ? `<button type="button" class="btn small" data-open="${pick.id}">Pick up ${pick.id}</button>` : ''}</div>`;
    }
    // Only cards that just appeared animate in; the floor re-renders on every update.
    const keys = moves.slice(0, 8).map(({ t, kind }) => `${t.id}:${kind}`);
    const fresh = new Set(keys.filter((k) => !shownMoves.has(k)));
    shownMoves = new Set(keys);
    return moves.slice(0, 8).map(({ t, n, kind }, i) => `<div class="move ${kind} ${fresh.has(`${t.id}:${kind}`) ? 'enter' : ''}" style="--i:${i}">
        <button type="button" class="move-open" data-open="${t.id}">
          <span class="move-top"><span class="tid">${t.id}</span><span class="mv-kind">${MOVE_KIND[kind][0]}</span></span>
          <b>${h(t.title)}</b><span class="why">${h(n.why)}</span></button>
        <button type="button" class="btn small primary" data-move="${t.id}">${h(btnLabel(n.actions[0]))}</button>
      </div>`).join('');
  }

  // Opens the task and presses its next-step button, so a move is one tap from the floor.
  async function doMove(id) {
    await openTask(id);
    requestAnimationFrame(() => $('.next-actions .btn.primary, .next-actions .btn')?.click());
  }

  // ---------- live feed: what just happened, one line at a time ----------
  let tickIdx = 0;
  function renderTicker() {
    const list = (S?.recent || []).slice(0, 6);
    const el = $('#ticker');
    if (!list.length) { el.innerHTML = '<span class="live-dot"></span><span class="tk">Quiet floor</span>'; return; }
    const ev = list[tickIdx % list.length];
    const label = EV_LABEL[ev.kind] || ev.kind;
    el.dataset.id = ev.id || '';
    el.innerHTML = `<span class="live-dot"></span><span class="tk">${ev.id ? `<b>${h(ev.id)}</b> ` : ''}${h(label)}${ev.text && !['merged', 'done'].includes(ev.kind) ? ` · ${h(String(ev.text).slice(0, 60))}` : ''}</span><small>${ago(ev.at)}</small>`;
  }
  setInterval(() => {
    if (document.hidden || (S?.recent || []).length < 2) return;
    tickIdx++;
    renderTicker();
    const el = $('#ticker');
    el.classList.remove('tick');
    void el.offsetWidth;
    el.classList.add('tick');
  }, 6000);

  // ---------- quick jump (⌘K or "/") ----------
  const COMMANDS = [
    ['New Notion task', '＋', () => openDaily('newtask'), 'n'],
    ['Release room', '🚀', () => openRelease(), 'r'],
    ['Devices', '📱', () => openDevices(), 'v'],
    ['Daily: standup', '☀️', () => openDaily('standup'), 'd'],
    ['Daily: checkout message', '👋', () => openDaily('checkout')],
    ['Check-in topics', '💬', () => openDaily('topics')],
    ['Sync with Notion', '🔄', () => $('#syncBtn').click(), 's'],
    ['Claude meter', '📊', () => openMeter()],
    ['Clean the Mac', '🧹', () => openStorage()],
    ['Settings', '⚙️', () => openSettings()],
    ['Open on your phone', '📲', () => $('#connectBtn').click()],
    ['Day / night shift', '🌗', () => $('#themeBtn').click(), 't'],
    ['Keyboard shortcuts', '⌨️', () => $('#keysDlg').showModal(), '?'],
  ];
  let cmdItems = [];
  let cmdSel = 0;
  function openCmd() {
    if ($('#cmdDlg').open) return;
    document.querySelectorAll('dialog[open]').forEach((d) => d.close());
    $('#cmdInput').value = '';
    cmdSel = 0;
    renderCmd();
    $('#cmdDlg').showModal();
    $('#cmdInput').focus();
  }
  function renderCmd() {
    const q = $('#cmdInput').value.trim().toLowerCase();
    const tasks = S.tasks.filter((t) => !t.hidden);
    const cmd = ([label, icon, run, key]) => ({ kind: 'cmd', icon, label, run, key });
    let items;
    if (!q) {
      items = [
        ...myMoves(tasks).slice(0, 4).map(({ t, n }) => ({ kind: 'move', id: t.id, icon: '⚡', label: `${btnLabel(n.actions[0])} · ${t.id}`, sub: t.title })),
        ...tasks.filter(onFloor).slice(0, 5).map((t) => ({ kind: 'task', id: t.id, icon: '🪑', label: t.title, sub: `${t.id} · ${STATE_LABEL[deskState(t)]}` })),
        ...COMMANDS.map(cmd),
      ];
    } else {
      const words = q.split(/\s+/);
      const hit = (str) => words.every((w) => str.includes(w));
      items = [
        ...COMMANDS.filter(([label]) => hit(label.toLowerCase())).map(cmd),
        ...tasks.filter((t) => hit(`${t.id} ${t.title} ${t.tags.join(' ')}`.toLowerCase()))
          .sort((a, b) => (b.id.toLowerCase().includes(q) - a.id.toLowerCase().includes(q)) || (onFloor(b) - onFloor(a)))
          .slice(0, 12).map((t) => ({ kind: 'task', id: t.id, icon: onFloor(t) ? '🪑' : '📄', label: t.title, sub: `${t.id} · ${t.status}` })),
      ];
    }
    cmdItems = items;
    cmdSel = Math.min(cmdSel, Math.max(0, items.length - 1));
    $('#cmdList').innerHTML = items.length ? items.map((it, i) => `<button type="button" class="cmd-item ${i === cmdSel ? 'sel' : ''}" data-ci="${i}" role="option" aria-selected="${i === cmdSel}">
        <span class="ci-icon">${it.icon}</span><span class="ci-txt"><b>${h(it.label)}</b>${it.sub ? `<small>${h(it.sub)}</small>` : ''}</span>
        ${it.key ? `<kbd>${h(it.key.toUpperCase())}</kbd>` : ''}</button>`).join('')
      : '<p class="muted cmd-empty">Nothing matches. Try a task number or a word from its title.</p>';
    $('#cmdList .sel')?.scrollIntoView({ block: 'nearest' });
  }
  function runCmd(i) {
    const it = cmdItems[i];
    if (!it) return;
    $('#cmdDlg').close();
    if (it.kind === 'cmd') return it.run();
    if (it.kind === 'move') return doMove(it.id);
    return openTask(it.id);
  }
  $('#cmdBtn').onclick = openCmd;
  $('#cmdInput').addEventListener('input', () => { cmdSel = 0; renderCmd(); });
  $('#cmdInput').addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      cmdSel = (cmdSel + (e.key === 'ArrowDown' ? 1 : -1) + cmdItems.length) % Math.max(1, cmdItems.length);
      renderCmd();
    }
    if (e.key === 'Enter') { e.preventDefault(); runCmd(cmdSel); }
  });
  $('#cmdList').addEventListener('click', (e) => { const b = e.target.closest('[data-ci]'); if (b) runCmd(Number(b.dataset.ci)); });
  $('#cmdDlg').addEventListener('click', (e) => { if (e.target.id === 'cmdDlg') $('#cmdDlg').close(); });

  function renderAll() {
    if (!S) return;
    const hiddenCount = S.tasks.filter((t) => t.hidden).length;
    const tasks = showHidden ? S.tasks : S.tasks.filter((t) => !t.hidden);
    const floor = tasks.filter(onFloor).sort((a, b) => ORDER[deskState(a)] - ORDER[deskState(b)]);
    const needs = floor.filter((t) => ['needs-you', 'error'].includes(deskState(t))).length;
    const working = floor.filter((t) => deskState(t) === 'running').length;
    const inReview = tasks.filter((t) => t.stage === 'review').length;
    const openPrs = tasks.filter((t) => t.work?.pr?.state === 'OPEN').length;
    const inbox = tasks.filter((t) => t.stage === 'todo').length;
    mac?.postMessage({ needs });
    const moves = myMoves(tasks);
    const urgent = moves.filter((m) => ['approval', 'ask', 'error'].includes(m.kind)).length;

    $('#stats').innerHTML = `
      <button class="stat" data-jump="floor"><div><div class="label">AT DESKS</div><div class="sub">${working} typing now</div></div>${flap(floor.length)}</button>
      <button class="stat ${urgent ? 'alert' : ''}" data-jump="moves"><div><div class="label">YOUR MOVES</div><div class="sub">${urgent ? `${urgent} waiting on you` : moves.length ? 'Ready when you are' : 'All clear'}</div></div>${flap(moves.length)}</button>
      <button class="stat" data-room="review"><div><div class="label">IN REVIEW</div><div class="sub">${openPrs} open PRs</div></div>${flap(inReview)}</button>
      <button class="stat go" data-room="inbox"><div><div class="label">INBOX</div><div class="sub">Not started</div></div>${flap(inbox)}</button>
      ${diskHtml()}
      ${meterHtml()}`;

    $('#moves').innerHTML = movesHtml(moves, tasks);
    renderGreet(moves, working);
    $('#releaseBtn').style.display = S.releaseEnabled === false ? 'none' : '';
    $('#movesTitle').textContent = moves.length ? `What needs you · ${moves.length}` : 'All clear';
    renderTicker();

    // Empty desks invite the next task in, highest priority first.
    const free = Math.max(0, Math.min(2, 3 - floor.length));
    const picks = tasks.filter((t) => t.stage === 'todo' && !onFloor(t))
      .sort((a, b) => (PRIO[a.priority] ?? 3) - (PRIO[b.priority] ?? 3)).slice(0, floor.length ? free : 0);
    const freeDesks = picks.map((t) => `<button class="cubicle free" data-open="${t.id}" title="Open ${t.id} and clock in">
        <div class="scene"><span class="free-sign">FREE DESK</span>${worker(t.id, 'idle')}</div>
        <div class="plate"><div class="who"><span class="tid">${t.id}</span><span class="state idle">Pick me up</span></div>
          <div class="title">${h(t.title)}</div><div class="doing">${t.priority ? `${h(t.priority)} priority · ` : ''}in your inbox</div></div></button>`).join('');

    $('#floor').innerHTML = floor.length ? floor.map((t) => {
      const st = deskState(t);
      const party = t.work?.pr?.state === 'MERGED';
      const star = S.star === t.id;
      return `<button class="cubicle ${st} ${party ? 'party' : ''}" data-open="${t.id}">
        <div class="scene"><span class="sky" aria-hidden="true"><i></i></span>${worker(t.id, st)}${party ? '<span class="streamers" aria-hidden="true"></span>' : ''}${star ? '<span class="eotw" title="Employee of the week: most agent turns in 7 days">★ EMPLOYEE OF THE WEEK</span>' : ''}</div>
        <div class="plate">
          <div class="who"><span class="tid">${t.id}</span><span class="state ${st}">${STATE_LABEL[st]}</span></div>
          <div class="title">${h(t.title)}</div>
          <div class="doing">${h(activity(t)) || '&nbsp;'}</div>
        </div></button>`;
    }).join('') + freeDesks : `<div class="floor-empty">Nobody's in yet. Open a task from the board and <b>Clock in</b> to give it a desk.</div>`;

    const q = query.toLowerCase();
    const visible = tasks.filter((t) => !q || t.title.toLowerCase().includes(q) || t.id.toLowerCase().includes(q) || t.tags.join(' ').includes(q))
      .sort((a, b) => (PRIO[a.priority] ?? 3) - (PRIO[b.priority] ?? 3) || String(b.created).localeCompare(String(a.created)));

    // "Ready to ship" only appears while something is waiting for a release.
    const rooms = ROOMS.filter((r) => r.id !== 'ship' || visible.some(r.match));
    if (!rooms.some((r) => r.id === room)) room = rooms[0].id;
    $('#board').style.setProperty('--rooms', rooms.length);
    $('#roomTabs').innerHTML = rooms.map((r) => `<button class="room-tab" role="tab" data-room="${r.id}" aria-selected="${room === r.id}">${r.icon} ${r.name} · ${visible.filter(r.match).length}</button>`).join('');
    $('#board').innerHTML = rooms.map((r) => {
      const list = visible.filter(r.match);
      return `<section class="room ${room === r.id ? 'active' : ''}" data-r="${r.id}">
        <div class="room-head"><h3><span>${r.icon}</span><span>${r.name}</span></h3><span class="count">${list.length}</span></div>
        <div class="room-list">${list.length ? list.map(memo).join('') : `<div class="room-empty">Nothing here</div>`}</div>
      </section>`;
    }).join('');

    const n = S.notion;
    $('#syncNote').innerHTML = n.syncing ? 'Syncing with Notion…'
      : `${tasks.length} tasks · synced ${n.syncedAt ? ago(n.syncedAt) : 'never'} via ${n.source === 'notion-api' ? 'Notion API' : n.source === 'claude-notion' ? 'Claude + Notion connector' : 'seed file'}`
        + (hiddenCount ? ` · <button type="button" class="linkish" data-showhidden>${showHidden ? 'hide' : 'show'} ${hiddenCount} hidden</button>` : '');
    $('#syncBtn').classList.toggle('spin', !!n.syncing);
    document.title = needs ? `(${needs}) Workfloor` : 'Workfloor';
  }

  // The board card says what happens next, not just a state.
  function memoNext(t, st) {
    const w = t.work;
    if (!w || (st === 'idle' && !w.worktree)) return '';
    const running = w.agent?.status === 'running' || w.checksRunning;
    const n = !running && (w.worktree || prsOf(w).length) ? nextUp(t) : null;
    const label = n?.actions.length ? btnLabel(n.actions[0]) : '';
    return `<div class="live"><span class="state ${st}">${STATE_LABEL[st]}</span>${label ? `<span class="memo-next">▸ ${h(label)}</span>` : ''}</div>`;
  }

  function memo(t) {
    const w = t.work;
    const st = deskState(t);
    const dots = w ? stepsFor(t).map((s) => `<i class="${w.steps?.[s.id]?.status || ''}" title="${h(s.label)}"></i>`).join('') : '';
    return `<button class="memo p-${h(t.priority)}" data-open="${t.id}">
      <div class="row1"><span class="stamp">${t.id}</span>${w ? `<span class="dots">${dots}</span>` : ''}</div>
      <p class="title">${h(t.title)}</p>
      <div class="meta">
        ${t.priority ? `<span class="tag prio-${h(t.priority)}">${h(t.priority)}</span>` : ''}
        ${w?.repos ? w.repos.map((r) => `<span class="tag repo">${h(r)}</span>`).join('') : ''}
        ${w?.pr ? `<span class="tag pr">PR #${w.pr.number}${t.awaitingRelease ? ' ✓' : ''}</span>` : ''}
        ${t.awaitingRelease ? `<span class="tag ship">🚀 ${(t.shipped || []).length ? h(relWord(t.shipped[t.shipped.length - 1])) : 'waiting for a release'}</span>` : ''}
        ${t.tags.slice(0, 3).map((g) => `<span class="tag">${h(g)}</span>`).join('')}
      </div>
      ${memoNext(t, st)}
    </button>`;
  }

  function ago(iso) {
    const s = (Date.now() - new Date(iso).getTime()) / 1000;
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    return `${Math.floor(s / 86400)}d ago`;
  }
  const dur = (ms) => (ms == null ? '' : ms < 1000 ? `${ms}ms` : ms < 60000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`);

  // ---------- drawer ----------
  const task = () => S?.tasks.find((t) => t.id === openId);

  async function openTask(id, wantTab) {
    openId = id;
    tab = wantTab || (task()?.work?.worktree ? 'convo' : 'task');
    log = [];
    const drawer = $('#drawer');
    drawer.innerHTML = drawerShell();
    drawer.classList.remove('compact');
    // Fold the pinned stations into a compact strip once you scroll; the gap between 80 and 8 stops it flickering.
    $('#dBody').addEventListener('scroll', (e) => {
      const y = e.currentTarget.scrollTop;
      if (y > 80) drawer.classList.add('compact');
      else if (y < 8) drawer.classList.remove('compact');
    }, { passive: true });
    $('#scrim').hidden = false;
    document.body.classList.add('drawer-open');
    requestAnimationFrame(() => drawer.classList.add('open'));
    drawer.setAttribute('aria-hidden', 'false');
    history.replaceState(null, '', '#' + id);
    renderDrawer();
    try { log = (await api(`tasks/${id}/log`)).log; } catch {}
    if (openId === id && tab === 'convo') renderPane(true);
  }
  function closeTask() {
    openId = null;
    $('#drawer').classList.remove('open');
    $('#drawer').setAttribute('aria-hidden', 'true');
    $('#scrim').hidden = true;
    document.body.classList.remove('drawer-open');
    history.replaceState(null, '', location.pathname);
  }

  function drawerShell() {
    return `<div class="d-head" id="dHead"></div>
      <div class="d-body" id="dBody">
        <div class="d-sticky" id="dSticky">
          <div class="stations" id="stations"></div>
          <div id="agentBar"></div>
          <nav class="tabs" id="tabs" role="tablist"></nav>
        </div>
        <div class="pane" id="pane"></div>
        <div class="composer" id="composer" hidden>
          <div class="quick" id="quickReplies"></div>
          <form class="compose-row" id="composeForm">
            <textarea id="msg" rows="1" placeholder="Message the agent…" enterkeyhint="send"></textarea>
            <button class="send" title="Send" aria-label="Send"><svg viewBox="0 0 24 24" class="ico"><path d="M12 19V5M5.5 11.5 12 5l6.5 6.5"/></svg></button>
          </form>
        </div>
      </div>`;
  }

  function renderDrawer() {
    const t = task();
    if (!t) return;
    const w = t.work || {};
    const st = deskState(t);
    $('#dHead').innerHTML = `
      <div class="d-top">
        <button class="btn small ghost" data-close aria-label="Close">← Back</button>
        <span class="stamp" style="background:var(--paper)">${t.id}</span>
        <span class="spacer"></span>
        <a class="btn small ghost" href="${h(t.url)}" target="_blank" rel="noopener">Notion ↗</a>
        ${prsOf(w).map((p, _, all) => `<a class="btn small ghost pr-link ${(p.state || '').toLowerCase()} ${ciFailing(p) ? 'failing' : ''}" href="${h(p.url)}" target="_blank" rel="noopener" title="${h(p.repo)} PR #${p.number} · ${h((p.state || '').toLowerCase())}">${all.length > 1 ? `${h(p.repo)} ` : 'PR '}#${p.number}${p.state === 'MERGED' ? ' ✓' : ''} ↗</a>`).join('')}
      </div>
      <h2 class="d-title">${h(t.title)}</h2>
      <div class="chips">
        <span class="chip">${h(t.status)}</span>
        ${t.priority ? `<span class="chip">${h(t.priority)} priority</span>` : ''}
        ${t.testingType ? `<span class="chip">🧪 ${h(t.testingType)}</span>` : ''}
        ${w.branch ? `<span class="chip">⎇ ${h(w.branch)}</span>` : ''}
        ${t.tags.map((g) => `<span class="chip">#${h(g)}</span>`).join('')}
      </div>`;

    const next = nextUp(t);
    $('#stations').innerHTML = stepsFor(t).map((s, i) => {
      const ss = w.steps?.[s.id] || {};
      const locked = s.id !== 'setup' && !w.worktree && s.id !== 'ship';
      return `<button class="station ${ss.status || ''} ${locked ? 'locked' : ''} ${next.step === s.id ? 'current' : ''}" data-step="${s.id}" title="${h(s.hint)}">
        <div class="st-top"><span class="glyph">${GLYPH[s.icon] || '•'}</span><span class="n">${ss.status ? STEP_WORD[ss.status] || ss.status : String(i + 1).padStart(2, '0')}</span></div>
        <b>${h(s.label)}</b>
        <span class="st">${h(ss.summary || s.hint)}</span>
      </button>`;
    }).join('');
    // Keep the current station in view when it changes; leave the strip alone otherwise so it doesn't fight your scrolling.
    const cur = $('#stations .station.current');
    if (cur && centeredStep !== `${t.id}:${next.step}`) {
      centeredStep = `${t.id}:${next.step}`;
      const strip = $('#stations');
      strip.scrollLeft = cur.offsetLeft - strip.clientWidth / 2 + cur.offsetWidth / 2;
    }

    const agent = w.agent || {};
    const queue = agent.queue?.length || 0;
    const act = activity(t);
    $('#agentBar').innerHTML = `<div class="agent-bar next-bar ${st}">
        ${w.worktree ? worker(t.id, st) : ''}
        <div class="txt"><span class="state ${st}">${w.worktree ? STATE_LABEL[st] : 'NEXT UP'}${queue ? ` · ${queue} queued` : ''}</span>
          ${next.why ? `<span class="why">${h(next.why)}</span>` : ''}
          ${act && (!next.why || agent.status === 'running') ? `<span class="act">${h(act)}</span>` : ''}</div>
        <div class="next-actions">${next.actions.join('')}</div>
      </div>`;
    $('#quickReplies').innerHTML = quickReplies(t);

    const checks = w.checks || [];
    const failed = checks.filter((c) => c.status === 'fail').length;
    const ciFail = prsOf(w).filter((p) => p.state === 'OPEN').reduce((n, p) => n + ciFailing(p), 0);
    const tabsDef = [
      ['task', 'Task', w.notes?.trim() ? '<span class="badge">✎</span>' : ''],
      ['convo', 'Agent', agent.status === 'needs-you' ? '<span class="badge bad">!</span>' : ''],
      ['checks', 'Checks', checks.length ? `<span class="badge ${failed ? 'bad' : 'good'}">${failed ? failed + ' ✗' : '✓'}</span>` : ''],
      ['diff', 'Diff', (comments[t.id] || []).length ? `<span class="badge">${comments[t.id].length} 💬</span>` : ''],
      ['pr', 'PR', prsOf(w).length ? `<span class="badge ${ciFail ? 'bad' : ''}">${prsOf(w).length > 1 ? `${prsOf(w).length} PRs` : `#${w.pr.number}`}</span>` : ''],
      ['desk', 'Desk', ''],
    ];
    $('#tabs').innerHTML = tabsDef.map(([id, label, badge]) => `<button class="tab" role="tab" data-tab="${id}" aria-selected="${tab === id}">${label}${badge}</button>`).join('');
    $('#composer').hidden = tab !== 'convo' || !w.worktree;
    renderPane();
  }

  function renderPane(scrollToEnd) {
    const t = task();
    if (!t) return;
    const pane = $('#pane');
    const body = $('#dBody');
    const nearBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 140;
    // Don't redraw the Task tab under your fingers while you type instructions.
    if (tab === 'task' && document.activeElement?.id === 'notesText') return;
    if (tab === 'task') pane.innerHTML = taskHtml(t);
    if (tab === 'convo') pane.innerHTML = convoHtml(t);
    if (tab === 'checks') pane.innerHTML = checksHtml(t);
    if (tab === 'pr') pane.innerHTML = prHtml(t);
    if (tab === 'diff') pane.innerHTML = diffHtml(t);
    if (tab === 'desk') pane.innerHTML = deskHtml(t);
    if (tab === 'convo' && (scrollToEnd || nearBottom)) body.scrollTop = body.scrollHeight;
  }

  // ---------- tap-to-answer: the agent's numbered questions, each with choices ----------
  const AUX = /^(may|can|could|should|shall|is|are|am|do|does|did|will|would|have|has|was|were|want|ok|okay)\b/i;
  const CLAUSE = /^(do|does|would|should|shall|can|could|is|are|will|may)\s+(you|i|we|it|they|this)\b/i;
  let picks = { key: '', ans: {} };

  function choicesOf(q) {
    const paren = q.match(/\(([^()]*\sor\s[^()]*)\)/);
    // The question is the last sentence before the first "?".
    const body = (paren ? paren[1] : q.replace(/^[^:?]{1,40}:\s+/, '')).split('?')[0].split(/(?<=[.!])\s+/).pop().trim();
    const aux = AUX.test(body);
    if (/\sor\s/.test(body)) {
      let alts = body.split(/\s*,\s*or\s+|\s+or\s+|\s*,\s+(?=[^,]*\sor\s)/).map((s) => s.trim()).filter(Boolean);
      if (!CLAUSE.test(alts[alts.length - 1] || '')) {
        // "should the button call the existing endpoint, or a new one" → "the existing endpoint"
        if (AUX.test(alts[0])) {
          const m = [...alts[0].matchAll(/\b(the|a|an|this|that|these|those|its|one|same|in)\b/gi)].pop();
          if (m && m.index > 0) alts[0] = alts[0].slice(m.index);
        }
        alts = alts.map((s) => s.replace(/[.,;:]+$/, '')).map((s) => (/\s/.test(s) ? s.charAt(0).toUpperCase() + s.slice(1) : s));
        if (alts.length >= 2 && alts.length <= 4 && alts.every((s) => s.length && s.length <= 70)) return alts;
      }
    }
    return aux ? ['Yes', 'No'] : [];
  }

  function questionsOf(text) {
    const qs = [];
    for (const l of text.split('\n')) {
      const m = l.match(/^\s*(\d+)[.)]\s+(.*\?.*)$/);
      if (m) qs.push({ n: Number(m[1]), text: m[2] });
    }
    if (!qs.length) {
      const last = text.split('\n').map((s) => s.trim()).filter(Boolean).pop() || '';
      if (last.endsWith('?')) qs.push({ n: 0, text: last.replace(/^[-*•]\s+/, '') });
    }
    return qs.map((q) => { const plain = q.text.replace(/\*\*|`/g, ''); return { ...q, plain, choices: choicesOf(plain) }; });
  }

  function lastAsk() {
    const i = log.map((e) => e.t).lastIndexOf('user');
    const e = log.slice(i + 1).filter((x) => x.t === 'text').pop();
    return e ? { key: `${openId}:${e.at}`, qs: questionsOf(e.text) } : null;
  }

  function answersHtml() {
    const ask = lastAsk();
    if (!ask?.qs.length) return '';
    if (picks.key !== ask.key) picks = { key: ask.key, ans: {} };
    const rows = ask.qs.map((q) => `<div class="ans-q"><p>${q.n ? `<b>${q.n}</b>` : ''}${h(q.plain)}</p><div class="ans-opts">
        ${q.choices.map((c) => `<button type="button" data-ans="${q.n}" data-val="${h(c)}" aria-pressed="${picks.ans[q.n] === c}">${h(c)}</button>`).join('')}
        <button type="button" class="other" data-ansother="${q.n}">✎ Other…</button></div></div>`).join('');
    const n = Object.keys(picks.ans).length;
    const rest = ask.qs.length - n;
    return `<div class="answers"><span class="pix">TAP TO ANSWER</span>${rows}
      <div class="ans-send"><button type="button" class="btn primary" data-anssend ${n ? '' : 'disabled'}>Send ${ask.qs.length > 1 ? `${n} answer${n === 1 ? '' : 's'}` : 'answer'}</button>
      ${n && rest ? `<small>The other ${rest === 1 ? 'one goes' : rest + ' go'} as “your call”.</small>` : ''}</div></div>`;
  }

  function answerClick(el) {
    const ask = lastAsk();
    if (!ask) return;
    if (el.dataset.ansother !== undefined) {
      const ta = $('#msg');
      const n = Number(el.dataset.ansother);
      const done = ask.qs.filter((q) => picks.ans[q.n]).map((q) => `${q.n ? q.n + '. ' : ''}${picks.ans[q.n]}`);
      ta.value = [...done, n ? `${n}. ` : ''].join('\n');
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      return;
    }
    if (el.dataset.ans !== undefined) {
      const n = Number(el.dataset.ans);
      picks.ans[n] = picks.ans[n] === el.dataset.val ? undefined : el.dataset.val;
      if (!picks.ans[n]) delete picks.ans[n];
      if (ask.qs.length === 1 && picks.ans[n]) return send(picks.ans[n]);
      return renderPane();
    }
    if (el.hasAttribute('data-anssend')) {
      const text = ask.qs.map((q) => `${q.n ? q.n + '. ' : ''}${picks.ans[q.n] || 'Your call.'}`).join('\n');
      picks = { key: '', ans: {} };
      return send(text);
    }
  }

  function convoHtml(t) {
    const w = t.work || {};
    if (!w.worktree) return emptyState('🪪', 'Not clocked in yet', 'Clock in to make a worktree, then send the agent to work. You can do it from your phone.', '<button class="btn primary" data-step="setup">Clock in</button>');
    if (!log.length && w.agent?.status !== 'running') return emptyState('⌨️', 'Quiet desk', 'Start the Build step, or type below to give the agent any instruction in this worktree.', '<button class="btn primary" data-step="code">Start building</button>');
    const out = [];
    let tools = [];
    const flush = () => {
      if (!tools.length) return;
      const errs = tools.filter((x) => x.error).length;
      out.push(`<details class="tools"><summary>${tools.filter((x) => x.t === 'tool').length} actions${errs ? ` · ${errs} errors` : ''} — ${h(tools.filter((x) => x.t === 'tool').slice(-1)[0]?.text || '')}</summary>
        ${tools.map((x) => `<div class="tl ${x.error ? 'err' : ''}">${x.t === 'tool' ? '› ' + h(x.text) : '  ' + h(x.text.slice(0, 600))}</div>`).join('')}</details>`);
      tools = [];
    };
    for (const e of log) {
      if (e.t === 'tool') { tools.push(e); continue; }
      if (e.t === 'result') { if (e.error) tools.push(e); continue; }
      flush();
      if (e.t === 'user') out.push(`<div class="msg user ${e.step ? 'step' : ''}">${e.step ? `<b>${h(S.workflow.find((s) => s.id === e.step)?.label || e.step)}</b> step\n` : ''}${h(e.step ? e.text.slice(0, 280) + (e.text.length > 280 ? '…' : '') : e.text)}</div>`);
      else if (e.t === 'text') out.push(`<div class="msg agent">${md(e.text)}</div>`);
      else if (e.t === 'report') out.push(reportCard(e));
      else if (e.t === 'error') out.push(`<div class="sysline err">${h(e.text)}</div>`);
      else out.push(`<div class="sysline">${h(e.text)}</div>`);
    }
    flush();
    if (w.agent?.status === 'needs-you' && !(w.approvals || []).length) out.push(answersHtml());
    for (const a of w.approvals || []) {
      out.push(`<div class="approval">
        <div class="ap-top"><span class="pix">NEEDS YOUR OK</span><span class="muted">${ago(a.at)}</span></div>
        <b>${h(a.summary)}</b>
        <pre>${h(a.detail)}</pre>
        <input class="ap-note" data-apnote="${a.aid}" placeholder="Note for the agent (optional)" autocomplete="off">
        <div class="ap-actions">
          <button class="btn primary" data-approve="${a.aid}" data-allow="1">Allow</button>
          <button class="btn" data-approve="${a.aid}" data-allow="1" data-always="1" title="Stop asking for ${h(a.key)} on this task">Always allow</button>
          <button class="btn danger" data-approve="${a.aid}" data-allow="0">Deny</button>
        </div></div>`);
    }
    if (w.agent?.status === 'running' && !(w.approvals || []).length) out.push('<div class="typing-dots"><i></i><i></i><i></i></div>');
    return `<div class="convo">${out.join('')}</div>`;
  }

  function checksHtml(t) {
    const w = t.work || {};
    if (!w.worktree) return emptyState('🧪', 'No worktree yet', 'Checks run inside the task worktree.', '<button class="btn primary" data-step="setup">Clock in</button>');
    const checks = w.checks || [];
    const repoChecks = S.repos[w.repo]?.checks || [];
    const head = `<div class="pane-actions">
      <button class="btn primary" data-step="checks" ${w.checksRunning ? 'disabled' : ''}>${w.checksRunning ? 'Running…' : checks.length ? 'Run again' : 'Run checks'}</button>
      ${checks.some((c) => c.status === 'fail') ? '<button class="btn" data-ask="Fix the failing Workfloor checks: run them yourself, fix the cause, and re-run until they pass.">Ask agent to fix</button>' : ''}
      <span class="muted" style="font-size:13px">${h(w.steps?.checks?.summary || repoChecks.join(' · '))}</span></div>`;
    const rows = checks.map((c) => `<details class="check-row" ${c.status === 'fail' ? 'open' : ''}>
        <summary><span class="pill ${c.status}">${c.status.toUpperCase()}</span>
          <span class="nm">${h(c.name)}<small>${h(c.summary || c.cmd)}</small></span><span class="ms">${dur(c.ms)}</span></summary>
        ${c.out ? `<pre>${h(c.out)}</pre>` : ''}</details>`).join('');
    const ci = w.pr?.checks?.length ? `<div class="subhead">CI ON PR #${w.pr.number}</div>${ciRows(w.pr.checks)}` : '';
    return head + (rows || emptyState('🧪', 'No results yet', `Runs: ${repoChecks.join(', ')}. Lint and related tests only look at files changed on this branch.`)) + ci;
  }

  const ciRows = (checks) => checks.map((c) => `<div class="ci-row"><span class="pill ${c.status || 'pending'}">${(c.status || 'pending').toUpperCase()}</span><span>${h(c.name)}</span>${c.url ? `<a href="${h(c.url)}" target="_blank" rel="noopener">logs ↗</a>` : ''}</div>`).join('');

  function prHtml(t) {
    const w = t.work || {};
    const prs = prsOf(w);
    if (!prs.length) {
      return emptyState('📮', 'No PR yet', w.worktree ? 'When checks look good, raise the PR. The agent writes the body and links it on Notion.' : 'Clock in and build first.',
        w.worktree ? '<button class="btn primary" data-step="pr">Raise PR</button>' : '<button class="btn primary" data-step="setup">Clock in</button>');
    }
    const ship = (t.shipped || []).length ? `<div class="subhead">RELEASES CARRYING THIS TASK</div><div class="ship-list">${t.shipped.map((r) => `<a class="chip ship ${r.env}" href="${h(r.url)}" target="_blank" rel="noopener">🚀 ${h(relWord(r))} · ${ago(r.at)}</a>`).join('')}</div>` : '';
    const cards = prs.map((p) => {
      const failing = ciFailing(p);
      return `<div class="pr-card">
        <span class="num">${h(p.repo)} #${p.number}${p.base ? ` → ${h(p.base)}` : ''}</span>
        <h4>${h(p.title || '')}</h4>
        <div class="facts">
          <span class="chip pr-state ${(p.state || '').toLowerCase()}">${h((p.state || '').toLowerCase())}${p.draft ? ' · draft' : ''}</span>
          ${p.review ? `<span class="chip">${h(p.review.replace(/_/g, ' ').toLowerCase())}</span>` : ''}
          ${p.additions != null ? `<span class="chip">+${p.additions} −${p.deletions} · ${p.files} files</span>` : ''}
          ${p.comments ? `<span class="chip">💬 ${p.comments}</span>` : ''}
          ${failing ? `<span class="chip" style="color:var(--coral)">${failing} CI failing</span>` : ''}
          ${p.mergeable === 'CONFLICTING' ? '<span class="chip" style="color:var(--coral)">conflicts</span>' : ''}
        </div>
        <div class="pane-actions">
          ${p.state === 'OPEN' ? `<button class="btn ${failing ? '' : 'primary'}" data-merge="${p.number}">Merge #${p.number}</button>` : ''}
          ${p.state === 'OPEN' && w.worktree && (failing || p.comments) ? '<button class="btn" data-fixci>Fix CI & comments</button>' : ''}
          <a class="btn ghost" href="${h(p.url)}" target="_blank" rel="noopener">GitHub ↗</a>
        </div>
        ${p.checks?.length ? `<div class="subhead">CI CHECKS${p.refreshedAt ? ` · ${ago(p.refreshedAt)}` : ''}</div>${ciRows(p.checks)}` : ''}
      </div>`;
    }).join('');
    const merged = prs.every((p) => p.state === 'MERGED');
    return `<div class="pane-actions"><button class="btn" data-step="ci">Refresh</button>
        ${prs.filter((p) => p.state === 'OPEN').length > 1 ? `<button class="btn ${prs.some((p) => p.state === 'OPEN' && ciFailing(p)) ? '' : 'primary'}" data-merge="all">Merge all ${prs.filter((p) => p.state === 'OPEN').length}</button>` : ''}</div>
      ${ship}${cards}${merged && w.worktree ? clockoutHtml(w) : ''}`;
  }

  // ---------- Task tab: the Notion page, and your own instructions for the agents ----------
  async function loadBrief(id, fresh) {
    briefs[id] = { ...(briefs[id] || {}), loading: true, error: null };
    if (openId === id && tab === 'task') renderPane();
    try {
      briefs[id] = await api(`tasks/${encodeURIComponent(id)}/brief${fresh ? '?fresh=1' : ''}`);
    } catch (x) {
      briefs[id] = { ...(briefs[id] || {}), loading: false, error: x.message };
    }
    if (openId === id && tab === 'task') renderPane();
  }

  function taskHtml(t) {
    const w = t.work || {};
    const b = briefs[t.id];
    if (!b) setTimeout(() => loadBrief(t.id), 0);
    const body = b?.markdown != null
      // Notion attachments come back as notion-file-block:// links a browser can't load; name them instead.
      ? (b.markdown.trim() ? md(b.markdown.replace(/!?\[([^\]]*)\]\(notion-file-block:[^)]*\)/g, '📎 **$1** (attachment, open it in Notion)'))
        : '<p class="muted">The Notion page has no description yet. Add what the agent should know below.</p>')
      : b?.error ? `<p class="muted">Couldn't read the page: ${h(b.error)}</p>`
        : '<p class="muted">Reading the task from Notion… (about 20 seconds the first time)</p>';
    const draft = noteDrafts[t.id] ?? w.notes ?? '';
    const running = w.agent?.status === 'running';
    return `<div class="brief">
        <div class="brief-head"><span class="pix">FROM NOTION</span>
          <small class="muted">${b?.loading ? 'reading…' : b?.at ? `read ${ago(b.at)}` : ''}</small><span class="spacer"></span>
          <button type="button" class="linkish" data-brief="refresh" ${b?.loading ? 'disabled' : ''}>Refresh</button>
          <a class="linkish" href="${h(t.url)}" target="_blank" rel="noopener">Open in Notion ↗</a></div>
        <div class="msg agent brief-body">${body}</div>
      </div>
      <div class="subhead">YOUR INSTRUCTIONS</div>
      <p class="muted small" style="margin:0 0 8px">Every agent step on this task gets these, and they come before the Notion page.</p>
      <textarea id="notesText" class="notes" rows="5" placeholder="e.g. Only touch the feed screen. Reuse the existing feedback sheet. Ask me before changing the API.">${h(draft)}</textarea>
      <div class="pane-actions notes-actions">
        <button type="button" class="btn primary" data-notes="save">Save</button>
        ${w.worktree && !running ? '<button type="button" class="btn" data-notes="send">Save & tell the agent now</button>' : ''}
        <label class="check small"><input type="checkbox" id="notesNotion"> Also add to the Notion page</label>
        ${w.notesAt ? `<small class="muted">saved ${ago(w.notesAt)}</small>` : ''}
      </div>
      ${w.worktree ? '' : `<div class="pane-actions" style="margin-top:14px"><button class="btn primary" data-step="setup">Clock in</button></div>`}`;
  }

  async function notesAction(el) {
    const id = openId;
    const text = $('#notesText')?.value ?? '';
    const toNotion = !!$('#notesNotion')?.checked;
    el.disabled = true;
    try {
      await api(`tasks/${id}/notes`, { text, notion: toNotion });
      delete noteDrafts[id];
      toast(toNotion ? 'Saved. Adding it to Notion…' : 'Saved. The agent gets these from the next step.');
      if (el.dataset.notes === 'send' && text.trim()) {
        tab = 'convo';
        renderDrawer();
        return send(`I added instructions for this task. Follow them from now on:\n${text.trim()}`);
      }
    } catch (x) { toast(x.message, 'error'); }
    el.disabled = false;
    $('#notesText')?.blur();
    renderPane();
  }

  function deskHtml(t) {
    const w = t.work || {};
    if (!w.worktree) {
      return emptyState('🪪', 'Give this task a desk', 'Clocking in makes a git worktree on its own branch so it never touches your main checkout.',
        '<button class="btn primary" data-step="setup">Clock in</button>') + hideHtml(t);
    }
    return `<dl class="kv">
        <dt>REPO</dt><dd>${h((w.repos || [w.repo]).join(' + '))}</dd>
        <dt>BRANCH</dt><dd>${h(w.branch)}</dd>
        <dt>BASE</dt><dd>${h(w.base || 'main')}</dd>
        <dt>WORKTREE</dt><dd>${h(w.worktree)}${(w.extra || []).map((d) => `<br>${h(d)}`).join('')}</dd>
        <dt>SESSION</dt><dd>${h(w.sessionId || '— none yet')}</dd>
        <dt>MODEL</dt><dd><select id="modelSel">${[['', 'default'], ['haiku', 'Haiku · quick fixes'], ['sonnet', 'Sonnet · most tasks'], ['opus', 'Opus · hard or risky'], ['fable', 'Fable · the gnarliest']].map(([m, label]) => `<option value="${m}" ${(w.model || '') === m ? 'selected' : ''}>${label}</option>`).join('')}</select></dd>
        <dt>PERMISSIONS</dt><dd><select id="modeSel">${[['auto', 'auto · Claude decides'], ['default', 'default · ask me for risky actions'], ['acceptEdits', 'acceptEdits · ask before commands'], ['plan', 'plan · read only'], ['bypassPermissions', 'bypassPermissions · never ask']].map(([m, label]) => `<option value="${m}" ${(w.mode || S.permissionMode) === m ? 'selected' : ''}>${label}</option>`).join('')}</select></dd>
      </dl>
      <div class="subhead">ON THE MAC</div>
      <div class="pane-actions">
        <button class="btn" data-openmac="terminal">Continue in Terminal</button>
        <button class="btn" data-openmac="editor">Open in VS Code</button>
        <button class="btn ghost" data-openmac="finder">Finder</button>
      </div>
      ${(w.reports || []).length ? `<div class="subhead">TEST REPORTS</div><div class="report-list">${w.reports.map((r) => `<button class="report-row" data-report="${r.rid}"><span class="state ${r.fail ? 'fail' : 'pass'}">${r.result}</span><span>${h(r.title)}</span><small>${r.pass}✓ ${r.fail}✗ · ${ago(r.at)}</small></button>`).join('')}</div>` : ''}
      <div class="subhead">CONVERSATION</div>
      <div class="pane-actions"><button class="btn danger" data-reset>Start a new conversation</button></div>
      <div class="subhead">DONE WITH THIS TASK</div>
      ${clockoutHtml(w)}${hideHtml(t)}`;
  }

  const hideHtml = (t) => `<div class="subhead">${t.hidden ? 'HIDDEN FROM THE BOARD' : 'NOT ON YOUR LIST ANY MORE?'}</div>
    <div class="pane-actions"><button class="btn ${t.hidden ? '' : 'ghost'}" data-hide="${t.hidden ? '0' : '1'}">${t.hidden ? 'Show it on the board again' : 'Hide from board'}</button>
    <span class="muted small">${t.hidden ? 'Hidden here only; Notion is unchanged.' : 'For tasks deleted in Notion that still show up. Only hides it here; Notion is unchanged.'}</span></div>`;

  const emptyState = (icon, title, text, action = '') => `<div class="empty"><span class="big">${icon}</span><b>${h(title)}</b><p class="muted">${h(text)}</p>${action}</div>`;

  // tiny markdown: code fences, inline code, bold, links, headings, lists, tables
  function md(src, base) {
    // Task checklists: "- [ ] item" / "- [x] item" read as boxes.
    const blocks = String(src).replace(/^(\s*[-*]\s+)\[ \]\s+/gm, '$1☐ ').replace(/^(\s*[-*]\s+)\[[xX]\]\s+/gm, '$1☑ ').split(/```/);
    return blocks.map((b, i) => {
      if (i % 2) return `<pre><code>${h(b.replace(/^\w*\n/, ''))}</code></pre>`;
      const lines = b.split('\n');
      let html = '';
      let list = null;
      let table = [];
      const inline = (s) => h(s)
        .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (m, alt, file) => {
          if (!base || /^[a-z]+:/i.test(file)) return m;
          const src = base + encodeURIComponent(file.replace(/^\.\//, ''));
          return /\.(mp4|mov)$/i.test(file) ? `<video src="${src}" controls playsinline preload="metadata"></video>` : `<a href="${src}" target="_blank"><img src="${src}" alt="${alt}" loading="lazy"></a>`;
        })
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
        .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
        .replace(/(^|\s)(https?:\/\/[^\s<]+)/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>');
      const closeList = () => { if (list) { html += `</${list}>`; list = null; } };
      const closeTable = () => {
        if (!table.length) return;
        const rows = table.filter((r) => !/^\|?\s*:?-{2,}/.test(r));
        html += '<table>' + rows.map((r, ri) => '<tr>' + r.replace(/^\||\|$/g, '').split('|').map((c) => `<${ri ? 'td' : 'th'}>${inline(c.trim())}</${ri ? 'td' : 'th'}>`).join('') + '</tr>').join('') + '</table>';
        table = [];
      };
      for (const line of lines) {
        if (/^\s*\|.*\|\s*$/.test(line)) { closeList(); table.push(line.trim()); continue; }
        closeTable();
        let m;
        if ((m = line.match(/^(#{1,4})\s+(.*)/))) { closeList(); html += `<h4>${inline(m[2])}</h4>`; }
        else if ((m = line.match(/^\s*[-*]\s+(.*)/))) { if (list !== 'ul') { closeList(); html += '<ul>'; list = 'ul'; } html += `<li>${inline(m[1])}</li>`; }
        else if ((m = line.match(/^\s*(\d+)[.)]\s+(.*)/))) {
          // Keep the author's numbering when sub-bullets split one list into several.
          if (list !== 'ol') { closeList(); html += `<ol start="${m[1]}">`; list = 'ol'; }
          html += `<li>${inline(m[2])}</li>`;
        }
        else if (line.trim()) { closeList(); html += `<p>${inline(line)}</p>`; }
        else closeList();
      }
      closeList(); closeTable();
      return html;
    }).join('');
  }

  // ---------- actions ----------
  async function runStep(stepId, body = {}) {
    const t = task();
    if (!t) return;
    const w = t.work || {};
    if (stepId === 'ship') { tab = 'pr'; return renderDrawer(); }
    if (stepId !== 'setup' && !w.worktree) return openClockIn(t);
    if (stepId === 'setup') {
      if (w.worktree) { tab = 'desk'; renderDrawer(); return toast('Already clocked in — this task has a desk.'); }
      return openClockIn(t);
    }
    if (stepId === 'simtest' && !body.device) return openSimTest(t);
    if (stepId === 'pr' && !body.base) {
      $('#prBase').value = w.base || 'main';
      $('#prDlg').returnValue = '';
      $('#prDlg').showModal();
      $('#prDlg').onclose = () => { if ($('#prDlg').returnValue === 'ok') runStep('pr', { base: $('#prBase').value.trim() || 'main' }); };
      return;
    }
    try {
      if (stepId === 'checks') tab = 'checks';
      else if (stepId === 'ci') tab = 'pr';
      else tab = 'convo';
      const running = w.agent?.status === 'running';
      await api(`tasks/${t.id}/step/${stepId}`, body);
      if (running && !['checks', 'ci'].includes(stepId)) toast('Agent is busy — step queued after the current turn.', 'warn');
      renderDrawer();
    } catch (e) { toast(e.message, 'error'); }
  }

  function openClockIn(t) {
    const dlg = $('#clockDlg');
    const form = $('#clockForm');
    $('#clockTask').textContent = t.id;
    const slug = t.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').split('-').slice(0, 5).join('-');
    $('#clockBranch').textContent = `${S.me}/${t.id}/${slug}`;
    // Repo choices come from your config; a backend-sounding task leans to a web/api repo if there is one.
    const keys = Object.keys(S.repos || {});
    $('#repoSeg').hidden = keys.length < 2;
    $('#repoSeg').innerHTML = `<legend>Repo</legend>${keys.map((k) => `<label><input type="radio" name="repo" value="${h(k)}"><span>${h(k)}</span></label>`).join('')}${keys.length > 1 ? '<label><input type="radio" name="repo" value="all"><span>All</span></label>' : ''}`;
    const backendish = /security|webhook|backend|api|rate limit|otp|secret|route|cron/i.test(t.title);
    form.repo.value = (backendish && keys.find((k) => /web|api|server|backend/i.test(k))) || keys[0] || '';
    const g = rateTask(t);
    form.model.value = g.model;
    renderSeverity(g);
    $('#sevBox').onclick = async (e) => {
      if (e.target.id !== 'gaugeDeep') return;
      e.target.disabled = true;
      e.target.textContent = 'Reading the task…';
      try {
        const deep = await api(`tasks/${t.id}/gauge`, {});
        if (dlg.open) { form.model.value = deep.model; renderSeverity(deep, true); }
      } catch (x) { toast(x.message, 'error'); e.target.disabled = false; e.target.textContent = 'Try reading the task again'; }
    };
    dlg.returnValue = '';
    dlg.showModal();
    dlg.onclose = async () => {
      if (dlg.returnValue !== 'ok') return;
      const repo = form.repo.value;
      const base = form.base.value.trim() || 'main';
      const model = form.model.value;
      const autostart = form.autostart.checked;
      toast(`Clocking in on ${t.id} with ${model}…`);
      try {
        await api(`tasks/${t.id}/step/setup`, { repo, base, model });
        toast(`${t.id} has a desk.`);
        if (autostart) { tab = 'convo'; await api(`tasks/${t.id}/step/code`, {}); }
      } catch (e) { toast(e.message, 'error'); }
    };
  }

  async function send(text) {
    const t = task();
    if (!t || !text.trim()) return;
    try {
      const busy = t.work?.agent?.status === 'running';
      await api(`tasks/${t.id}/message`, { text });
      if (busy) toast('Queued — sends when the current turn ends.', 'warn');
    } catch (e) { toast(e.message, 'error'); }
  }

  // ---------- events ----------
  document.addEventListener('click', async (e) => {
    const el = e.target.closest('[data-open],[data-close],[data-step],[data-tab],[data-room],[data-jump],[data-stop],[data-q],[data-ask],[data-openmac],[data-reset],[data-fixci],[data-meter],[data-simtest],[data-report],[data-devact],[data-labrefresh],[data-storage],[data-cleanpick],[data-approve],[data-cl],[data-csave],[data-ccancel],[data-cdel],[data-csend],[data-cclear],[data-diffrefresh],[data-rkey],[data-settest],[data-daily],[data-clockout],[data-rel],[data-relver],[data-ans],[data-ansother],[data-anssend],[data-hide],[data-showhidden],[data-merge],[data-finish],[data-brief],[data-notes],[data-move],[data-setupagain]');
    if (!el) return;
    if (el.dataset.open) { el.closest('dialog')?.close(); return openTask(el.dataset.open); }
    if (el.hasAttribute('data-close')) return closeTask();
    if (el.dataset.step) return runStep(el.dataset.step);
    if (el.dataset.tab) { tab = el.dataset.tab; renderDrawer(); if (tab === 'convo') renderPane(true); if (tab === 'pr' && task()?.work?.pr) api(`tasks/${openId}/pr`, {}).catch(() => {}); return; }
    if (el.dataset.room) { room = el.dataset.room; renderAll(); $('.board-wrap').scrollIntoView({ behavior: 'smooth', block: 'start' }); return; }
    if (el.dataset.meter) return openMeter();
    if (el.dataset.approve) return approve(el);
    if (el.dataset.cl || el.dataset.csave || el.dataset.ccancel || el.dataset.cdel || el.dataset.csend || el.dataset.cclear || el.dataset.diffrefresh) return diffClick(el);
    if (el.dataset.rkey) return remoteKey(el.dataset.rkey);
    if (el.dataset.settest) return settingsTest(el.dataset.settest);
    if (el.dataset.daily) return dailyAction(el);
    if (el.dataset.ans !== undefined || el.dataset.ansother !== undefined || el.hasAttribute('data-anssend')) return answerClick(el);
    if (el.dataset.hide) {
      const hide = el.dataset.hide === '1';
      await api(`tasks/${openId}/hide`, { hide }).catch((x) => toast(x.message, 'error'));
      if (hide) { closeTask(); toast('Hidden from the board'); }
      return;
    }
    if (el.hasAttribute('data-showhidden')) { showHidden = !showHidden; return renderAll(); }
    if (el.dataset.move) return doMove(el.dataset.move);
    if (el.hasAttribute('data-setupagain')) { $('#settingsDlg').close(); return startOnboarding(); }
    if (el.dataset.brief) return loadBrief(openId, true);
    if (el.dataset.notes) return notesAction(el);
    if (el.dataset.merge) {
      const all = el.dataset.merge === 'all';
      if (!armed(el, all ? 'Tap again to merge them all' : `Tap again to merge #${el.dataset.merge}`)) return;
      el.disabled = true;
      el.textContent = 'Merging…';
      try {
        await api(`tasks/${openId}/merge`, all ? {} : { number: Number(el.dataset.merge) });
        toast(all ? 'Merged' : `PR #${el.dataset.merge} merged`);
      } catch (x) { toast(x.message, 'error'); el.disabled = false; renderDrawer(); }
      return;
    }
    if (el.hasAttribute('data-finish')) {
      const force = el.dataset.force === '1';
      if (!armed(el, force ? 'Tap again: discard local changes' : 'Tap again: clock out & mark done')) return;
      try {
        await api(`tasks/${openId}/finish`, { force });
        toast('Clocked out. Setting Notion to done…');
      } catch (x) {
        toast(x.message, 'error');
        if (/not committed|not pushed/i.test(x.message)) { el.dataset.force = '1'; delete el.dataset.armed; el.textContent = 'Discard local changes & finish'; el.classList.add('danger'); }
      }
      return;
    }
    if (el.dataset.rel) return releaseAction(el);
    if (el.dataset.relver) { $('#relVersion').value = el.dataset.relver; return; }
    if (el.dataset.clockout) return clockOut(el, el.dataset.clockout === 'force');
    if (el.dataset.simtest) return runStep('simtest');
    if (el.dataset.report) return openReport(el.dataset.report);
    if (el.dataset.devact) return devAction(el);
    if (el.dataset.storage) return openStorage();
    if (el.dataset.cleanpick) return pickSafe();
    if (el.dataset.labrefresh) return loadDevices(true);
    if (el.dataset.jump) return $(el.dataset.jump === 'moves' ? '.moves-wrap' : '.floor-wrap').scrollIntoView({ behavior: 'smooth' });
    if (el.hasAttribute('data-stop')) return api(`tasks/${openId}/stop`, {}).catch((x) => toast(x.message, 'error'));
    if (el.dataset.q) return send(el.dataset.q);
    if (el.dataset.ask) { tab = 'convo'; renderDrawer(); return send(el.dataset.ask); }
    if (el.dataset.fixci) { tab = 'convo'; renderDrawer(); return runStep('ci', { fix: true }); }
    if (el.dataset.openmac) return api(`tasks/${openId}/open`, { what: el.dataset.openmac }).then(() => toast('Opened on your Mac')).catch((x) => toast(x.message, 'error'));
    if (el.hasAttribute('data-reset')) { if (confirm('Start a fresh agent conversation for this task? The worktree stays.')) { await api(`tasks/${openId}/reset`, {}); log = []; renderPane(); } }
  });
  document.addEventListener('change', (e) => {
    if (e.target.id === 'modeSel') api(`tasks/${openId}/mode`, { mode: e.target.value }).then(() => toast(`Permissions: ${e.target.value}`));
    if (e.target.id === 'modelSel') api(`tasks/${openId}/model`, { model: e.target.value }).then(() => toast(`Next turns use ${e.target.value || 'the default model'}`));
  });
  document.addEventListener('submit', async (e) => {
    if (e.target.id === 'greetForm') {
      e.preventDefault();
      const name = $('#greetName').value.trim();
      if (name) { await api('setup/name', { name }).catch((x) => toast(x.message, 'error')); try { localStorage.removeItem('wf-greeted'); } catch {} }
      return;
    }
    if (e.target.id !== 'composeForm') return;
    e.preventDefault();
    const ta = $('#msg');
    const text = ta.value;
    ta.value = '';
    ta.style.height = '';
    send(text);
  });
  document.addEventListener('keydown', (e) => {
    if (e.target.id === 'msg' && e.key === 'Enter' && !e.shiftKey && !e.isComposing && matchMedia('(pointer: fine)').matches) {
      e.preventDefault();
      $('#composeForm').requestSubmit();
    }
    if (e.key === 'Escape' && openId && !document.querySelector('dialog[open]')) closeTask();
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); openCmd(); return; }
    // Single-key shortcuts, only when you're not typing and no dialog is open.
    if (e.target.closest?.('input, textarea, select, [contenteditable]') || e.metaKey || e.ctrlKey || e.altKey || document.querySelector('dialog[open]')) return;
    const go = {
      '/': openCmd, '?': () => $('#keysDlg').showModal(),
      m: () => { const first = myMoves(S.tasks.filter((t) => !t.hidden))[0]; if (first) doMove(first.t.id); else toast('Nothing needs you right now.'); },
      n: () => openDaily('newtask'), d: () => openDaily('standup'), r: () => openRelease(), v: () => openDevices(),
      s: () => $('#syncBtn').click(), t: () => $('#themeBtn').click(),
    }[e.key.length === 1 ? e.key.toLowerCase() : ''];
    if (go) { e.preventDefault(); go(); }
  });
  document.addEventListener('input', (e) => {
    if (e.target.id === 'msg') { e.target.style.height = 'auto'; e.target.style.height = Math.min(e.target.scrollHeight, 160) + 'px'; }
    if (e.target.id === 'search') { query = e.target.value; renderAll(); }
    if (e.target.id === 'notesText' && openId) noteDrafts[openId] = e.target.value;
  });
  $('#scrim').onclick = closeTask;
  $('#syncBtn').onclick = () => api('sync', {}).then(() => toast('Syncing with Notion… this takes up to a minute without an API token.')).catch((x) => toast(x.message, 'error'));

  // phone pairing
  $('#connectBtn').onclick = async () => {
    const dlg = $('#connectDlg');
    dlg.showModal();
    await renderConnect();
  };
  async function renderConnect() {
    const c = await api('connect');
    const url = c.tunnel || c.lan[0];
    if (url && window.qrcode) {
      const q = qrcode(0, 'M');
      q.addData(url);
      q.make();
      $('#qr').innerHTML = q.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
    } else $('#qr').textContent = url ? 'QR library offline — use the link below.' : 'No network found.';
    $('#links').innerHTML = [...(c.tunnel ? [c.tunnel] : []), ...c.lan].map((l) => `<code>${h(l)}</code>`).join('');
    $('#tunnelBox').innerHTML = c.local ? `<b>Away from Wi-Fi?</b>
      <span class="muted">Opens a private Cloudflare quick tunnel to this Mac. Only paired devices (the link carries your key) get in.</span>
      <div><button type="button" class="btn small ${c.tunnel ? 'danger' : ''}" id="tunnelBtn">${c.tunnel ? 'Close tunnel' : 'Open tunnel'}</button></div>` : '';
    const btn = $('#tunnelBtn');
    if (btn) btn.onclick = async () => {
      btn.disabled = true;
      btn.textContent = c.tunnel ? 'Closing…' : 'Opening… (about 5s)';
      await api('tunnel', { on: !c.tunnel });
      if (c.tunnel) renderConnect();
    };
  }

  document.addEventListener('click', () => { if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission(); }, { once: true });

  let renderQueued = false;
  const scheduleRender = () => {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => { renderQueued = false; renderAll(); });
  };

  function connectEvents() {
    const es = new EventSource('/api/events');
    es.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'task') {
        const t = S?.tasks.find((x) => x.id === msg.id);
        if (!t) return;
        const before = prevAgent[t.id];
        t.work = msg.work;
        const now = msg.work?.agent?.status;
        prevAgent[t.id] = now;
        scheduleRender();
        if (msg.id === openId) renderDrawer();
        if (msg.work?.simtest) renderLab();
      } else if (msg.type === 'log' && msg.id === openId) {
        log.push(msg.entry);
        if (tab === 'convo') renderPane();
      } else if (msg.type === 'reload') load();
      else if (msg.type === 'setup-job' && ob) {
        const was = ob.job?.status;
        ob.job = msg.job;
        const log = $('#obLog');
        if (log && was === msg.job.status) { log.textContent = msg.job.out; log.scrollTop = log.scrollHeight; }
        else { if (msg.job.status !== 'running') ob.tools = null; renderOnboard(); }
      }
      else if (msg.type === 'brief') { delete briefs[msg.id]; if (openId === msg.id && tab === 'task') loadBrief(msg.id); }
      else if (msg.type === 'sync') { if (S) S.notion.syncing = msg.syncing; scheduleRender(); }
      else if (msg.type === 'toast') toast(msg.text, msg.level);
      else if (msg.type === 'usage') { if (S) { S.usage = msg.usage; refreshMeter(); } }
      else if (msg.type === 'storage') { if (S) { S.storage = msg.storage; refreshStorage(); } }
      else if (msg.type === 'event') onEvent(msg);
      else if (msg.type === 'release') { if (S) { S.release = msg.release; renderReleaseStrip(); if ($('#releaseDlg').open) renderRelease(); } }
      else if (msg.type === 'release-out') { relOut += msg.chunk; if ($('#releaseDlg').open) { if ($('#relTerm').hidden) renderRelease(); else paintTerm(); } }
      else if (msg.type === 'settings') { if (S) { S.settings = msg.settings; if ($('#settingsDlg').open) renderSettings(); } }
      else if (msg.type === 'tunnel' && $('#connectDlg').open) renderConnect();
    };
    es.onerror = () => { /* EventSource retries on its own */ };
    es.onopen = () => { if (S) load(); };
  }

  // ---------- setup wizard: your name, tools, Notion, repos ----------
  const OB_STEPS = ['You', 'Tools', 'Notion', 'Repos', 'Ready'];
  let ob = null;
  const obEl = () => $('#onboard');
  const tick3 = (ok, warn) => (ok ? '<span class="ob-ok">✓</span>' : warn ? '<span class="ob-warn">!</span>' : '<span class="ob-bad">✗</span>');

  async function startOnboarding() {
    const st = await api('setup/status').catch(() => ({}));
    ob = {
      step: 0, name: st.name || '', manager: st.manager || '', tools: null, job: st.job || null,
      notion: { method: st.notion?.hasToken ? 'token' : st.notion?.dataSourceId ? 'connector' : '', tokenOk: !!st.notion?.hasToken, token: '', databases: null, dbId: st.notion?.dataSourceId || '', keep: !!st.notion?.dataSourceId, schema: null, map: null, userId: st.notion?.userId || '', hide: st.notion?.hideStatuses || [], me: null },
      repos: Object.entries(st.repos || {}).map(([key, r]) => ({ key, path: expandHome(r.path), base: r.base, checks: r.checks || [], mobile: false, release: false })),
      busy: '', error: '',
    };
    obEl().hidden = false;
    document.body.classList.add('onboarding');
    renderOnboard();
  }
  const expandHome = (p) => p || '';
  const obBusy = (msg) => { ob.busy = msg; ob.error = ''; renderOnboard(); };
  const obFail = (e) => { ob.busy = ''; ob.error = e.message || String(e); renderOnboard(); };

  function renderOnboard() {
    if (!ob) return;
    const steps = OB_STEPS.map((s, i) => `<li class="${i < ob.step ? 'done' : i === ob.step ? 'now' : ''}"><span>${i < ob.step ? '✓' : i + 1}</span>${s}</li>`).join('');
    const body = [obYou, obTools, obNotion, obRepos, obReady][ob.step]();
    obEl().innerHTML = `<div class="ob-card">
        <div class="ob-top"><span class="brand-mark ob-mark">${$('#brandMark')?.innerHTML || ''}</span><b>Workfloor setup</b><ol class="ob-steps">${steps}</ol></div>
        <div class="ob-body">${body}</div>
        ${ob.error ? `<p class="ob-error">${h(ob.error)}</p>` : ''}
        ${ob.busy ? `<p class="ob-busy"><span class="spin"></span>${h(ob.busy)}</p>` : ''}
      </div>`;
    obEl().querySelector('[autofocus]')?.focus();
  }

  function obNav(nextLabel, nextOk = true, back = true) {
    return `<div class="ob-nav">${back && ob.step ? '<button type="button" class="btn ghost" data-ob="back">← Back</button>' : '<span></span>'}
      <button type="button" class="btn primary" data-ob="next" ${nextOk && !ob.busy ? '' : 'disabled'}>${nextLabel}</button></div>`;
  }

  function obYou() {
    return `<div class="ob-hello"><div class="ob-wave">👋</div><h2>Welcome to the floor.</h2>
        <p class="muted">Workfloor gives every task a desk, a git worktree and a Claude Code agent. Setup takes about five minutes.</p></div>
      <label class="ob-field">What should we call you?<input id="obName" value="${h(ob.name)}" placeholder="Your first name" autocomplete="given-name" autofocus></label>
      <label class="ob-field"><span>Who reads your end-of-day checkout? <small>optional</small></span><input id="obManager" value="${h(ob.manager)}" placeholder="e.g. your lead, or the team"></label>
      ${obNav('Nice to meet you →', true, false)}`;
  }

  function obTools() {
    if (!ob.tools) { if (!ob.busy) { setTimeout(obLoadTools, 0); } return '<p class="muted">Checking your Mac…</p>'; }
    const groups = [['required', 'Needed'], ['recommended', 'Recommended'], ['mobile', 'For iOS and Expo apps'], ['optional', 'Optional']];
    const row = (t) => {
      const authNeeded = t.ok && t.signedIn === false;
      const actions = !t.ok
        ? `${t.canInstall ? `<button type="button" class="btn small primary" data-ob="install" data-id="${t.id}" ${ob.job?.status === 'running' ? 'disabled' : ''}>Install</button>` : ''}
           ${t.canTerminal ? `<button type="button" class="btn small" data-ob="terminal" data-id="${t.id}">${t.canInstall ? 'In Terminal' : 'Set up'}</button>` : ''}`
        : authNeeded ? `<button type="button" class="btn small primary" data-ob="auth" data-id="${t.id}">${h(t.authLabel || 'Sign in')}</button>` : '';
      return `<div class="ob-tool ${t.ok && !authNeeded ? 'ok' : t.need === 'required' ? 'bad' : 'warn'}">
          ${tick3(t.ok && !authNeeded, t.need !== 'required' || authNeeded)}
          <div class="ob-tool-txt"><b>${h(t.label)}</b><small>${t.ok ? h(t.version || 'installed') + (authNeeded ? ' · not signed in' : t.signedIn ? ' · signed in' : '') : h(t.why)}</small></div>
          <div class="ob-tool-act">${actions}</div></div>`;
    };
    const missing = ob.tools.filter((t) => t.need === 'required' && (!t.ok || t.signedIn === false));
    return `<h2>Tools on this Mac</h2>
      <p class="muted">Workfloor drives the tools you already use. Install what's missing here; sign-ins open in Terminal.</p>
      ${groups.map(([need, title]) => {
        const list = ob.tools.filter((t) => t.need === need);
        return list.length ? `<div class="subhead">${title.toUpperCase()}</div><div class="ob-tools">${list.map(row).join('')}</div>` : '';
      }).join('')}
      ${ob.job ? `<div class="subhead">INSTALLING ${h(ob.job.id.toUpperCase())} · ${h(ob.job.status)}</div><pre class="ob-log" id="obLog">${h(ob.job.out)}</pre>` : ''}
      <div class="ob-row"><button type="button" class="btn small ghost" data-ob="recheck">↻ Check again</button>
        ${missing.length ? `<small class="muted">Still needed: ${missing.map((t) => t.label).join(', ')}</small>` : '<small class="ob-good">Everything needed is here.</small>'}</div>
      ${obNav(missing.length ? 'Continue anyway →' : 'Looks good →')}`;
  }
  async function obLoadTools() {
    obBusy('Checking your Mac…');
    try { const r = await api('setup/tools'); ob.tools = r.tools; ob.job = r.job || ob.job; ob.busy = ''; renderOnboard(); } catch (e) { obFail(e); }
  }

  const PROP_FIELDS = [
    ['title', 'Task title', ['title']], ['id', 'Task ID (TASK-123)', ['unique_id', 'number']], ['status', 'Status', ['status', 'select']],
    ['assignee', 'Assigned to', ['people']], ['priority', 'Priority', ['select', 'status']], ['tags', 'Tags', ['multi_select']], ['due', 'Due date', ['date']],
  ];
  function obNotion() {
    const n = ob.notion;
    const method = `<div class="ob-choice">
        <button type="button" class="ob-opt ${n.method === 'token' ? 'sel' : ''}" data-ob="method" data-m="token"><b>🔑 Notion integration token</b><small>Fastest syncs. Create one at notion.so/my-integrations, then share your task database with it.</small></button>
        <button type="button" class="ob-opt ${n.method === 'connector' ? 'sel' : ''}" data-ob="method" data-m="connector"><b>✳️ Claude's Notion connector</b><small>No token. Uses the Notion connection in your Claude account; each sync takes about a minute.</small></button>
      </div>`;
    const token = n.method === 'token' && !n.tokenOk ? `<div class="ob-row"><input id="obToken" class="ob-input" type="password" placeholder="ntn_… or secret_…" value="${h(n.token)}" autocomplete="off" autofocus>
        <button type="button" class="btn primary" data-ob="token">Connect</button></div>` : '';
    const ready = n.method === 'connector' || n.tokenOk;
    const dbs = !ready ? '' : !n.databases ? `<button type="button" class="btn" data-ob="dbs">Find my task databases</button>`
      : `<div class="subhead">YOUR TASK DATABASE</div><div class="ob-dbs">${n.databases.map((d) => `<button type="button" class="ob-opt ${n.dbId === d.id ? 'sel' : ''}" data-ob="db" data-id="${h(d.id)}"><b>${h(d.name)}</b></button>`).join('') || '<p class="muted">No databases found. Share one with your integration, then try again.</p>'}</div>`;
    let map = '';
    if (n.schema) {
      const props = Object.entries(n.schema.properties || {});
      const sel = (key, types) => `<select data-obmap="${key}"><option value="">— none —</option>${props.filter(([, p]) => types.includes(p.type)).map(([name]) => `<option ${n.map[key] === name ? 'selected' : ''}>${h(name)}</option>`).join('')}</select>`;
      const statusProp = n.schema.properties?.[n.map.status];
      const people = n.schema.people || [];
      map = `<div class="subhead">MATCH THE FIELDS</div><div class="ob-map">${PROP_FIELDS.map(([key, label, types]) => `<label>${label}${sel(key, types)}</label>`).join('')}</div>
        <div class="subhead">WHICH TASKS ARE YOURS</div>
        ${n.schema.me ? `<p>You're <b>${h(n.schema.me.name || n.schema.me.id)}</b> in Notion. Workfloor shows tasks assigned to you.</p>`
          : people.length ? `<label class="ob-field">You in Notion<select id="obUser"><option value="">Show every task</option>${people.map((p) => `<option value="${h(p.id)}" ${n.userId === p.id ? 'selected' : ''}>${h(p.name)}</option>`).join('')}</select></label>`
            : '<p class="muted">No people found in that database, so Workfloor will show every task.</p>'}
        ${statusProp?.options?.length ? `<div class="subhead">HIDE TASKS THAT ARE</div><div class="ob-checks">${statusProp.options.map((o) => `<label class="check"><input type="checkbox" data-obhide="${h(o)}" ${n.hide.includes(o) ? 'checked' : ''}> ${h(o)}</label>`).join('')}</div>` : ''}`;
    }
    return `<h2>Connect Notion</h2><p class="muted">Your tasks come from a Notion database. Pick how Workfloor should read it.</p>
      ${method}${token}<div class="ob-section">${dbs}</div>${map}
      ${obNav(n.schema ? 'Next: repos →' : n.keep ? 'Keep my current database →' : 'Next: repos →', !!(n.schema ? n.map.title : n.keep))}`;
  }

  function obRepos() {
    const rows = ob.repos.map((r, i) => `<div class="ob-repo">
        <div class="ob-repo-head"><b>${h(r.key)}</b><small class="muted">${h(r.path)}</small><button type="button" class="linkish" data-ob="rmrepo" data-i="${i}">Remove</button></div>
        <div class="ob-repo-grid">
          <label>Base branch<input data-obrepo="${i}" data-k="base" value="${h(r.base || 'main')}"></label>
          <label class="check"><input type="checkbox" data-obrepo="${i}" data-k="mobile" ${r.mobile ? 'checked' : ''}> iOS / Expo app (Sim test step)</label>
          <label class="check"><input type="checkbox" data-obrepo="${i}" data-k="release" ${r.release ? 'checked' : ''}> Has release scripts (release room)</label>
        </div>
        <label class="ob-field"><span>Checks to run, one per line as <code>Name: command</code>. <code>{changed:ts,tsx}</code> becomes the changed files.</span>
          <textarea data-obrepo="${i}" data-k="checks" rows="3">${h((r.checks || []).map((c) => `${c.name}: ${c.cmd}`).join('\n'))}</textarea></label>
      </div>`).join('');
    return `<h2>Your repos</h2><p class="muted">Each task gets its own git worktree in one of these. Workfloor reads the base branch, package manager and checks from the repo; adjust anything.</p>
      ${rows || '<p class="muted">No repos yet.</p>'}
      <div class="ob-row"><input id="obRepoPath" class="ob-input" placeholder="~/code/my-app" autocomplete="off">
        ${mac ? '<button type="button" class="btn" data-ob="pick">Choose folder…</button>' : ''}
        <button type="button" class="btn primary" data-ob="addrepo">Add repo</button></div>
      ${obNav('Next →', ob.repos.length > 0)}`;
  }

  function obReady() {
    const n = ob.notion;
    return `<div class="ob-hello"><div class="ob-wave">🏢</div><h2>Ready when you are, ${h(ob.name.split(/\s+/)[0])}.</h2>
        <p class="muted">Here's your floor:</p></div>
      <ul class="ob-summary">
        <li>✓ Notion via ${n.method === 'token' ? 'your integration token' : "Claude's connector"}${n.map?.title ? `, title field “${h(n.map.title)}”` : ''}</li>
        <li>✓ ${ob.repos.length} repo${ob.repos.length > 1 ? 's' : ''}: ${ob.repos.map((r) => h(r.key)).join(', ')}</li>
        <li>✓ ${ob.repos.some((r) => r.mobile) ? 'Simulator tests on' : 'No simulator tests (no iOS repo)'}${ob.repos.some((r) => r.release) ? ' · release room on' : ''}</li>
        ${ob.tools?.some((t) => t.need === 'required' && (!t.ok || t.signedIn === false)) ? '<li class="ob-warn-li">! Some required tools still need installing or a sign-in. Agents won\'t run until they do.</li>' : ''}
      </ul>
      ${obNav('Open my floor 🎉')}`;
  }

  // Reads what's on screen into the wizard state before moving on.
  function obCollect() {
    if (ob.step === 0) { ob.name = $('#obName')?.value.trim() || ''; ob.manager = $('#obManager')?.value.trim() || ''; }
    if (ob.step === 2 && $('#obUser')) ob.notion.userId = $('#obUser').value;
    if (ob.step === 3) {
      obEl().querySelectorAll('[data-obrepo]').forEach((el) => {
        const r = ob.repos[Number(el.dataset.obrepo)];
        if (!r) return;
        const k = el.dataset.k;
        if (k === 'checks') r.checks = el.value.split('\n').map((l) => l.match(/^\s*([^:]+):\s*(.+)$/)).filter(Boolean).map((m) => ({ name: m[1].trim(), cmd: m[2].trim() }));
        else r[k] = el.type === 'checkbox' ? el.checked : el.value.trim();
      });
    }
  }

  async function obAddRepo(p) {
    if (!p) return;
    obCollect();
    obBusy('Reading the repo…');
    try {
      const r = await api(`setup/repo?path=${encodeURIComponent(p)}`);
      if (ob.repos.some((x) => x.path === r.path)) throw new Error('That repo is already added.');
      ob.repos.push(r);
      ob.busy = '';
      renderOnboard();
    } catch (e) { obFail(e); }
  }

  async function obClick(el) {
    const a = el.dataset.ob;
    const n = ob.notion;
    if (a === 'back') { obCollect(); ob.step--; ob.error = ''; return renderOnboard(); }
    if (a === 'next') {
      obCollect();
      if (ob.step === 0 && !ob.name) return obFail(new Error('Tell us your name first.'));
      if (ob.step === 4) return obFinish();
      ob.step++;
      ob.error = '';
      if (ob.step === 1 && ob.name) speakHello(`Hi ${ob.name.split(/\s+/)[0]}! Let's set up your floor.`);
      return renderOnboard();
    }
    if (a === 'recheck') { ob.tools = null; return renderOnboard(); }
    if (a === 'install') { try { const r = await api('setup/install', { id: el.dataset.id }); ob.job = r.job; renderOnboard(); } catch (e) { obFail(e); } return; }
    if (a === 'terminal' || a === 'auth') {
      try { await api('setup/terminal', { id: el.dataset.id, step: a === 'auth' ? 'auth' : '' }); toast('Opened Terminal. Come back and tap “Check again” when it’s done.'); } catch (e) { obFail(e); }
      return;
    }
    if (a === 'method') { n.method = el.dataset.m; n.databases = null; n.schema = null; n.tokenOk = n.method === 'token' && n.tokenOk; return renderOnboard(); }
    if (a === 'token') {
      n.token = $('#obToken')?.value.trim();
      obBusy('Checking the token…');
      try { await api('setup/notion-token', { token: n.token }); n.tokenOk = true; ob.busy = ''; renderOnboard(); } catch (e) { obFail(e); }
      return;
    }
    if (a === 'dbs') {
      obBusy(n.method === 'token' ? 'Looking for databases…' : 'Asking Claude to look through your Notion (about 30 seconds)…');
      try { n.databases = (await api('setup/databases')).databases; ob.busy = ''; renderOnboard(); } catch (e) { obFail(e); }
      return;
    }
    if (a === 'db') {
      n.dbId = el.dataset.id;
      n.keep = false;
      n.schema = null;
      obBusy(n.method === 'token' ? 'Reading the fields…' : 'Asking Claude to read the fields (about 30 seconds)…');
      try {
        const r = await api(`setup/schema?id=${encodeURIComponent(n.dbId)}`);
        n.schema = r;
        n.map = r.guess;
        if (r.me?.id) n.userId = r.me.id;
        const opts = r.properties?.[n.map.status]?.options || [];
        n.hide = opts.filter((o) => /done|closed|complete|cancel|archiv/i.test(o));
        ob.busy = '';
        renderOnboard();
      } catch (e) { obFail(e); }
      return;
    }
    if (a === 'addrepo') return obAddRepo($('#obRepoPath')?.value.trim());
    if (a === 'pick') return mac?.postMessage({ pickFolder: true });
    if (a === 'rmrepo') { obCollect(); ob.repos.splice(Number(el.dataset.i), 1); return renderOnboard(); }
  }

  async function obFinish() {
    const n = ob.notion;
    obBusy('Saving and syncing your tasks…');
    try {
      const { assignee, ...props } = n.map || {};
      // Remember each mapped field's options and type, for the new-task form and API writes.
      const P = n.schema?.properties || {};
      const opt = (k) => P[n.map?.[k]]?.options || [];
      const types = Object.fromEntries(Object.entries(n.map || {}).filter(([, v]) => v && P[v]).map(([k, v]) => [k, P[v].type]));
      await api('setup/save', {
        name: ob.name, manager: ob.manager, repos: ob.repos,
        // Skipping the Notion step keeps the database and field mapping you already have.
        notion: n.schema ? {
          source: n.method, dataSourceId: n.dbId, userId: n.userId, assignee: assignee || '', props, hideStatuses: n.hide, types,
          options: { priority: opt('priority'), tags: opt('tags'), complexity: [], testingType: [] },
        } : undefined,
      });
      ob = null;
      obEl().hidden = true;
      document.body.classList.remove('onboarding');
      try { localStorage.removeItem('wf-greeted'); } catch {}
      confetti();
      toast('Your floor is ready. Pulling your tasks from Notion…');
    } catch (e) { obFail(e); }
  }

  function speakHello(text) { if (prefs().voice !== false) speakOnce(`hello:${text}`, text); }

  document.addEventListener('click', (e) => {
    const el = e.target.closest('#onboard [data-ob]');
    if (el && ob) obClick(el);
  });
  document.addEventListener('change', (e) => {
    if (!ob) return;
    if (e.target.dataset.obmap) { ob.notion.map[e.target.dataset.obmap] = e.target.value; renderOnboard(); }
    if (e.target.dataset.obhide !== undefined) {
      const v = e.target.dataset.obhide;
      ob.notion.hide = e.target.checked ? [...new Set([...ob.notion.hide, v])] : ob.notion.hide.filter((x) => x !== v);
    }
  });
  document.addEventListener('keydown', (e) => {
    if (!ob || e.key !== 'Enter' || e.target.tagName === 'TEXTAREA') return;
    if (e.target.id === 'obToken') { e.preventDefault(); obEl().querySelector('[data-ob="token"]')?.click(); }
    else if (e.target.id === 'obRepoPath') { e.preventDefault(); obEl().querySelector('[data-ob="addrepo"]')?.click(); }
    else if (e.target.id === 'obName' || e.target.id === 'obManager') { e.preventDefault(); obEl().querySelector('[data-ob="next"]')?.click(); }
  });

  // Morning hello, once a day per device: on screen always, out loud if voice is on.
  function greetWord() { const hr = new Date().getHours(); return hr < 5 ? 'Up late' : hr < 12 ? 'Good morning' : hr < 17 ? 'Good afternoon' : 'Good evening'; }
  function renderGreet(moves, working) {
    const first = (S.name || '').split(/\s+/)[0];
    const el = $('#greet');
    if (!first) {
      // Set up before onboarding asked for a name: ask once, right here.
      el.hidden = !S.onboarded || !S.local;
      if (!el.querySelector('#greetName')) el.innerHTML = `<b>${greetWord()}!</b> <span>What should Workfloor call you?</span><form id="greetForm"><input id="greetName" placeholder="Your first name" autocomplete="given-name"><button class="btn small primary">Save</button></form>`;
      return;
    }
    el.hidden = false;
    const urgent = moves.filter((m) => ['approval', 'ask', 'error'].includes(m.kind)).length;
    el.innerHTML = `<b>${greetWord()}, ${h(first)}.</b> <span>${urgent ? `${urgent} thing${urgent > 1 ? 's' : ''} waiting on you` : moves.length ? `${moves.length} move${moves.length > 1 ? 's' : ''} ready when you are` : 'Nothing needs you right now'}${working ? ` · ${working} agent${working > 1 ? 's' : ''} at work` : ''}.</span>`;
    const today = new Date().toLocaleDateString('en-CA');
    let greeted = null;
    try { greeted = localStorage.getItem('wf-greeted'); } catch {}
    if (greeted === today || quietNow() || !(prefs().voice || (S.local && S.settings?.mac?.voice))) return;
    try { localStorage.setItem('wf-greeted', today); } catch {}
    const line = `${greetWord()}, ${first}. ${urgent ? `${urgent} thing${urgent > 1 ? 's need' : ' needs'} you.` : moves.length ? `You have ${moves.length} move${moves.length > 1 ? 's' : ''} ready.` : 'All quiet on the floor.'}`;
    if (S.local && S.settings?.mac?.voice) api('settings/say', { text: line }).catch(() => {});
    else speakOnce(`greet:${today}`, line);
  }

  async function load() {
    S = await api('state');
    if (!S.onboarded && !ob) startOnboarding();
    for (const t of S.tasks) prevAgent[t.id] = t.work?.agent?.status;
    const first = (S.name || '').split(/\s+/)[0];
    $('#floorLabel').textContent = S.company ? `${S.company} HQ · Engineering` : first ? `${first}'s floor` : 'Your floor';
    renderAll();
    if (openId) renderDrawer();
  }

  let ticks = 0;
  const tick = () => {
    const now = new Date();
    $('#clock').textContent = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const hr = now.getHours();
    document.body.dataset.daypart = hr >= 5 && hr < 10 ? 'morning' : hr >= 10 && hr < 17 ? 'day' : hr >= 17 && hr < 20 ? 'evening' : 'night';
    if (S && ++ticks % 30 === 0) refreshMeter(); // keep the reset countdowns moving
  };
  tick();
  setInterval(tick, 1000);

  window.addEventListener('hashchange', () => {
    const id = location.hash.slice(1);
    if (id && id !== openId && S?.tasks.some((t) => t.id === id)) openTask(id);
  });

  load().then(() => {
    connectEvents();
    checkUsage();
    loadDevices();
    renderReleaseStrip();
    const fromHash = location.hash.slice(1);
    if (fromHash && S.tasks.some((t) => t.id === fromHash)) openTask(fromHash);
  }).catch((e) => toast(e.message, 'error'));
})();
