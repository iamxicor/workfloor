#!/usr/bin/env node
// Workfloor: a local server that lists your Notion tasks and runs your dev workflow
// (worktree -> Claude agent -> checks -> review -> PR -> CI) from desktop or phone.
// Zero dependencies. Node 20+.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn, execFile } = require('node:child_process');

const ROOT = __dirname;
const HOME_DIR = process.env.WORKFLOOR_HOME || ROOT; // config + data; the Mac app points this at Application Support
const DATA = path.join(HOME_DIR, 'data');
const LOGS = path.join(DATA, 'logs');
fs.mkdirSync(LOGS, { recursive: true });

const HOME = os.homedir();
const expand = (p) => (p || '').replace(/^~(?=$|\/)/, HOME);
// A fresh install starts from the example config and the setup wizard fills it in.
const configFile = path.join(HOME_DIR, 'workfloor.config.json');
if (!fs.existsSync(configFile)) fs.copyFileSync(path.join(ROOT, 'workfloor.config.example.json'), configFile);
const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
const firstRepo = () => Object.keys(config.repos)[0];
// The release room works on the repo with release:native / release:ota scripts (set in setup).
const releaseRepoName = () => (config.release?.repo && config.repos[config.release.repo] ? config.release.repo : config.release ? null : config.repos.mobile ? 'mobile' : null);
const saveConfig = () => fs.writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`);
const PORT = Number(process.env.PORT || config.port || 4747);
const ENV = { ...process.env, PATH: [path.join(HOME, '.bun/bin'), path.join(HOME, '.local/bin'), '/opt/homebrew/bin', process.env.PATH].join(':') };

// ---------- persistence ----------

const readJson = (file, fallback) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
};
const writeJson = (file, value) => {
  // Live child processes hang off work entries; they are never persisted.
  fs.writeFileSync(file + '.tmp', JSON.stringify(value, (k, v) => (k === 'proc' || k === 'checkProc' ? undefined : v), 2));
  fs.renameSync(file + '.tmp', file);
};

const secretFile = path.join(DATA, 'secret.json');
const secret = readJson(secretFile, null) || { token: crypto.randomBytes(18).toString('base64url') };
writeJson(secretFile, secret);

const tasksFile = path.join(DATA, 'tasks.json');
const stateFile = path.join(DATA, 'state.json');
// Task links must point at the page itself: the connector sometimes returns app.notion.com/<id> without /p/,
// which opens the wrong place. Every link is rebuilt from the page id.
const notionUrl = (u) => { const id = String(u || '').match(/[0-9a-f]{32}/i)?.[0]; return id ? `https://www.notion.so/${id}` : u; };
let notion = readJson(tasksFile, { tasks: [] });
for (const t of notion.tasks) t.url = notionUrl(t.url);
// Tasks you hid from the board (deleted in Notion but still listed, or not yours any more).
const hiddenFile = path.join(DATA, 'hidden.json');
let hidden = new Set(readJson(hiddenFile, []));
// work[taskId] = { repo, repos, worktree, extra, branch, base, sessionId, agent, steps, checks, pr, mode }
const work = readJson(stateFile, {});
let saveTimer = null;
const save = () => {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => writeJson(stateFile, work), 250);
};

// Runs never survive a server restart; mark them so the UI does not show a ghost agent.
for (const w of Object.values(work)) {
  if (w.agent?.status === 'running') w.agent = { ...w.agent, status: 'waiting', note: 'Server restarted mid-run' };
  for (const s of Object.values(w.steps || {})) if (s.status === 'running') s.status = 'stopped';
  if (w.checksRunning) w.checksRunning = false;
}

const taskId = (t) => `TASK-${t.TASK}`;
// Where a task sits on the board, whatever your status options are called: notion.stages maps them
// explicitly ({ todo: [...], doing: [...], review: [...], blocked: [...], done: [...] }), else a good guess.
function stageOf(status) {
  for (const [stage, list] of Object.entries(config.notion?.stages || {})) if ((list || []).includes(status)) return stage;
  const v = String(status || '').toLowerCase();
  if (/review|\bqa\b|testing|verify/.test(v)) return 'review';
  if (/block|stuck|on.?hold|waiting/.test(v)) return 'blocked';
  if (!v || /not.?started|to.?do|backlog|\bnew\b|\bopen\b|inbox|planned|ready/.test(v)) return 'todo';
  if (/progress|doing|active|wip|started|develop/.test(v)) return 'doing';
  if (/done|complete|closed|shipped|released|cancel/.test(v)) return 'done';
  return 'blocked';
}
const doneStatus = () => config.notion.doneStatus || (config.notion.hideStatuses || []).find((x) => /done|complete/i.test(x)) || 'Done';
const findTask = (id) => notion.tasks.find((t) => taskId(t) === id);
const W = (id) => (work[id] ||= { steps: {}, checks: [], agent: { status: 'idle', queue: [] } });

// ---------- live updates (SSE) ----------

const clients = new Set();
const broadcast = (msg) => {
  const line = `data: ${JSON.stringify(msg)}\n\n`;
  for (const res of clients) res.write(line);
};
const pushTask = (id) => { broadcast({ type: 'task', id, work: publicWork(id) }); applyAlwaysOn(); };
const publicWork = (id) => {
  const w = work[id];
  if (!w) return null;
  const { proc, checkProc, ...rest } = w;
  return { ...rest, approvals: pendingFor(id) };
};
setInterval(() => broadcast({ type: 'ping', t: Date.now() }), 25000);

// ---------- helpers ----------

const run = (cmd, args, opts = {}) => new Promise((resolve) => {
  execFile(cmd, args, { env: ENV, maxBuffer: 32 * 1024 * 1024, timeout: opts.timeout || 120000, cwd: opts.cwd }, (err, stdout, stderr) => {
    resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout), stderr: String(stderr) });
  });
});
const git = (cwd, ...args) => run('git', ['-C', cwd, ...args]);

const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').split('-').slice(0, 5).join('-') || 'task';

const appendLog = (id, entry) => {
  entry.at = Date.now();
  fs.appendFileSync(path.join(LOGS, `${id}.jsonl`), JSON.stringify(entry) + '\n');
  broadcast({ type: 'log', id, entry });
};
const readLog = (id, limit = 600) => {
  try {
    const lines = fs.readFileSync(path.join(LOGS, `${id}.jsonl`), 'utf8').trim().split('\n');
    return lines.slice(-limit).map((l) => JSON.parse(l));
  } catch { return []; }
};

// ---------- Claude usage meter ----------
// Every claude run streams a rate_limit_event with the plan's 5-hour and weekly windows; the latest
// one is the meter. Costs of Workfloor's own runs (API-equivalent estimates) go in a 31-day ledger.

const usageFile = path.join(DATA, 'usage.json');
const usage = readJson(usageFile, { limits: null, ledger: [] });
let probing = null;

// Seed the ledger once from turns already in the task logs.
if (!usage.backfilled) {
  for (const f of fs.readdirSync(LOGS).filter((f) => f.endsWith('.jsonl'))) {
    for (const e of readLog(f.replace('.jsonl', ''), 1e6)) {
      const m = e.t === 'done' && e.text.match(/\$(\d+\.\d+)/);
      if (m) usage.ledger.push({ at: e.at, id: f.replace('.jsonl', ''), kind: 'chat', cost: Number(m[1]) });
    }
  }
  usage.backfilled = true;
  writeJson(usageFile, usage);
}

function usageSummary() {
  const dayStart = new Date().setHours(0, 0, 0, 0);
  const weekStart = Date.now() - 7 * 864e5;
  const total = (from) => usage.ledger.filter((e) => e.at >= from).reduce((a, e) => ({ cost: a.cost + e.cost, runs: a.runs + 1 }), { cost: 0, runs: 0 });
  const byTask = {};
  for (const e of usage.ledger.filter((e) => e.at >= weekStart)) {
    const b = (byTask[e.id] ||= { id: e.id, cost: 0, runs: 0, today: 0 });
    b.cost += e.cost; b.runs += 1;
    if (e.at >= dayStart) b.today += e.cost;
  }
  return {
    limits: usage.limits, probing: !!probing, today: total(dayStart), week: total(weekStart),
    byTask: Object.values(byTask).sort((a, b) => b.cost - a.cost).slice(0, 8),
  };
}
const saveUsage = () => { writeJson(usageFile, usage); broadcast({ type: 'usage', usage: usageSummary() }); };

function noteLimits(info) {
  const win = info?.unifiedWindows;
  if (!win) return;
  const pick = (x) => x && { pct: Math.round((x.utilization || 0) * 100), resetsAt: x.resetsAt * 1000 };
  const wasPaused = meterPaused();
  usage.limits = { fiveHour: pick(win.five_hour), sevenDay: pick(win.seven_day), status: info.status, overage: !!info.isUsingOverage, at: Date.now() };
  if (!wasPaused && meterPaused()) emit(null, 'paused', `5-hour meter at ${usage.limits.fiveHour.pct}%: autopilot is paused`, `Heads up. Your Claude meter is at ${usage.limits.fiveHour.pct} percent, so autopilot is paused.`);
  saveUsage();
}
function noteCost(id, kind, cost) {
  if (!cost) return;
  const cutoff = Date.now() - 31 * 864e5;
  usage.ledger = [...usage.ledger.filter((e) => e.at > cutoff), { at: Date.now(), id, kind, cost }];
  saveUsage();
}

// Calls fn for each JSON line on a stream-json stdout.
function readEvents(stream, fn) {
  let buf = '';
  stream.on('data', (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let ev;
      try { ev = JSON.parse(line); } catch { continue; }
      fn(ev);
    }
  });
}

// The cheapest way to read the meter when no agent is running: a one-word Haiku turn with no tools,
// MCP servers, hooks or saved session (about 5s and $0.001).
function probeLimits() {
  if (probing) return probing;
  probing = new Promise((resolve) => {
    const args = ['-p', 'ok', '--model', 'haiku', '--max-turns', '1', '--output-format', 'stream-json', '--verbose',
      '--strict-mcp-config', '--no-session-persistence', '--setting-sources', '', '--tools', ''];
    const proc = spawn('claude', args, { cwd: os.tmpdir(), env: ENV, stdio: ['ignore', 'pipe', 'ignore'] });
    readEvents(proc.stdout, (ev) => {
      if (ev.type === 'rate_limit_event') noteLimits(ev.rate_limit_info);
      else if (ev.type === 'result') noteCost('meter', 'meter', ev.total_cost_usd);
    });
    const timer = setTimeout(() => proc.kill(), 60000);
    const done = () => { clearTimeout(timer); probing = null; broadcast({ type: 'usage', usage: usageSummary() }); resolve(); };
    proc.on('close', done);
    proc.on('error', done);
  });
  broadcast({ type: 'usage', usage: usageSummary() });
  return probing;
}

const fill = (tpl, vars) => tpl.replace(/\{(\w+)\}/g, (m, k) => (vars[k] ?? m));

const lanAddresses = () => Object.values(os.networkInterfaces()).flat()
  .filter((a) => a && a.family === 'IPv4' && !a.internal).map((a) => a.address);

// ---------- Notion sync ----------

let syncing = false;

const propValue = (p) => {
  if (!p) return null;
  switch (p.type) {
    case 'title': return p.title.map((x) => x.plain_text).join('');
    case 'rich_text': return p.rich_text.map((x) => x.plain_text).join('');
    case 'status': return p.status?.name ?? null;
    case 'select': return p.select?.name ?? null;
    case 'multi_select': return p.multi_select.map((x) => x.name);
    case 'unique_id': return p.unique_id?.number ?? null;
    case 'date': return p.date?.start ?? null;
    default: return null;
  }
};

// Notion property names for each field Workfloor reads, set during setup. The defaults are the names
// of the database Workfloor was first built against, so existing configs keep working.
const PROPS = () => ({
  title: 'Task Name', id: 'TASK', status: 'Status', priority: 'Priority', tags: 'Tags', due: 'Due Date',
  testingType: 'Testing Type', complexity: 'Complexity', ...(config.notion.props || {}),
});
// A database without an ID column still needs a stable number for TASK-n; it comes from the page id.
const idFromPage = (pageId) => parseInt(String(pageId).replace(/-/g, '').match(/[0-9a-f]{32}/i)?.[0].slice(-6) || '0', 16) % 1000000;
const taskNumber = (v, pageId) => Number(String(v ?? '').replace(/\D+/g, '')) || idFromPage(pageId);
const asTags = (v) => (Array.isArray(v) ? v : typeof v === 'string' && v.startsWith('[') ? JSON.parse(v) : v ? [v] : []);

async function syncViaApi() {
  const token = process.env.NOTION_API_TOKEN;
  const P = PROPS();
  const out = [];
  let cursor;
  do {
    const res = await fetch(`https://api.notion.com/v1/data_sources/${config.notion.dataSourceId}/query`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Notion-Version': '2025-09-03', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...(config.notion.assigneeProp && config.notion.userId ? { filter: { property: config.notion.assigneeProp, people: { contains: config.notion.userId } } } : {}),
        page_size: 100, start_cursor: cursor,
      }),
    });
    if (!res.ok) throw new Error(`Notion API ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const body = await res.json();
    for (const page of body.results) {
      const p = page.properties;
      const title = Object.values(p).find((x) => x.type === 'title');
      out.push({
        url: page.url, TASK: taskNumber(propValue(p[P.id]), page.id), 'Task Name': propValue(p[P.title] || title),
        Status: propValue(p[P.status]), Priority: propValue(p[P.priority]), Tags: asTags(propValue(p[P.tags])),
        Complexity: propValue(p[P.complexity]), 'Testing Type': propValue(p[P.testingType]),
        due: propValue(p[P.due]), createdTime: page.created_time,
      });
    }
    cursor = body.has_more ? body.next_cursor : undefined;
  } while (cursor);
  return out;
}

// No API token: ask a headless Claude, which already has the Notion connector, to run the query.
async function syncViaClaude() {
  const ds = config.notion.dataSourceId;
  const P = PROPS();
  const q = (name) => `"${String(name).replace(/"/g, '""')}"`;
  const hidden = (config.notion.hideStatuses || []).map((s) => `'${s.replace(/'/g, "''")}'`).join(', ') || "''";
  const cols = [
    'url', 'createdTime', `${q(P.title)} AS "Task Name"`,
    ...[['id', 'TASK'], ['status', 'Status'], ['priority', 'Priority'], ['tags', 'Tags'], ['testingType', 'Testing Type'], ['complexity', 'Complexity']]
      .filter(([k]) => P[k]).map(([k, as]) => `${q(P[k])} AS "${as}"`),
    ...(P.due ? [`"date:${P.due.replace(/"/g, '""')}:start" AS due`] : []),
  ];
  const where = [
    ...(config.notion.assigneeProp && config.notion.userId ? [`${q(config.notion.assigneeProp)} LIKE ?`] : []),
    ...(P.status ? [`(${q(P.status)} IS NULL OR ${q(P.status)} NOT IN (${hidden}))`] : []),
  ];
  const prompt = `Use the Notion query-data-sources tool in SQL mode on data_source_urls ["collection://${ds}"]${config.notion.userId ? ` with params ["%${config.notion.userId}%"]` : ''} and this query:
SELECT ${cols.join(', ')} FROM "collection://${ds}"${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY createdTime DESC LIMIT 100
If a column name is rejected, fetch the data source schema, fix the name and run it again. Reply with ONLY the JSON array of result rows, nothing else. Parse "Tags" into a JSON array.`;
  const r = await run('claude', ['-p', prompt, '--output-format', 'stream-json', '--verbose', '--model', 'sonnet',
    '--permission-mode', 'dontAsk', '--allowedTools', 'mcp__claude_ai_Notion'], { timeout: 240000, cwd: DATA });
  const events = r.stdout.split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const limits = events.findLast((e) => e.type === 'rate_limit_event');
  if (limits) noteLimits(limits.rate_limit_info);
  const outer = events.find((e) => e.type === 'result') || {};
  noteCost('sync', 'sync', outer.total_cost_usd);
  const text = outer.result || '';
  const json = text.slice(text.indexOf('['), text.lastIndexOf(']') + 1);
  const rows = JSON.parse(json);
  if (!Array.isArray(rows)) throw new Error('Claude did not return a task list');
  return rows.map((t) => ({ ...t, TASK: taskNumber(t.TASK, t.url), Tags: asTags(t.Tags) }));
}

async function syncTasks() {
  if (syncing || !config.notion.dataSourceId) return;
  syncing = true;
  broadcast({ type: 'sync', syncing: true });
  try {
    const source = process.env.NOTION_API_TOKEN ? 'notion-api' : 'claude-notion';
    const tasks = source === 'notion-api' ? await syncViaApi() : await syncViaClaude();
    const fresh = tasks.filter((t) => t.TASK).map((t) => ({ ...t, url: notionUrl(t.url) }));
    // Sync skips done tasks; keep the ones still waiting for a release so they stay on the board.
    const keep = notion.tasks.filter((t) => !fresh.some((f) => f.TASK === t.TASK) && awaitingRelease(taskId(t)));
    notion = { source, syncedAt: new Date().toISOString(), tasks: [...fresh, ...keep] };
    writeJson(tasksFile, notion);
    hidden = new Set([...hidden].filter((id) => findTask(id)));
    writeJson(hiddenFile, [...hidden]);
    await discover();
    broadcast({ type: 'reload' });
  } catch (e) {
    broadcast({ type: 'toast', level: 'error', text: `Sync failed: ${e.message}` });
  } finally {
    syncing = false;
    broadcast({ type: 'sync', syncing: false });
  }
}

// The board goes stale silently otherwise: re-sync when the list is older than notion.autoSyncMinutes (default 60, 0 = off).
const autoSyncMs = () => (config.notion.autoSyncMinutes ?? 60) * 60e3;
const syncIfStale = () => {
  if (!autoSyncMs() || syncing) return;
  if (Date.now() - new Date(notion.syncedAt || 0).getTime() > autoSyncMs()) syncTasks();
};
setInterval(syncIfStale, 10 * 60e3);

// ---------- discovery: existing worktrees and PRs ----------

async function discover() {
  for (const [repoName, repo] of Object.entries(config.repos)) {
    const r = await git(expand(repo.path), 'worktree', 'list', '--porcelain');
    let wt = null;
    for (const line of r.stdout.split('\n')) {
      if (line.startsWith('worktree ')) wt = line.slice(9);
      const m = line.match(/^branch refs\/heads\/(.*TASK-(\d+).*)$/);
      if (m && wt) {
        const id = `TASK-${m[2]}`;
        const w = W(id);
        if (!w.worktree) Object.assign(w, { repo: repoName, repos: [repoName], worktree: wt, branch: m[1], base: repo.base });
        w.steps.setup ||= { status: 'pass', at: Date.now(), summary: 'Found existing worktree' };
      }
    }
  }
  const r = await run('gh', ['search', 'prs', '--author', '@me', '--owner', config.github.owner, '--state', 'open', '--limit', '60',
    '--json', 'number,title,url,repository,state,isDraft']);
  try {
    for (const pr of JSON.parse(r.stdout || '[]')) {
      const m = pr.title.match(/TASK-(\d+)/);
      if (!m) continue;
      const w = W(`TASK-${m[1]}`);
      const entry = { number: pr.number, url: pr.url, title: pr.title, repo: pr.repository.name, state: String(pr.state).toUpperCase() };
      const list = w.prs || (w.pr ? [w.pr] : []);
      if (!list.some((p) => p.repo === entry.repo && p.number === entry.number)) w.prs = [...list, entry];
      if (!w.pr) w.pr = entry;
    }
  } catch { /* gh not logged in: PRs simply stay unknown */ }
  save();
}

const SHIP_STEP = { id: 'ship', label: 'Ship', icon: 'rocket', kind: 'builtin', hint: 'Merge the PRs, then see which release carries the task.' };
const PR_FIELDS = 'number,title,url,state,isDraft,reviewDecision,statusCheckRollup,headRefName,baseRefName,mergeable,comments,reviews,additions,deletions,changedFiles';
const isOpenPr = (p) => p?.state === 'OPEN';

// A task can have one PR per repo (mobile + web). w.prs holds them all; w.pr is the one to show first.
async function refreshPr(id) {
  const w = W(id);
  const repos = w.repos?.length ? w.repos : Object.keys(config.repos);
  const known = w.prs?.length ? w.prs : w.pr?.number ? [w.pr] : [];
  const found = [];
  for (const repoName of repos) {
    const gh = `${config.github.owner}/${repoName}`;
    const mine = known.filter((p, i) => p.repo === repoName && p.number && known.findIndex((q) => q.repo === p.repo && q.number === p.number) === i);
    const queries = mine.length
      ? mine.map((p) => ['pr', 'view', String(p.number), '-R', gh])
      : [['pr', 'list', '-R', gh, '--state', 'all', ...(w.branch ? ['--head', w.branch] : ['--search', id]), '--limit', '3']];
    for (const args of queries) {
      const r = await run('gh', [...args, '--json', PR_FIELDS]);
      if (r.code !== 0) continue;
      const got = JSON.parse(r.stdout);
      for (const pr of Array.isArray(got) ? got : [got]) if (pr && !found.some((f) => f.repo === repoName && f.number === pr.number)) found.push({ ...pr, repo: repoName });
    }
  }
  if (!found.length) return w.pr || null;
  const before = new Map(known.map((p) => [`${p.repo}#${p.number}`, p]));
  w.prs = found.map((f) => ({
    number: f.number, url: f.url, title: f.title, repo: f.repo, state: f.state,
    draft: f.isDraft, review: f.reviewDecision, base: f.baseRefName, head: f.headRefName,
    mergeable: f.mergeable, additions: f.additions, deletions: f.deletions, files: f.changedFiles,
    comments: (f.comments || []).length + (f.reviews || []).filter((r) => r.body).length,
    checks: (f.statusCheckRollup || []).map((c) => ({
      name: c.name || c.context, status: (c.conclusion || c.state || c.status || '').toLowerCase(), url: c.detailsUrl || c.targetUrl,
    })),
    refreshedAt: Date.now(),
  }));
  for (const pr of w.prs) {
    const prev = before.get(`${pr.repo}#${pr.number}`);
    if (prev?.refreshedAt) prDelta(id, prev, pr);
  }
  w.pr = w.prs.find(isOpenPr) || w.prs[0];
  const checks = w.prs.filter(isOpenPr).flatMap((p) => p.checks);
  const failing = checks.filter(isFailing).length;
  const pending = checks.filter((c) => ['pending', 'in_progress', 'queued', 'expected', ''].includes(c.status)).length;
  const allMerged = w.prs.every((p) => p.state === 'MERGED');
  w.steps.ci = allMerged
    ? { status: 'pass', at: Date.now(), summary: 'Merged' }
    : {
      status: failing ? 'fail' : pending ? 'running' : checks.length ? 'pass' : 'idle',
      at: Date.now(),
      summary: checks.length ? `${checks.length - failing - pending} passed, ${failing} failing, ${pending} running` : 'No CI checks yet',
    };
  if (!w.steps.pr || w.steps.pr.status !== 'running') w.steps.pr = { status: 'pass', at: Date.now(), summary: w.prs.map((p) => `#${p.number} ${p.state.toLowerCase()}`).join(' · ') };
  updateShip(id);
  save();
  pushTask(id);
  return w.pr;
}

// Squash-merges one PR (or every open one) and lets the refresh move the task along.
async function mergePrs(id, number) {
  const w = W(id);
  await refreshPr(id);
  const targets = (w.prs || []).filter((p) => isOpenPr(p) && (!number || p.number === Number(number)));
  if (!targets.length) throw new Error('No open PR to merge.');
  for (const p of targets) {
    if (p.draft) throw new Error(`PR #${p.number} is still a draft.`);
    const gh = `${config.github.owner}/${p.repo}`;
    let r = await run('gh', ['pr', 'merge', String(p.number), '-R', gh, '--squash', '--delete-branch'], { timeout: 120000 });
    if (r.code !== 0 && /squash/i.test(r.stderr)) r = await run('gh', ['pr', 'merge', String(p.number), '-R', gh, '--merge', '--delete-branch'], { timeout: 120000 });
    // --delete-branch fails on the local side because the branch is checked out in the worktree; the merge itself went through.
    if (r.code !== 0 && !/already merged|was merged|cannot delete branch|used by worktree/i.test(r.stderr + r.stdout)) {
      throw new Error(`PR #${p.number}: ${(r.stderr || r.stdout).trim().split('\n').pop()}`);
    }
    appendLog(id, { t: 'sys', text: `Merged PR #${p.number} (${p.repo})` });
  }
  return refreshPr(id);
}

// ---------- step: setup (worktree) ----------

async function setupWorktree(id, repoChoice, base) {
  const t = findTask(id);
  if (!t) throw new Error('Unknown task');
  const w = W(id);
  if (w.worktree && fs.existsSync(w.worktree)) return w;
  const repos = ['both', 'all'].includes(repoChoice) ? Object.keys(config.repos) : [config.repos[repoChoice] ? repoChoice : firstRepo()];
  const branch = w.branch || `${config.branchPrefix}/${id}/${slugify(t['Task Name'])}`;
  w.steps.setup = { status: 'running', at: Date.now(), summary: 'Making worktree…' };
  pushTask(id);
  const dirs = [];
  for (const repoName of repos) {
    const repo = config.repos[repoName];
    const root = expand(repo.path);
    const baseBranch = base || repo.base;
    const dir = path.join(root, '.claude', 'worktrees', `${id}-${slugify(t['Task Name'])}`.slice(0, 60));
    appendLog(id, { t: 'sys', text: `${repoName}: fetching origin/${baseBranch}` });
    await git(root, 'fetch', 'origin', baseBranch);
    if (!fs.existsSync(dir)) {
      const exists = (await git(root, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`)).code === 0;
      const remote = !exists && (await git(root, 'rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`)).code === 0;
      const args = exists ? ['worktree', 'add', dir, branch]
        : remote ? ['worktree', 'add', '-b', branch, dir, `origin/${branch}`]
        : ['worktree', 'add', '-b', branch, dir, `origin/${baseBranch}`];
      const r = await git(root, ...args);
      if (r.code !== 0) {
        w.steps.setup = { status: 'fail', at: Date.now(), summary: r.stderr.trim().split('\n').pop() };
        appendLog(id, { t: 'error', text: r.stderr });
        pushTask(id);
        throw new Error(r.stderr.trim());
      }
    }
    // A fresh worktree has no node_modules; borrow the main checkout's so checks run at once.
    const nm = path.join(dir, 'node_modules');
    if (!fs.existsSync(nm) && fs.existsSync(path.join(root, 'node_modules'))) fs.symlinkSync(path.join(root, 'node_modules'), nm);
    for (const envFile of ['.env', '.env.local']) {
      const src = path.join(root, envFile);
      if (fs.existsSync(src) && !fs.existsSync(path.join(dir, envFile))) fs.copyFileSync(src, path.join(dir, envFile));
    }
    dirs.push(dir);
    appendLog(id, { t: 'sys', text: `${repoName}: worktree ready at ${dir} on ${branch}` });
  }
  Object.assign(w, { repo: repos[0], repos, worktree: dirs[0], extra: dirs.slice(1), branch, base: base || config.repos[repos[0]].base });
  w.steps.setup = { status: 'pass', at: Date.now(), summary: `${repos.join(' + ')} on ${branch}` };
  save();
  pushTask(id);
  return w;
}

// ---------- agent runs (headless Claude Code) ----------

const SYSTEM_APPEND = `You are running headless, driven from Workfloor, a dashboard the user reads on a phone or desktop.
- AskUserQuestion and permission prompts are not available. When you need a decision, end your turn with a short numbered list of questions, each with your recommended option first. The user's reply arrives as the next message.
- Keep messages short and plain. Lead with the outcome.
- Never switch branches or create new worktrees; stay in the current working directory.`;

function startAgent(id, prompt, stepId) {
  const w = W(id);
  if (!w.worktree) throw new Error('Clock in first: the task has no worktree yet.');
  if (w.agent.status === 'running') {
    w.agent.queue = [...(w.agent.queue || []), { prompt, stepId }];
    save(); pushTask(id);
    return;
  }
  const t = findTask(id);
  const context = `\nThis session is for Notion task ${id}: "${t?.['Task Name'] || ''}" (${t?.url || ''}). Branch: ${w.branch}. Base: ${w.base || 'main'}. `
    + (w.pr?.url ? `Open PR: ${w.pr.url}.` : 'No PR yet.');
  const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose',
    '--permission-mode', w.mode || config.agent.permissionMode || 'auto',
    '--append-system-prompt', SYSTEM_APPEND + context, '--name', `${id} · Workfloor`];
  const model = w.model || config.agent.model;
  if (model) args.push('--model', model);
  if (w.sessionId) args.push('--resume', w.sessionId);
  for (const d of [...(w.extra || []), ...(w.simtest ? [w.simtest.dir] : [])]) args.push('--add-dir', d);
  args.push(...approvalArgs(id));

  appendLog(id, { t: 'user', text: prompt, step: stepId });
  // MCP_TOOL_TIMEOUT: an approval waits for you, however long that takes.
  const proc = spawn('claude', args, { cwd: w.worktree, env: { ...ENV, MCP_TOOL_TIMEOUT: '86400000' }, stdio: ['ignore', 'pipe', 'pipe'] });
  w.proc = proc;
  w.agent = { status: 'running', step: stepId || null, startedAt: Date.now(), queue: w.agent.queue || [], activity: 'Thinking…' };
  if (stepId) w.steps[stepId] = { status: 'running', at: Date.now(), summary: 'Agent working…' };
  save(); pushTask(id);

  let lastText = '';
  let result = null;
  readEvents(proc.stdout, handleEvent);
  let errText = '';
  proc.stderr.on('data', (c) => { errText += c; });

  function handleEvent(ev) {
    if (ev.type === 'system' && ev.subtype === 'init') {
      w.sessionId = ev.session_id;
      save();
    } else if (ev.type === 'assistant') {
      for (const c of ev.message?.content || []) {
        if (c.type === 'text' && c.text.trim()) {
          lastText = c.text;
          appendLog(id, { t: 'text', text: c.text });
        } else if (c.type === 'tool_use') {
          const summary = toolSummary(c.name, c.input);
          w.agent.activity = summary;
          appendLog(id, { t: 'tool', name: c.name, text: summary, tid: c.id });
          pushTask(id);
        }
      }
    } else if (ev.type === 'user') {
      for (const c of ev.message?.content || []) {
        if (c.type !== 'tool_result') continue;
        const text = Array.isArray(c.content) ? c.content.map((x) => x.text || '').join('\n') : String(c.content ?? '');
        appendLog(id, { t: 'result', tid: c.tool_use_id, error: !!c.is_error, text: text.slice(0, 4000) });
      }
    } else if (ev.type === 'rate_limit_event') {
      noteLimits(ev.rate_limit_info);
    } else if (ev.type === 'result') {
      result = ev;
      noteCost(id, stepId || 'chat', ev.total_cost_usd);
    }
  }

  proc.on('close', (code, signal) => {
    delete w.proc;
    const denied = result?.permission_denials?.length || 0;
    const failed = !result || result.is_error || (code !== 0 && !signal);
    const asks = /\?\s*$|^\s*\d+\.\s.*\?/m.test(lastText) || denied > 0;
    const status = signal ? 'stopped' : failed ? 'error' : asks ? 'needs-you' : 'waiting';
    if (result) appendLog(id, { t: 'done', text: `Turn finished in ${Math.round((result.duration_ms || 0) / 1000)}s` + (result.total_cost_usd ? ` · $${result.total_cost_usd.toFixed(2)}` : '') + (denied ? ` · ${denied} action(s) blocked by permissions` : '') });
    if (failed && !signal) appendLog(id, { t: 'error', text: (result?.result || errText || `claude exited with ${code}`).slice(0, 3000) });
    if (signal) appendLog(id, { t: 'sys', text: 'Stopped' });
    w.agent = { status, step: null, endedAt: Date.now(), queue: w.agent.queue || [], last: lastText.slice(0, 400) };
    if (stepId) {
      const stepStatus = signal ? 'stopped' : failed ? 'fail' : asks ? 'needs-you' : 'pass';
      w.steps[stepId] = { status: stepStatus, at: Date.now(), summary: firstLine(lastText) };
    }
    if (stepId === 'pr' && !failed) {
      // One PR per repo is normal for a mobile + web task; keep every URL the agent printed.
      const repoKey = (name) => Object.keys(config.repos).find((k) => k === name || path.basename(expand(config.repos[k].path)) === name) || name;
      const urls = [...lastText.matchAll(/https:\/\/github\.com\/[^/\s]+\/([^/\s]+)\/pull\/(\d+)/g)];
      for (const m of urls) {
        const pr = { number: Number(m[2]), url: m[0].replace(/[).,]+$/, ''), repo: repoKey(m[1]) };
        w.prs = [...(w.prs || []).filter((p) => !(p.repo === pr.repo && p.number === pr.number)), pr];
      }
      if (urls.length) w.pr = w.prs[0];
      refreshPr(id).catch(() => {});
    }
    collectReport(id);
    denyPending(id, 'The agent turn ended.');
    save(); pushTask(id);
    const next = (w.agent.queue || []).shift();
    if (!signal && !next) {
      const q = question(lastText);
      if (status === 'needs-you') emit(id, 'needs-you', q || firstLine(lastText), `${deskName(id)} needs you. ${q}`);
      else if (status === 'error') emit(id, 'error', firstLine(result?.result || errText) || 'The agent stopped with an error', `${deskName(id)} hit a snag.`);
      else emit(id, 'done', firstLine(lastText), `${deskName(id)} is done.`);
    }
    // A build that ends without questions moves on by itself: checks, then the simulator test.
    if (stepId === 'code' && status === 'waiting') {
      if (settings.autopilot.checksAfterBuild) {
        w.testAfterChecks = !next;
        appendLog(id, { t: 'sys', text: 'Autopilot: running checks after the build' });
        runChecks(id).catch(() => {});
      } else if (!next) autoTest(id);
    }
    if (next && !signal) startAgent(id, next.prompt, next.stepId);
  });
}

const firstLine = (s) => (s || '').split('\n').map((l) => l.replace(/[#*_`>]/g, '').trim()).find(Boolean)?.slice(0, 160) || '';

function toolSummary(name, input = {}) {
  const short = (p) => (p ? String(p).replace(HOME, '~').split('/').slice(-3).join('/') : '');
  switch (name) {
    case 'Bash': return `$ ${String(input.command || '').split('\n')[0].slice(0, 140)}`;
    case 'Read': return `Reading ${short(input.file_path)}`;
    case 'Edit': case 'MultiEdit': return `Editing ${short(input.file_path)}`;
    case 'Write': return `Writing ${short(input.file_path)}`;
    case 'Grep': return `Searching for "${String(input.pattern).slice(0, 60)}"`;
    case 'Glob': return `Finding ${input.pattern}`;
    case 'TodoWrite': return 'Updating its plan';
    case 'Task': case 'Agent': return `Sub-agent: ${input.description || ''}`;
    case 'WebFetch': case 'WebSearch': return `Web: ${input.url || input.query || ''}`;
    case 'Skill': return `Skill: ${input.skill || ''}`;
    default:
      if (name.startsWith('mcp__')) return `${name.split('__').slice(1).join(' › ')}`;
      return name;
  }
}

function stopAgent(id) {
  const w = W(id);
  if (w.agent) w.agent.queue = [];
  if (w.proc) w.proc.kill('SIGINT');
  denyPending(id, 'Stopped from Workfloor.');
  if (w.checkProc) w.checkProc.kill('SIGTERM');
}

// ---------- checks (tests, lint, types) ----------

async function changedFiles(w) {
  const files = new Set();
  for (const args of [
    ['diff', '--name-only', '--diff-filter=ACMR', `origin/${w.base || 'main'}...HEAD`],
    ['diff', '--name-only', '--diff-filter=ACMR', 'HEAD'],
    ['ls-files', '--others', '--exclude-standard'],
  ]) {
    const r = await git(w.worktree, ...args);
    r.stdout.split('\n').filter(Boolean).forEach((f) => files.add(f));
  }
  return [...files].filter((f) => fs.existsSync(path.join(w.worktree, f)));
}

async function runChecks(id) {
  const w = W(id);
  if (!w.worktree) throw new Error('Clock in first: the task has no worktree yet.');
  if (w.checksRunning) return;
  const repo = config.repos[w.repo];
  const changed = await changedFiles(w);
  w.checksRunning = true;
  w.checks = repo.checks.map((c) => ({ name: c.name, cmd: c.cmd, status: 'queued' }));
  w.steps.checks = { status: 'running', at: Date.now(), summary: 'Running checks…' };
  save(); pushTask(id);
  appendLog(id, { t: 'sys', text: `Checks started (${changed.length} changed files)` });

  for (const check of w.checks) {
    if (!w.checksRunning) { check.status = 'skipped'; continue; }
    let skip = false;
    const cmd = check.cmd.replace(/\{changed:([\w,]+)\}/g, (_, exts) => {
      const list = changed.filter((f) => exts.split(',').some((e) => f.endsWith('.' + e)));
      if (!list.length) skip = true;
      return list.map((f) => `'${f.replace(/'/g, "'\\''")}'`).join(' ');
    });
    if (skip) { Object.assign(check, { status: 'skipped', out: 'No changed files of this type.' }); pushTask(id); continue; }
    check.status = 'running';
    check.startedAt = Date.now();
    pushTask(id);
    const out = await new Promise((resolve) => {
      let text = '';
      const p = spawn('bash', ['-lc', cmd], { cwd: w.worktree, env: { ...ENV, CI: '1', FORCE_COLOR: '0' } });
      w.checkProc = p;
      const timer = setTimeout(() => p.kill('SIGTERM'), 15 * 60 * 1000);
      const add = (c) => { text += c; if (text.length > 200000) text = text.slice(-120000); };
      p.stdout.on('data', add);
      p.stderr.on('data', add);
      p.on('close', (code) => { clearTimeout(timer); delete w.checkProc; resolve({ code, text }); });
    });
    check.ms = Date.now() - check.startedAt;
    check.out = out.text.replace(/\x1b\[[0-9;]*m/g, '').slice(-12000);
    Object.assign(check, judge(out, changed));
    pushTask(id);
  }
  w.checksRunning = false;
  const failed = w.checks.filter((c) => c.status === 'fail').length;
  const passed = w.checks.filter((c) => c.status === 'pass').length;
  w.steps.checks = { status: failed ? 'fail' : 'pass', at: Date.now(), summary: `${passed} passed, ${failed} failed, ${w.checks.length - passed - failed} skipped` };
  appendLog(id, { t: 'sys', text: `Checks: ${w.steps.checks.summary}` });
  save(); pushTask(id);
  if (failed) emit(id, 'checks-fail', w.steps.checks.summary, `Checks failed on ${deskName(id).toLowerCase()}.`);
  else emit(id, 'checks-pass', w.steps.checks.summary, `Checks passed on ${deskName(id).toLowerCase()}.`);
  if (w.testAfterChecks) {
    w.testAfterChecks = false;
    if (failed) { if (testStepFor(w) && settings.autopilot.testAfterBuild) appendLog(id, { t: 'sys', text: 'Autopilot: checks failed, so the simulator test waits for you' }); }
    else autoTest(id);
  }
}

const testStepFor = (w) => config.workflow.find((s) => s.id === 'simtest' && (!s.repos || (w.repos || [w.repo]).some((r) => s.repos.includes(r))));

// Starts the Sim test on a booted iOS simulator, booting an iPhone first if none is running.
async function autoTest(id) {
  const w = W(id);
  if (!settings.autopilot.testAfterBuild || !testStepFor(w) || w.agent?.status === 'running') return;
  if (meterPaused()) return appendLog(id, { t: 'sys', text: `Autopilot held back the simulator test: the 5-hour meter is at ${usage.limits.fiveHour.pct}%` });
  try {
    const { booted, available } = await listDevices();
    let dev = booted.find((d) => d.kind === 'ios-sim');
    if (!dev) {
      dev = available.find((d) => d.kind === 'ios-sim' && /iPhone/.test(d.name));
      if (!dev) return appendLog(id, { t: 'sys', text: 'Autopilot: no iOS simulator to test on' });
      appendLog(id, { t: 'sys', text: `Autopilot: booting ${dev.name} for the simulator test` });
      await bootSimulator(dev.id);
    }
    appendLog(id, { t: 'sys', text: `Autopilot: testing on ${dev.name} after a clean build` });
    await runSimTest(id, { device: dev.id, focus: 'This test started automatically after a clean build. Go with sensible cases without asking me to confirm the plan; only stop to ask before anything risky or destructive (seeding a database, deleting data).' });
  } catch (e) {
    appendLog(id, { t: 'error', text: `Autopilot could not start the simulator test: ${e.message}` });
  }
}

// A repo that was already broken shouldn't fail every task. Type errors count only in files this
// branch changed (the rest are reported), and a test runner that can't even start is skipped, not failed.
const TS_ERROR = /^([^\s(][^\n(]*?\.[cm]?[jt]sx?)(?:\(\d+,\d+\)|:\d+:\d+)(?::\s*| - )error TS\d+/gm;
const CANT_START = /● Validation Error|Configuration Documentation:|command not found|Cannot find module '[^']+' from '[^']*node_modules/;

function judge(out, changed) {
  const text = out.text.replace(/\x1b\[[0-9;]*m/g, '');
  if (out.code === 0) return { status: 'pass', summary: summarize(text, 0) };
  const errs = [...text.matchAll(TS_ERROR)].map((m) => m[1].replace(/^\.\//, ''));
  if (errs.length) {
    const mine = errs.filter((f) => changed.includes(f)).length;
    const elsewhere = errs.length - mine;
    const note = elsewhere ? `${elsewhere} elsewhere in the repo, not in files you changed` : '';
    return mine
      ? { status: 'fail', summary: `${mine} type error${mine === 1 ? '' : 's'} in your files${note ? ` · ${note}` : ''}` }
      : { status: 'pass', summary: `None in your files · ${note}` };
  }
  if (CANT_START.test(text)) {
    const why = text.split('\n').map((l) => l.trim()).find((l) => /moved|install|cannot find|not found|unknown option|missing/i.test(l) && !/^at /.test(l));
    return { status: 'skipped', summary: `Couldn't start${why ? `: ${why.slice(0, 140)}` : ''}` };
  }
  return { status: 'fail', summary: summarize(text, out.code) };
}

function summarize(text, code) {
  const clean = text.replace(/\x1b\[[0-9;]*m/g, '');
  const jest = clean.match(/Tests:\s+([^\n]+)/);
  if (jest) return jest[1].trim();
  const bun = clean.match(/(\d+) pass[\s\S]*?(\d+) fail/);
  if (bun) return `${bun[1]} passed, ${bun[2]} failed`;
  const tsc = clean.match(/Found (\d+) errors?/);
  if (tsc) return `${tsc[1]} type errors`;
  const eslint = clean.match(/✖ (\d+) problems?[^\n]*/);
  if (eslint) return eslint[0];
  return code === 0 ? 'Clean' : (clean.trim().split('\n').pop() || `Exit ${code}`).slice(0, 140);
}

const checksSummary = (w) => (w.checks?.length
  ? w.checks.map((c) => `- [${c.status === 'pass' ? 'x' : ' '}] ${c.name}: ${c.status}${c.summary ? ` (${c.summary})` : ''}`).join('\n')
  : '- Workfloor checks were not run.');

// ---------- workflow steps ----------

async function runStep(id, stepId, body = {}) {
  const step = config.workflow.find((s) => s.id === stepId);
  if (!step) throw new Error(`Unknown step ${stepId}`);
  const t = findTask(id);
  const w = W(id);
  if (stepId === 'setup') { if (body.model) w.model = body.model; return setupWorktree(id, body.repo || firstRepo(), body.base); }
  if (stepId === 'simtest') return runSimTest(id, body);
  if (stepId === 'checks') { runChecks(id).catch((e) => appendLog(id, { t: 'error', text: e.message })); return; }
  if (stepId === 'ci') {
    if (body.fix) return startAgent(id, withNotes(fill(step.agentPrompt, vars(id, t, w)), w), 'ci');
    return refreshPr(id);
  }
  if (body.base) w.base = body.base;
  return startAgent(id, withNotes(fill(step.prompt, vars(id, t, w)), w), stepId);
}

// Your own instructions for a task ride along with every agent step.
const withNotes = (prompt, w) => (w.notes?.trim() ? `${prompt}\n\nInstructions from me for this task (they come before anything in the Notion page):\n${w.notes.trim()}` : prompt);

const vars = (id, t, w) => ({
  taskId: id, url: t?.url || '', title: t?.['Task Name'] || '', worktree: w.worktree, branch: w.branch,
  base: w.base || 'main', extraDirs: w.extra?.length ? ` (the other repo's worktree on the same branch: ${w.extra.join(', ')})` : '',
  checksSummary: checksSummary(w), prUrl: w.pr?.url || '', prNumber: w.pr?.number || '',
  owner: config.github.owner, repoName: w.pr?.repo || w.repo,
});

// ---------- device lab: booted simulators and connected devices ----------

const REPORTS = path.join(DATA, 'reports');
let devCache = { at: 0, value: null };

async function listDevices() {
  if (devCache.value && Date.now() - devCache.at < 4000) return devCache.value;
  const booted = [];
  const available = [];
  const sim = await run('xcrun', ['simctl', 'list', 'devices', 'available', '-j'], { timeout: 15000 });
  try {
    const runtimes = Object.entries(JSON.parse(sim.stdout).devices)
      .map(([rt, list]) => ({ ver: (rt.split('SimRuntime.')[1] || '').replace(/-(\d+)-(\d+)$/, ' $1.$2'), list }))
      .sort((a, b) => b.ver.localeCompare(a.ver, undefined, { numeric: true }));
    for (const { ver, list } of runtimes) {
      for (const d of list) {
        const dev = { id: d.udid, name: d.name, os: ver, kind: 'ios-sim' };
        if (d.state === 'Booted') booted.push(dev);
        else available.push(dev);
      }
    }
  } catch {}
  const adb = await run('adb', ['devices', '-l'], { timeout: 8000 });
  for (const line of adb.stdout.split('\n').slice(1)) {
    const m = line.match(/^(\S+)\s+device\b(.*)/);
    if (!m) continue;
    booted.push({ id: m[1], name: (m[2].match(/model:(\S+)/)?.[1] || m[1]).replace(/_/g, ' '), os: 'Android', kind: m[1].startsWith('emulator-') ? 'android-emu' : 'android' });
  }
  // Physical iPhones show up only while connected (cable or Wi-Fi); they can be listed but not driven.
  const tmp = path.join(os.tmpdir(), `workfloor-devicectl-${process.pid}.json`);
  await run('xcrun', ['devicectl', 'list', 'devices', '--json-output', tmp], { timeout: 15000 });
  for (const d of readJson(tmp, {}).result?.devices || []) {
    if (d.hardwareProperties?.reality !== 'physical' || d.connectionProperties?.tunnelState !== 'connected') continue;
    booted.push({ id: d.hardwareProperties.udid, name: d.deviceProperties?.name || 'iPhone', os: `iOS ${d.deviceProperties?.osVersionNumber || ''}`.trim(), kind: 'ios-device' });
  }
  devCache = { at: Date.now(), value: { booted, available: available.slice(0, 30) } };
  return devCache.value;
}

// Small JPEG of the device screen, cached for a few seconds so several viewers share one capture.
const shots = new Map();
const devSize = new Map(); // device id -> screen size in pixels, from its last screenshot
async function screenshot(dev) {
  const cached = shots.get(dev.id);
  if (cached && Date.now() - cached.at < 4000) return cached.buf;
  const tag = crypto.randomBytes(4).toString('hex');
  const png = path.join(os.tmpdir(), `workfloor-shot-${tag}.png`);
  const jpg = path.join(os.tmpdir(), `workfloor-shot-${tag}.jpg`);
  if (dev.kind === 'ios-sim') await run('xcrun', ['simctl', 'io', dev.id, 'screenshot', '--type=png', png], { timeout: 15000 });
  else if (dev.kind.startsWith('android')) await run('bash', ['-c', 'adb -s "$1" exec-out screencap -p > "$2"', '_', dev.id, png], { timeout: 15000 });
  else return null;
  const dims = await run('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', png], { timeout: 15000 });
  const wpx = Number(dims.stdout.match(/pixelWidth: (\d+)/)?.[1]);
  const hpx = Number(dims.stdout.match(/pixelHeight: (\d+)/)?.[1]);
  if (wpx && hpx) devSize.set(dev.id, { w: wpx, h: hpx });
  await run('sips', ['-Z', '640', '-s', 'format', 'jpeg', '-s', 'formatOptions', '70', png, '--out', jpg], { timeout: 15000 });
  let buf = null;
  try { buf = fs.readFileSync(jpg); } catch {}
  for (const f of [png, jpg]) fs.rmSync(f, { force: true });
  if (buf) shots.set(dev.id, { at: Date.now(), buf });
  return buf;
}

async function bootSimulator(udid) {
  const { available } = await listDevices();
  if (!available.some((d) => d.id === udid)) throw new Error('That simulator is not available to boot.');
  const r = await run('xcrun', ['simctl', 'boot', udid], { timeout: 60000 });
  if (r.code !== 0 && !/current state: Booted/.test(r.stderr)) throw new Error(r.stderr.trim() || 'simctl boot failed');
  spawn('open', ['-a', 'Simulator'], { detached: true, stdio: 'ignore' }).unref();
  devCache.at = 0;
}

async function shutdownDevice(id) {
  const { booted } = await listDevices();
  const dev = booted.find((d) => d.id === id);
  if (!dev) throw new Error('That device is not running.');
  if (dev.kind === 'ios-sim') await run('xcrun', ['simctl', 'shutdown', id], { timeout: 60000 });
  else if (dev.kind === 'android-emu') await run('adb', ['-s', id, 'emu', 'kill'], { timeout: 30000 });
  else throw new Error('Only simulators and emulators can be shut down from here.');
  devCache.at = 0;
}

async function deleteSimulator(id) {
  const { booted, available } = await listDevices();
  const dev = [...booted, ...available].find((d) => d.id === id && d.kind === 'ios-sim');
  if (!dev) throw new Error('No such simulator.');
  if (booted.includes(dev)) await run('xcrun', ['simctl', 'shutdown', id], { timeout: 60000 });
  const r = await run('xcrun', ['simctl', 'delete', id], { timeout: 120000 });
  if (r.code !== 0) throw new Error(r.stderr.trim() || 'simctl delete failed');
  devCache.at = 0;
}

// ---------- sim test: manual QA on a simulator, with a report Workfloor can show ----------

const SIMTEST_APPEND = `

Workfloor test run (the report is shown to me in Workfloor):
- Device: {deviceName}, udid {udid}. It is already booted. Drive only this simulator.
{focus}- Save the evidence in {dir}: screenshots as PNG named like 01-before.png, videos compressed to MP4.
- Write the report to {dir}/report.md, and update it whenever results change, in this shape:
  # QA report: <task title>
  Result: PASS | FAIL | PARTIAL — <one line>
  One line with device, branch and date.
  ## Test cases
  | # | Case | Steps | Expected | Actual | Result |   (Result is exactly PASS, FAIL or SKIP)
  ## Evidence
  Per case a "### <#>. <case>" heading, then its images by file name, for example ![after](01-after.png)
  ## Not covered
- {notion}
- I read this on my phone. Show me the test cases and wait for my yes before seeding or driving the app.`;

async function runSimTest(id, body) {
  const t = findTask(id);
  const w = W(id);
  if (!w.worktree) throw new Error('Clock in first: the task has no worktree yet.');
  const { booted } = await listDevices();
  const dev = booted.find((d) => d.id === body.device && d.kind === 'ios-sim');
  if (!dev) throw new Error('Pick a booted iOS simulator first.');
  const rid = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
  const dir = path.join(REPORTS, id, rid);
  fs.mkdirSync(dir, { recursive: true });
  w.simtest = { rid, dir, device: dev.id, deviceName: `${dev.name} (iOS ${dev.os.replace(/^iOS /, '')})`, startedAt: Date.now(), seen: 0 };
  const step = config.workflow.find((s) => s.id === 'simtest');
  const prompt = fill(step.prompt, vars(id, t, w)) + fill(SIMTEST_APPEND, {
    deviceName: w.simtest.deviceName, udid: dev.id, dir,
    focus: body.focus?.trim() ? `- Focus from me: ${body.focus.trim()}\n` : '',
    notion: body.notion ? 'Also append the report to the Notion task.' : 'Do not upload the report to Notion; Workfloor shows report.md to me.',
  });
  startAgent(id, withNotes(prompt, w), 'simtest');
}

// After every turn: if the run's report.md is new or changed, post it to the conversation.
function collectReport(id) {
  const w = work[id];
  if (!w?.simtest) return;
  const { dir, rid } = w.simtest;
  let stat;
  try { stat = fs.statSync(path.join(dir, 'report.md')); } catch { return; }
  if (stat.mtimeMs <= (w.simtest.seen || 0)) return;
  w.simtest.seen = stat.mtimeMs;
  const text = fs.readFileSync(path.join(dir, 'report.md'), 'utf8');
  const results = text.split('\n').filter((l) => /^\s*\|/.test(l))
    .map((r) => r.split('|').map((c) => c.trim()).filter(Boolean).pop() || '')
    .map((c) => c.match(/\b(PASS|FAIL|SKIP)\b/i)?.[1].toUpperCase()).filter(Boolean);
  const n = (k) => results.filter((x) => x === k).length;
  const report = {
    rid, title: text.match(/^#\s+(.*)/m)?.[1] || 'QA report', pass: n('PASS'), fail: n('FAIL'), skip: n('SKIP'),
    result: text.match(/^Result:\s*\**\s*(PASS|FAIL|PARTIAL)/mi)?.[1].toUpperCase() || (n('FAIL') ? 'FAIL' : 'PASS'),
    device: w.simtest.deviceName,
    images: fs.readdirSync(dir).filter((f) => /\.(png|jpe?g)$/i.test(f)).sort().slice(0, 4),
  };
  w.reports = [{ ...report, at: Date.now() }, ...(w.reports || []).filter((r) => r.rid !== rid)].slice(0, 20);
  w.steps.simtest = { status: report.fail || report.result === 'FAIL' ? 'fail' : 'pass', at: Date.now(), summary: `${report.pass} pass · ${report.fail} fail${report.skip ? ` · ${report.skip} skipped` : ''}` };
  appendLog(id, { t: 'report', ...report });
  emit(id, 'report', `${report.pass} passed, ${report.fail} failed`, `Test report ready for ${deskName(id).toLowerCase()}: ${report.pass} passed, ${report.fail} failed.`);
}

// Static file with byte ranges, so phone browsers can play report videos.
function sendFile(req, res, file) {
  let size;
  try { size = fs.statSync(file).size; } catch { return sendJson(res, 404, { error: 'Not found' }); }
  const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
  if (m && size) {
    const start = Number(m[1] || 0);
    const end = Math.min(m[2] ? Number(m[2]) : size - 1, size - 1);
    res.writeHead(206, { 'Content-Type': type, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1 });
    return fs.createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': size, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache' });
  fs.createReadStream(file).pipe(res);
}

// ---------- Mac storage: free space and caches that are safe to clean ----------
// Each item lists the paths it deletes; everything here is rebuilt or re-downloaded when needed,
// except the items marked caution (archives, Trash), which the UI flags.

const LIB = (...p) => path.join(HOME, 'Library', ...p);
const childrenOf = (dir, skip = () => false) => {
  try { return fs.readdirSync(dir).filter((n) => !skip(n)).map((n) => path.join(dir, n)); } catch { return []; }
};
const OWN_CACHES = new Set(['Yarn', 'CocoaPods', 'Homebrew']);
const CLEANABLE = [
  { id: 'derived-data', group: 'Xcode', label: 'Xcode DerivedData', detail: 'Build products and indexes. The next build is slower while Xcode rebuilds them.', targets: () => childrenOf(LIB('Developer/Xcode/DerivedData')) },
  { id: 'device-support', group: 'Xcode', label: 'iOS DeviceSupport', detail: 'Debug symbols copied from iPhones you plugged in. Copied again next time you connect one.', targets: () => [...childrenOf(LIB('Developer/Xcode/iOS DeviceSupport')), ...childrenOf(LIB('Developer/Xcode/watchOS DeviceSupport'))] },
  { id: 'archives', group: 'Xcode', label: 'Xcode Archives', caution: true, detail: 'Archived app builds. Gone for good: you can no longer re-export or symbolicate those builds.', targets: () => childrenOf(LIB('Developer/Xcode/Archives')) },
  { id: 'sim-caches', group: 'Simulators', label: 'Simulator caches', detail: 'Runtime caches. Rebuilt the next time a simulator boots.', targets: () => childrenOf(LIB('Developer/CoreSimulator/Caches')) },
  { id: 'sim-unavailable', group: 'Simulators', label: 'Unavailable simulators', detail: "Simulators whose iOS version is no longer installed. They can't boot anyway.", size: sizeUnavailableSims, clean: () => run('xcrun', ['simctl', 'delete', 'unavailable'], { timeout: 300000 }) },
  { id: 'metro', group: 'JavaScript', label: 'Metro bundler cache', detail: 'React Native bundle cache in the temp folder. Same as starting Metro with --reset-cache.', targets: () => childrenOf(os.tmpdir(), (n) => !/^(metro-|haste-map-)/.test(n)) },
  { id: 'npm', group: 'JavaScript', label: 'npm cache', detail: 'Downloaded packages. npm fetches them again when needed.', targets: () => [path.join(HOME, '.npm/_cacache')] },
  { id: 'bun', group: 'JavaScript', label: 'Bun cache', detail: 'Downloaded packages. Bun fetches them again when needed.', targets: () => [path.join(HOME, '.bun/install/cache')] },
  { id: 'yarn', group: 'JavaScript', label: 'Yarn cache', detail: 'Downloaded packages. Yarn fetches them again when needed.', targets: () => childrenOf(LIB('Caches/Yarn')) },
  { id: 'cocoapods', group: 'Native', label: 'CocoaPods cache', detail: 'Downloaded pods. pod install fetches them again.', targets: () => childrenOf(LIB('Caches/CocoaPods')) },
  { id: 'gradle', group: 'Native', label: 'Gradle cache', detail: 'Android build cache and dependencies. The next Android build downloads them again.', targets: () => [path.join(HOME, '.gradle/caches')] },
  { id: 'homebrew', group: 'System', label: 'Homebrew downloads', detail: 'Installers Homebrew already used.', targets: () => childrenOf(LIB('Caches/Homebrew')) },
  { id: 'app-caches', group: 'System', label: 'Other app caches', detail: "Everything else in ~/Library/Caches (Apple's own excluded). Apps rebuild them; quit big apps first.", targets: () => childrenOf(LIB('Caches'), (n) => OWN_CACHES.has(n) || /^(com\.apple\.|CloudKit|FamilyCircle|familycircled)/.test(n)) },
  { id: 'logs', group: 'System', label: 'Logs', detail: 'Old app, simulator and crash logs in ~/Library/Logs.', targets: () => childrenOf(LIB('Logs')) },
  { id: 'trash', group: 'System', label: 'Trash', caution: true, detail: 'Permanently deletes everything in the Trash. Finder does the emptying.', targets: () => childrenOf(path.join(HOME, '.Trash')),
    clean: () => run('osascript', ['-e', 'tell application "Finder" to empty trash'], { timeout: 300000 }) },
];

async function sizeUnavailableSims() {
  const r = await run('xcrun', ['simctl', 'list', 'devices', 'unavailable', '-j'], { timeout: 20000 });
  try { return Object.values(JSON.parse(r.stdout).devices).flat().reduce((a, d) => a + (d.dataPathSize || 0), 0); } catch { return 0; }
}
async function duBytes(paths) {
  const existing = paths.filter((p) => fs.existsSync(p));
  if (!existing.length) return 0;
  const r = await run('du', ['-sk', '--', ...existing], { timeout: 180000 });
  return r.stdout.split('\n').reduce((a, l) => a + (parseInt(l, 10) || 0), 0) * 1024;
}
function diskSpace() {
  try { const s = fs.statfsSync(HOME); return { free: s.bavail * s.bsize, total: s.blocks * s.bsize }; } catch { return { free: 0, total: 0 }; }
}

const storage = { items: {}, scanning: false, cleaning: false, scannedAt: 0 };
function storageSummary() {
  return {
    ...diskSpace(), scanning: storage.scanning, cleaning: storage.cleaning, scannedAt: storage.scannedAt,
    items: CLEANABLE.map(({ id, group, label, detail, caution }) => ({ id, group, label, detail, caution: !!caution, ...storage.items[id] })),
  };
}
const pushStorage = () => broadcast({ type: 'storage', storage: storageSummary() });

async function measure(item) {
  try {
    let size;
    if (item.size) size = await item.size();
    else if (item.id === 'trash' && !fs.existsSync(path.join(HOME, '.Trash'))) size = 0;
    else {
      // The Trash is hidden from apps without Full Disk Access; say so instead of showing 0.
      try { if (item.id === 'trash') fs.readdirSync(path.join(HOME, '.Trash')); } catch { storage.items[item.id] = { ...storage.items[item.id], size: null, note: 'macOS hides the Trash size' }; return; }
      size = await duBytes(item.targets());
    }
    storage.items[item.id] = { ...storage.items[item.id], size, note: null };
  } catch (e) {
    storage.items[item.id] = { ...storage.items[item.id], size: null, note: e.message };
  }
}

async function scanStorage() {
  if (storage.scanning || storage.cleaning) return;
  storage.scanning = true;
  pushStorage();
  const queue = [...CLEANABLE];
  await Promise.all(Array.from({ length: 4 }, async () => {
    for (let item; (item = queue.shift());) { await measure(item); pushStorage(); }
  }));
  storage.scanning = false;
  storage.scannedAt = Date.now();
  pushStorage();
}

async function cleanStorage(ids) {
  if (storage.cleaning) throw new Error('Already cleaning.');
  const items = CLEANABLE.filter((i) => ids.includes(i.id));
  if (!items.length) throw new Error('Pick something to clean.');
  storage.cleaning = true;
  const before = diskSpace().free;
  pushStorage();
  (async () => {
    for (const item of items) {
      storage.items[item.id] = { ...storage.items[item.id], state: 'cleaning' };
      pushStorage();
      let error = null;
      try {
        if (item.clean) {
          const r = await item.clean();
          if (r.code !== 0) error = (r.stderr || r.stdout).trim().split('\n')[0] || 'failed';
        } else {
          const results = await Promise.allSettled(item.targets().map((p) => fs.promises.rm(p, { recursive: true, force: true })));
          const failed = results.filter((x) => x.status === 'rejected').length;
          if (failed) error = `${failed} item(s) were in use or protected and were skipped`;
        }
      } catch (e) { error = e.message; }
      await measure(item);
      storage.items[item.id] = { ...storage.items[item.id], state: error ? 'partial' : 'done', error };
      pushStorage();
    }
    storage.cleaning = false;
    const freed = Math.max(0, diskSpace().free - before);
    broadcast({ type: 'toast', level: 'info', text: `Cleaning done: about ${(freed / 1e9).toFixed(1)} GB freed.` });
    pushStorage();
  })();
}

// ---------- desktop helpers ----------

function openOnMac(id, what) {
  const w = W(id);
  if (!w.worktree) throw new Error('No worktree yet');
  if (what === 'terminal') {
    const q = (s) => `'${s.replace(/'/g, "'\\''")}'`;
    const cmd = `cd ${q(w.worktree)} && claude${w.sessionId ? ` --resume ${w.sessionId}` : ''}`;
    const script = `tell application "Terminal"\n activate\n do script ${JSON.stringify(cmd)}\nend tell`;
    spawn('osascript', ['-e', script], { detached: true, stdio: 'ignore' }).unref();
  } else if (what === 'editor') {
    spawn('open', ['-a', 'Visual Studio Code', w.worktree], { detached: true, stdio: 'ignore' }).unref();
  } else {
    spawn('open', [w.worktree], { detached: true, stdio: 'ignore' }).unref();
  }
}

// ---------- settings (data/settings.json) ----------

const settingsFile = path.join(DATA, 'settings.json');
const SETTINGS_DEFAULT = {
  mac: { sounds: true, voice: true, voiceName: '', quietFrom: '22:00', quietTo: '08:00' },
  keepAwake: true,
  tunnel: { atStart: false, name: '', url: '' },
  push: { enabled: false, server: 'https://ntfy.sh', topic: `workfloor-${crypto.randomBytes(6).toString('hex')}`, events: ['needs-you', 'approval', 'error', 'ci-fail', 'merged', 'report', 'standup', 'paused'] },
  autopilot: { checksAfterBuild: true, testAfterBuild: true, fixCi: false, fixReviews: false, pauseAt: 90 },
  standup: { time: '09:30', speak: true },
  daily: { manager: '', checkoutTime: '18:30', discordWebhook: '' },
};
const deepMerge = (a, b) => {
  const out = { ...a };
  for (const [k, v] of Object.entries(b || {})) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && a?.[k] && typeof a[k] === 'object' ? deepMerge(a[k], v) : v;
  }
  return out;
};
let settings = deepMerge(SETTINGS_DEFAULT, readJson(settingsFile, {}));
writeJson(settingsFile, settings);

function updateSettings(patch) {
  const tunnelBefore = JSON.stringify(settings.tunnel);
  settings = deepMerge(settings, patch);
  writeJson(settingsFile, settings);
  if (JSON.stringify(settings.tunnel) !== tunnelBefore && tunnel.proc) { toggleTunnel(false); toggleTunnel(true); }
  broadcast({ type: 'settings', settings });
  applyAlwaysOn();
}

const hhmm = (s) => { const [h, m] = String(s || '').split(':').map(Number); return (h || 0) * 60 + (m || 0); };
function quietNow() {
  const { quietFrom, quietTo } = settings.mac;
  if (!quietFrom || !quietTo || quietFrom === quietTo) return false;
  const d = new Date();
  const n = d.getHours() * 60 + d.getMinutes();
  const a = hhmm(quietFrom);
  const b = hhmm(quietTo);
  return a < b ? n >= a && n < b : n >= a || n < b;
}

// ---------- events: what happened becomes a sound, a voice line, a push and a line of history ----------

const EVENTS = {
  'needs-you': { sound: 'Glass', title: 'needs you', prio: 4, tag: 'raising_hand' },
  approval: { sound: 'Ping', title: 'wants your OK', prio: 5, tag: 'warning' },
  done: { sound: 'Pop', title: 'turn finished', prio: 3, tag: 'white_check_mark' },
  error: { sound: 'Basso', title: 'hit a snag', prio: 4, tag: 'x' },
  'checks-pass': { sound: 'Tink', title: 'checks passed', prio: 2, tag: 'test_tube' },
  'checks-fail': { sound: 'Basso', title: 'checks failed', prio: 3, tag: 'test_tube' },
  'ci-fail': { sound: 'Sosumi', title: 'CI failed', prio: 4, tag: 'rotating_light' },
  'review-comment': { sound: 'Purr', title: 'new review comment', prio: 3, tag: 'speech_balloon' },
  merged: { sound: 'Hero', title: 'PR merged', prio: 3, tag: 'tada' },
  report: { sound: 'Purr', title: 'test report ready', prio: 3, tag: 'iphone' },
  paused: { sound: 'Funk', title: 'autopilot paused', prio: 3, tag: 'battery' },
  standup: { sound: 'Morse', title: 'standup', prio: 3, tag: 'sunrise' },
  checkout: { sound: 'Submarine', title: 'time to check out', prio: 3, tag: 'wave' },
  'release-ask': { sound: 'Ping', title: 'release needs your answer', prio: 5, tag: 'rocket' },
  'release-done': { sound: 'Hero', title: 'release step finished', prio: 4, tag: 'rocket' },
  'release-fail': { sound: 'Basso', title: 'release step failed', prio: 4, tag: 'rotating_light' },
};
const eventsFile = path.join(DATA, 'events.jsonl');
const deskName = (id) => `Desk ${String(id).replace('TASK-', '')}`;
const question = (text) => (text || '').split('\n')
  .map((l) => l.replace(/[#*_`>]/g, '').replace(/^\s*(?:[-•]|\d+[.)])\s+/, '').trim())
  .find((l) => l.endsWith('?'))?.slice(0, 200) || '';

function emit(id, kind, text, speech, extra = {}) {
  const ev = { id, kind, text, speech: speech ?? text, at: Date.now(), ...extra };
  try { fs.appendFileSync(eventsFile, JSON.stringify(ev) + '\n'); } catch {}
  broadcast({ type: 'event', ...ev });
  macAlert(ev);
  pushAlert(ev).catch(() => {});
}
const eventsSince = (since) => {
  try {
    return fs.readFileSync(eventsFile, 'utf8').trim().split('\n')
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((e) => e && e.at >= since);
  } catch { return []; }
};

// Mac speakers: works with the Workfloor window closed. Voice lines queue so they never talk over each other.
let speaking = Promise.resolve();
function say(text, force) {
  if (!text || (!force && (!settings.mac.voice || quietNow()))) return;
  const args = settings.mac.voiceName ? ['-v', settings.mac.voiceName, text] : [text];
  speaking = speaking.then(() => new Promise((done) => {
    const p = spawn('say', args, { stdio: 'ignore' });
    const timer = setTimeout(() => p.kill(), 90000);
    p.on('close', () => { clearTimeout(timer); done(); });
    p.on('error', done);
  }));
}
function macAlert(ev) {
  if (quietNow()) return;
  const sound = EVENTS[ev.kind]?.sound;
  if (settings.mac.sounds && sound) spawn('afplay', [`/System/Library/Sounds/${sound}.aiff`], { stdio: 'ignore' }).on('error', () => {});
  if (ev.kind !== 'standup' || settings.standup.speak) say(ev.speech);
}

// ---------- always on: keep the Mac awake while agents work ----------

let awake = null;
function applyAlwaysOn() {
  const busy = Object.values(work).some((w) => w.agent?.status === 'running' || w.checksRunning) || ['running', 'waiting'].includes(release?.run?.status);
  if (settings.keepAwake && busy && !awake) {
    awake = spawn('caffeinate', ['-i', '-w', String(process.pid)], { stdio: 'ignore' });
    awake.on('close', () => { awake = null; });
  } else if ((!busy || !settings.keepAwake) && awake) {
    awake.kill();
    awake = null;
  }
}

// ---------- phone push (ntfy) with one-tap actions ----------
// Action buttons carry a signed, single-use, expiring token for exactly that action, never the pairing key.

const usedActs = new Set();
const actSig = (body) => crypto.createHmac('sha256', secret.token).update(body).digest('base64url').slice(0, 32);
const signAct = (payload) => {
  const body = Buffer.from(JSON.stringify({ ...payload, n: crypto.randomBytes(4).toString('hex'), exp: Date.now() + 6 * 3600e3 })).toString('base64url');
  return `${body}.${actSig(body)}`;
};
function verifyAct(token) {
  const [body, mac] = String(token || '').split('.');
  if (!body || !mac || usedActs.has(token)) return null;
  const good = actSig(body);
  if (mac.length !== good.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(good))) return null;
  const p = JSON.parse(Buffer.from(body, 'base64url').toString());
  if (!(p.exp > Date.now())) return null;
  usedActs.add(token);
  return p;
}
const publicBase = () => tunnel.url || `http://${lanAddresses()[0] || 'localhost'}:${PORT}`;

async function pushAlert(ev, force) {
  const p = settings.push;
  if (!force && (!p.enabled || !p.topic || !([...(p.events || []), 'checkout', 'release-ask', 'release-done', 'release-fail']).includes(ev.kind))) return;
  const def = EVENTS[ev.kind] || {};
  const base = publicBase();
  const actions = [];
  const act = (label, payload) => actions.push({ action: 'http', label, url: `${base}/act/${signAct(payload)}`, method: 'POST', clear: true });
  if (ev.kind === 'needs-you' && ev.id) act('Go with your picks', { a: 'msg', id: ev.id, text: 'Go with your recommendations.' });
  if (ev.kind === 'approval' && ev.aid) { act('Allow', { a: 'ok', aid: ev.aid, allow: true }); act('Deny', { a: 'ok', aid: ev.aid, allow: false }); }
  if (ev.kind === 'ci-fail' && ev.id) act('Fix CI', { a: 'ci', id: ev.id });
  const t = ev.id ? findTask(ev.id) : null;
  const res = await fetch(p.server.replace(/\/$/, ''), {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(10000),
    body: JSON.stringify({
      topic: p.topic,
      title: ev.id ? `${ev.id} ${def.title || ev.kind}` : `Workfloor: ${def.title || ev.kind}`,
      message: [t?.['Task Name'], ev.text].filter(Boolean).join('\n').slice(0, 1000) || 'Workfloor',
      tags: def.tag ? [def.tag] : [], priority: def.prio || 3, click: `${base}/${ev.id ? '#' + ev.id : ''}`, actions,
    }),
  });
  if (!res.ok) throw new Error(`ntfy answered ${res.status}`);
}

function runAct(p) {
  if (p.a === 'msg') return startAgent(p.id, p.text, null);
  if (p.a === 'ci') {
    const step = config.workflow.find((s) => s.id === 'ci');
    return startAgent(p.id, fill(step.agentPrompt, vars(p.id, findTask(p.id), W(p.id))), 'ci');
  }
  if (p.a === 'ok') return answerApproval(p.aid, !!p.allow, p.allow ? '' : 'Denied from a phone notification.');
  throw new Error('Unknown action');
}

// ---------- approvals: agent actions you OK from the phone ----------
// Every run gets --permission-prompt-tool, so instead of being denied outright, an action that needs a
// yes waits here until you answer in Workfloor (or a notification).

const approvals = new Map();
const MCP_APPROVE = path.join(ROOT, 'mcp', 'approve.js');
function approvalArgs(id) {
  const cfg = { mcpServers: { workfloor: { command: process.execPath, args: [MCP_APPROVE], env: { WORKFLOOR_URL: `http://127.0.0.1:${PORT}`, WORKFLOOR_TASK: id } } } };
  return ['--mcp-config', JSON.stringify(cfg), '--permission-prompt-tool', 'mcp__workfloor__approve'];
}
const pendingFor = (id) => [...approvals.values()].filter((a) => a.id === id).map(({ res, ...a }) => a);
const alwaysKey = (tool, input) => (tool === 'Bash' ? `Bash:${String(input.command || '').trim().split(/\s+/).slice(0, 2).join(' ')}` : tool);
const spokenTool = (tool) => ({ Bash: 'run a command', Edit: 'edit a file', Write: 'write a file', MultiEdit: 'edit a file', WebFetch: 'open a web page' }[tool]
  || `use ${tool.replace(/^mcp__[^_]+__/, '').replace(/[-_]/g, ' ')}`);

function requestApproval(id, tool, input, res) {
  if (!findTask(id)) return sendJson(res, 200, { allow: false, message: 'Unknown Workfloor task.' });
  const w = W(id);
  const key = alwaysKey(tool, input);
  if ((w.alwaysAllow || []).includes(key)) return sendJson(res, 200, { allow: true });
  const aid = crypto.randomBytes(6).toString('hex');
  const summary = toolSummary(tool, input);
  const detail = tool === 'Bash' ? String(input.command || '') : JSON.stringify(input).slice(0, 600);
  approvals.set(aid, { aid, id, tool, summary, detail, key, at: Date.now(), res });
  res.on('close', () => { if (approvals.get(aid)?.res === res) { approvals.delete(aid); pushTask(id); } });
  appendLog(id, { t: 'sys', text: `Waiting for your OK: ${summary}` });
  w.agent.activity = `Waiting for your OK: ${summary}`;
  pushTask(id);
  emit(id, 'approval', summary, `${deskName(id)} wants to ${spokenTool(tool)}. Allow?`, { aid });
}
function answerApproval(aid, allow, note, always) {
  const a = approvals.get(aid);
  if (!a) throw new Error('That request is gone: the agent stopped or it was already answered.');
  approvals.delete(aid);
  if (always && allow) { const w = W(a.id); w.alwaysAllow = [...new Set([...(w.alwaysAllow || []), a.key])]; save(); }
  appendLog(a.id, { t: 'sys', text: `${allow ? 'Allowed' : 'Denied'}${always && allow ? ' (always)' : ''}: ${a.summary}${note ? ` — “${note}”` : ''}` });
  sendJson(a.res, 200, { allow, message: note || (allow ? '' : 'The user denied this in Workfloor.') });
  if (work[a.id]?.agent?.status === 'running') work[a.id].agent.activity = allow ? `Allowed: ${a.summary}` : 'Thinking…';
  pushTask(a.id);
}
function denyPending(id, why) {
  for (const a of [...approvals.values()].filter((x) => x.id === id)) answerApproval(a.aid, false, why);
}

// ---------- autopilot ----------

function meterPaused() {
  const pct = Number(settings.autopilot.pauseAt) || 0;
  const f = usage.limits?.fiveHour;
  return !!(pct && f && f.resetsAt > Date.now() && f.pct >= pct);
}
function autopilot(id, rule) {
  if (!settings.autopilot[rule]) return;
  const w = W(id);
  const step = config.workflow.find((s) => s.id === 'ci');
  if (!w.worktree || !step?.agentPrompt) return;
  if (meterPaused()) return appendLog(id, { t: 'sys', text: `Autopilot held back: the 5-hour meter is at ${usage.limits.fiveHour.pct}%` });
  appendLog(id, { t: 'sys', text: rule === 'fixCi' ? 'Autopilot: sending the agent at the failing CI' : 'Autopilot: sending the agent at the new review comments' });
  startAgent(id, fill(step.agentPrompt, vars(id, findTask(id), w)), 'ci');
}
const isFailing = (c) => ['failure', 'error', 'timed_out', 'cancelled', 'action_required'].includes(c.status);
function prDelta(id, prev, pr) {
  const failing = (p) => (p.checks || []).filter(isFailing).map((c) => c.name).sort().join(', ');
  if (prev.state !== 'MERGED' && pr.state === 'MERGED') emit(id, 'merged', `PR #${pr.number} merged`, `PR ${pr.number} merged. Nice work!`);
  const now = failing(pr);
  if (now && now !== failing(prev)) { emit(id, 'ci-fail', `PR #${pr.number}: ${now}`, `CI failed on PR ${pr.number}.`); autopilot(id, 'fixCi'); }
  if ((pr.comments || 0) > (prev.comments || 0)) { emit(id, 'review-comment', `PR #${pr.number} has a new review comment`, `New review comment on PR ${pr.number}.`); autopilot(id, 'fixReviews'); }
}
// Open PRs are checked every 5 minutes, so merges, CI failures and comments show up on their own.
setInterval(async () => {
  for (const [id, w] of Object.entries(work)) if ((w.prs || (w.pr ? [w.pr] : [])).some(isOpenPr)) await refreshPr(id).catch(() => {});
}, 5 * 60e3);

// ---------- diff (branch vs its base, including uncommitted and new files) ----------

async function branchDiff(id) {
  const w = W(id);
  if (!w.worktree) throw new Error('Clock in first: the task has no worktree yet.');
  const repos = [];
  for (const [i, wt] of [w.worktree, ...(w.extra || [])].entries()) {
    const base = (await git(wt, 'merge-base', `origin/${w.base || 'main'}`, 'HEAD')).stdout.trim() || 'HEAD';
    let diff = (await git(wt, 'diff', '--no-color', '--no-ext-diff', '-M', base)).stdout;
    const untracked = (await git(wt, 'ls-files', '--others', '--exclude-standard')).stdout.split('\n').filter(Boolean).slice(0, 40);
    for (const f of untracked) {
      try { if (fs.statSync(path.join(wt, f)).size > 300000) continue; } catch { continue; }
      diff += (await run('git', ['diff', '--no-color', '--no-index', '--', '/dev/null', f], { cwd: wt })).stdout;
    }
    const cap = 2e6;
    repos.push({ repo: (w.repos || [w.repo])[i] || path.basename(wt), diff: diff.slice(0, cap), truncated: diff.length > cap });
  }
  return { repos };
}

// ---------- standup and timesheet ----------

let sheetCache = { at: 0, value: null };
function timesheet() {
  if (sheetCache.value && Date.now() - sheetCache.at < 60000) return sheetCache.value;
  const days = {};
  const week = {};
  const weekAgo = Date.now() - 7 * 864e5;
  for (const f of fs.readdirSync(LOGS).filter((n) => n.endsWith('.jsonl'))) {
    const id = f.replace('.jsonl', '');
    for (const e of readLog(id, 1e6)) {
      if (e.t !== 'done') continue;
      const d = new Date(e.at).toLocaleDateString('en-CA');
      days[d] = (days[d] || 0) + 1;
      if (e.at >= weekAgo) week[id] = (week[id] || 0) + 1;
    }
  }
  const [star, starTurns] = Object.entries(week).sort((a, b) => b[1] - a[1])[0] || [];
  sheetCache = { at: Date.now(), value: { days, star: star || null, starTurns: starTurns || 0 } };
  return sheetCache.value;
}

const STANDUP_WORDS = { merged: 'merged', 'ci-fail': 'CI failed', 'checks-fail': 'checks failed', 'checks-pass': 'checks passed', report: 'test report', 'review-comment': 'review comments' };
function standup() {
  const since = Date.now() - 24 * 3600e3;
  const evs = eventsSince(since);
  const ledger = usage.ledger.filter((e) => e.at >= since);
  const ids = new Set([...evs.map((e) => e.id), ...ledger.map((e) => e.id)].filter((x) => /^TASK-/.test(x || '')));
  for (const [id, w] of Object.entries(work)) if (w.agent?.status === 'needs-you' || w.agent?.status === 'running') ids.add(id);
  const lines = [...ids].map((id) => {
    const w = work[id] || {};
    const mine = ledger.filter((e) => e.id === id);
    const did = [];
    if (mine.length) did.push(`${mine.length} agent turn${mine.length > 1 ? 's' : ''}`);
    for (const [k, word] of Object.entries(STANDUP_WORDS)) if (evs.some((e) => e.id === id && e.kind === k)) did.push(word);
    const now = w.agent?.status === 'needs-you' ? 'waiting on your answer'
      : w.agent?.status === 'running' ? 'working right now'
      : w.pr?.state === 'MERGED' ? 'merged'
      : w.pr?.state === 'OPEN' ? `PR #${w.pr.number} in review`
      : 'your move';
    return { id, title: findTask(id)?.['Task Name'] || id, did: did.join(', ') || 'no activity', now, cost: mine.reduce((a, e) => a + e.cost, 0), last: firstLine(w.agent?.last || '') };
  }).sort((a, b) => (a.now === 'waiting on your answer' ? -1 : 0) - (b.now === 'waiting on your answer' ? -1 : 0));
  const turns = ledger.filter((e) => /^TASK-/.test(e.id)).length;
  const merged = evs.filter((e) => e.kind === 'merged').length;
  const needs = Object.values(work).filter((w) => w.agent?.status === 'needs-you').length;
  const hour = new Date().getHours();
  const hello = hour < 12 ? 'Good morning.' : hour < 18 ? 'Good afternoon.' : 'Good evening.';
  const speech = [
    `${hello} In the last day the office ran ${turns} agent turns across ${lines.length} desks${merged ? ` and merged ${merged} PR${merged > 1 ? 's' : ''}` : ''}.`,
    ...lines.slice(0, 6).map((l) => `${deskName(l.id)}: ${l.now}.`),
    needs ? `${needs} desk${needs > 1 ? 's need' : ' needs'} you.` : 'Nobody is waiting on you.',
  ].join(' ');
  return { since, totals: { turns, merged, needs, cost: ledger.reduce((a, e) => a + e.cost, 0) }, lines, speech, timesheet: timesheet() };
}
let standupDay = null;
setInterval(() => {
  const d = new Date();
  const now = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const today = d.toLocaleDateString('en-CA');
  if (settings.standup.time && now === settings.standup.time && standupDay !== today) {
    standupDay = today;
    const s = standup();
    emit(null, 'standup', `${s.totals.turns} turns, ${s.lines.length} desks, ${s.totals.needs} need you`, s.speech);
  }
}, 20000);

// ---------- daily: checkout message, check-in topics, new Notion tasks ----------
// The end-of-day checkout: bullet points under "Today's output" and "What I need from you".

const dayStart = () => new Date().setHours(0, 0, 0, 0);
const shortTitle = (t) => {
  const s = (t || '').replace(/^\[[^\]]+\]\s*/, '').split(/[.:(]/)[0].trim();
  return s.length <= 60 ? s : `${s.slice(0, 60).replace(/\s+\S*$/, '')}…`;
};

// Who gets a change: the task's audience field in Notion (relabelled by notion.audience if you like),
// plus any feature flag the task's code adds or checks (featureFlags.file names where flags are defined).
const audienceOf = (v) => (v ? (config.notion.audience || {})[v] || v : null);
const FLAG_WORD = () => config.featureFlags?.name || 'feature flag';
const flagCache = new Map();
async function taskFlags(id) {
  const hit = flagCache.get(id);
  if (hit && Date.now() - hit.at < 10 * 60e3) return hit.flags;
  const w = work[id] || {};
  let diff = '';
  if (w.worktree && fs.existsSync(w.worktree)) diff = (await git(w.worktree, 'diff', `origin/${w.base || 'main'}...HEAD`)).stdout;
  else if (w.pr?.number) diff = (await run('gh', ['pr', 'diff', String(w.pr.number), '-R', `${config.github.owner}/${w.pr.repo || w.repo || firstRepo()}`])).stdout;
  const added = diff.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).join('\n');
  const names = [...new Set([...added.matchAll(/\b([A-Z][A-Z0-9_]*_FLAG)\b/g)].map((m) => m[1]))];
  const root = w.worktree && fs.existsSync(w.worktree) ? w.worktree : expand(config.repos[w.repo || firstRepo()]?.path || '');
  let defs = added;
  if (config.featureFlags?.file) try { defs += '\n' + fs.readFileSync(path.join(root, config.featureFlags.file), 'utf8'); } catch {}
  const flags = names.map((n) => defs.match(new RegExp(`${n}\\s*=\\s*['"\`]([^'"\`]+)`))?.[1] || n);
  flagCache.set(id, { at: Date.now(), flags });
  return flags;
}

async function checkoutContext() {
  const since = dayStart();
  const evs = eventsSince(since);
  const ledger = usage.ledger.filter((e) => e.at >= since && /^TASK-/.test(e.id));
  const ids = new Set([...evs.map((e) => e.id), ...ledger.map((e) => e.id)].filter((x) => /^TASK-/.test(x || '')));
  for (const [id, w] of Object.entries(work)) if (Object.values(w.steps || {}).some((st) => st.at >= since)) ids.add(id);
  const tasks = [...ids].filter(findTask).map((id) => {
    const w = work[id] || {};
    const t = findTask(id);
    const did = [];
    const steps = w.steps || {};
    const stepWord = { code: 'built', checks: 'ran checks', review: 'self-reviewed', simtest: 'tested on the simulator', pr: 'raised the PR', ci: 'worked on CI and review comments' };
    for (const [k, word] of Object.entries(stepWord)) if (steps[k]?.at >= since && steps[k].status !== 'running') did.push(steps[k].summary ? `${word} (${steps[k].summary})` : word);
    for (const r of (shippedIndex()[id] || []).filter((x) => x.at >= since)) did.push(`shipped in ${r.version} (${r.env} ${KIND_WORD[r.kind]})`);
    for (const e of evs.filter((x) => x.id === id)) {
      if (e.kind === 'merged') did.push(`merged PR #${w.pr?.number || ''}`.trim());
      if (e.kind === 'report') did.push(`QA report: ${e.text}`);
    }
    return {
      id, title: t['Task Name'], short: shortTitle(t['Task Name']), status: t.Status, url: t.url,
      turns: ledger.filter((e) => e.id === id).length, did,
      pr: w.pr ? { number: w.pr.number, url: w.pr.url, state: w.pr.state, ci: w.steps?.ci?.summary || '' } : null,
      waitingOnMe: w.agent?.status === 'needs-you' ? question(w.agent.last) || firstLine(w.agent.last) : '',
      lastAgent: (w.agent?.last || '').slice(0, 600),
      audience: audienceOf(t['Testing Type']),
    };
  });
  await Promise.all(tasks.map(async (t) => { t.flags = await taskFlags(t.id).catch(() => []); }));
  await matchReleases(true).catch(() => {});
  const releases = await releasedToday();
  const releaseToday = releases.length || release.rc?.at >= since
    ? { releases, rc: release.rc?.at >= since ? `${release.rc.branch} (${release.version}, ${release.env})` : null } : null;
  const openPrs = Object.entries(work).filter(([id]) => findTask(id))
    .flatMap(([id, w]) => (w.prs || (w.pr ? [w.pr] : [])).filter(isOpenPr)
      .map((p) => ({ id, short: shortTitle(findTask(id)['Task Name']), number: p.number, url: p.url, ci: w.steps?.ci?.summary || '' })));
  const blocked = notion.tasks.filter((t) => stageOf(t.Status) === 'blocked').map((t) => ({ id: taskId(t), short: shortTitle(t['Task Name']) }));
  return { date: new Date().toLocaleDateString('en-CA'), manager: settings.daily.manager || 'the team', release: releaseToday, tasks, openPrs, blocked };
}

function checkoutDraft(c) {
  const out = c.tasks.map((t) => {
    const state = t.pr ? (t.pr.state === 'MERGED' ? `merged PR #${t.pr.number}` : `PR #${t.pr.number} ${t.pr.state.toLowerCase()}`) : '';
    const who = [t.audience, ...t.flags.map((f) => `${FLAG_WORD()} \`${f}\``)].filter(Boolean).join(', ');
    return `- ${t.id} ${t.short}: ${state || (t.waitingOnMe ? 'waiting on a decision' : 'in progress')}${who ? ` · for ${who}` : ''} · ${t.url}`;
  });
  const r = c.release;
  if (r) {
    const lines = r.releases.map((x) => `- Released ${x.version} to ${x.env}: ${x.what} · ${x.url}`
      + (x.tasks.length ? `\n  Carries: ${x.tasks.map((t) => `${t.id}${t.short ? ` ${t.short}` : ''}`).join(', ')}` : ''));
    if (r.rc) lines.push(`- Cut ${r.rc}`);
    out.unshift(...lines);
  }
  const needs = [
    ...c.openPrs.map((p) => `- Review PR #${p.number} (${p.id} ${p.short}) ${p.url}`),
    ...c.blocked.map((b) => `- Unblock ${b.id} ${b.short}`),
  ];
  return [
    "Today's output", '', ...(out.length ? out : ['- …']), '',
    `What I need from you (${c.manager})`, '', ...(needs.length ? needs : ['- Nothing, all clear']),
  ].join('\n');
}

// One Claude turn with no tools, MCP servers or saved session: just writing.
async function claudeWrite(prompt, kind) {
  const r = await run('claude', ['-p', prompt, '--model', config.agent.model || 'sonnet', '--output-format', 'json',
    '--strict-mcp-config', '--no-session-persistence', '--tools', ''], { timeout: 180000, cwd: os.tmpdir() });
  const out = JSON.parse(r.stdout || '{}');
  noteCost(kind, kind, out.total_cost_usd);
  if (out.is_error || !out.result) throw new Error(out.result || r.stderr.trim() || 'Claude did not answer');
  return out.result.trim();
}

async function checkoutWrite(current) {
  const c = await checkoutContext();
  return claudeWrite(`Write my end-of-day checkout message for ${c.manager}.
Format, exactly as the team uses it: just bullet points, nothing more.

Today's output
- …

What I need from you (${c.manager})
- …

Rules: plain words a non-engineer can follow, one short line per bullet, lead with the outcome (what changed for users or the product), keep task IDs, PR links and each task's Notion link, no filler, no greetings, no headings other than the two above, no bold. If nothing is needed, say "Nothing, all clear".
- If "release" is set, start with one bullet per item in release.releases: the version, production or staging, what shipped (store build and/or OTA, how many), and the GitHub release link. Mention release.rc if set (a new rc branch was cut).
- If a release item has "tasks", list which tasks it carried.
- For each shipped or merged change, say who gets it (from "audience") and name any feature flag (from "flags") as "behind the ${FLAG_WORD()} \`key\`". Leave it out when unknown.
Reply with only the message.

My current draft (keep anything I clearly added):
${current || checkoutDraft(c)}

What happened today (JSON):
${JSON.stringify(c, null, 1).slice(0, 12000)}`, 'daily');
}

async function postDiscord(text) {
  const hook = settings.daily.discordWebhook;
  if (!/^https:\/\/(discord|discordapp)\.com\/api\/webhooks\//.test(hook || '')) throw new Error('Add a Discord webhook URL in Settings first.');
  const res = await fetch(hook, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: String(text).slice(0, 1990) }), signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`Discord answered ${res.status}`);
}

let checkoutDay = null;
setInterval(() => {
  const d = new Date();
  const now = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const today = d.toLocaleDateString('en-CA');
  if (settings.daily.checkoutTime && now === settings.daily.checkoutTime && checkoutDay !== today) {
    checkoutDay = today;
    emit(null, 'checkout', 'Your checkout draft is ready in Daily', 'Time to check out. Your draft is ready.');
  }
}, 20000);

// Notion reads and writes go through the API when NOTION_API_TOKEN is set, otherwise through a headless
// Claude with your claude.ai Notion connector (slower, no token needed).
// Choices for the new-task form come from your database's own options, saved during setup.
const notionOptions = () => ({
  priority: [], complexity: [], testingType: [], tags: [], ...(config.notion.options || {}),
  checkin: !!config.notion.checkin?.prop,
});
// Notion API value for a property, by the type setup saw (select vs status vs multi_select…).
function notionProp(key, value) {
  const type = config.notion.types?.[key] || { title: 'title', tags: 'multi_select', due: 'date' }[key] || 'select';
  if (type === 'title') return { title: [{ text: { content: value } }] };
  if (type === 'multi_select') return { multi_select: (Array.isArray(value) ? value : [value]).map((name) => ({ name })) };
  if (type === 'date') return { date: { start: value } };
  if (type === 'rich_text') return { rich_text: [{ text: { content: value } }] };
  return { [type === 'status' ? 'status' : 'select']: { name: value } };
}

async function claudeNotion(prompt, kind) {
  const r = await run('claude', ['-p', prompt, '--output-format', 'json', '--model', 'sonnet',
    '--permission-mode', 'dontAsk', '--allowedTools', 'mcp__claude_ai_Notion'], { timeout: 240000, cwd: DATA });
  const out = JSON.parse(r.stdout || '{}');
  noteCost(kind, kind, out.total_cost_usd);
  const text = out.result || '';
  const start = text.search(/[[{]/);
  const end = Math.max(text.lastIndexOf(']'), text.lastIndexOf('}'));
  if (start < 0 || end < start) throw new Error(text.trim().split('\n').pop() || 'Notion did not answer');
  return JSON.parse(text.slice(start, end + 1));
}

// ---------- the task itself: its Notion page body, and your own notes on it ----------
const BRIEFS = path.join(DATA, 'briefs');
const briefLoads = new Map();
function taskBrief(id, fresh) {
  const file = path.join(BRIEFS, `${id}.json`);
  const cached = readJson(file, null);
  if (cached && !fresh) return Promise.resolve(cached);
  if (briefLoads.has(id)) return briefLoads.get(id);
  const t = findTask(id);
  const load = (async () => {
    const r = await run('claude', ['-p', `Fetch the Notion page ${t.url} and reply with only its body as Markdown, exactly as written: headings, lists, checkboxes, tables, code and links. Leave out the page properties. If the page is empty, reply with only the word EMPTY.`,
      '--output-format', 'json', '--model', 'haiku', '--permission-mode', 'dontAsk', '--allowedTools', 'mcp__claude_ai_Notion'], { timeout: 180000, cwd: DATA });
    const out = JSON.parse(r.stdout || '{}');
    noteCost(id, 'brief', out.total_cost_usd);
    if (out.is_error || !out.result) throw new Error((out.result || r.stderr || 'Could not read the Notion page').trim().split('\n').pop());
    const markdown = out.result.trim().replace(/^```(?:markdown|md)?\n([\s\S]*)\n```$/, '$1');
    const brief = { markdown: markdown === 'EMPTY' ? '' : markdown, at: Date.now() };
    fs.mkdirSync(BRIEFS, { recursive: true });
    writeJson(file, brief);
    return brief;
  })().finally(() => briefLoads.delete(id));
  briefLoads.set(id, load);
  return load;
}

async function saveNotes(id, text, toNotion) {
  const w = W(id);
  w.notes = String(text || '').slice(0, 8000);
  w.notesAt = Date.now();
  save(); pushTask(id);
  if (toNotion && w.notes.trim()) {
    const t = findTask(id);
    claudeNotion(`Append this to the end of the Notion page ${t.url}, under a heading "Notes from ${config.me}" (add the heading only if it is not already the last heading on the page). Keep the text exactly as written, as Markdown. Change nothing else. Reply with only {"ok":true}.\n\n${w.notes}`, 'notion')
      .then(() => { appendLog(id, { t: 'sys', text: 'Your notes were added to the Notion page' }); fs.rmSync(path.join(BRIEFS, `${id}.json`), { force: true }); broadcast({ type: 'brief', id }); })
      .catch((e) => appendLog(id, { t: 'error', text: `Could not add your notes to Notion: ${e.message}` }));
  }
}

let topicsCache = { at: 0, list: null, loading: null };
// Check-in topics: tasks tagged with notion.checkin ({ prop, value }, a multi-select option such as
// Category = check-in-topic). Off when that isn't set.
async function checkinTopics(fresh) {
  const ci = config.notion.checkin;
  if (!ci?.prop) return [];
  if (!fresh && topicsCache.list && Date.now() - topicsCache.at < 10 * 60e3) return topicsCache.list;
  if (topicsCache.loading) return topicsCache.loading;
  const ds = config.notion.dataSourceId;
  const P = PROPS();
  const hide = config.notion.hideStatuses || [];
  topicsCache.loading = (async () => {
    let list;
    if (process.env.NOTION_API_TOKEN) {
      const rows = await notionApi(`data_sources/${ds}/query`, { filter: { property: ci.prop, multi_select: { contains: ci.value } }, page_size: 100 });
      list = rows.results.map((page) => ({
        url: page.url, TASK: taskNumber(propValue(page.properties[P.id]), page.id), title: propValue(page.properties[P.title]),
        status: propValue(page.properties[P.status]), priority: propValue(page.properties[P.priority]),
        mine: (page.properties[config.notion.assigneeProp]?.people || []).some((u) => u.id === config.notion.userId),
      })).filter((t) => !hide.includes(t.status));
    } else {
      const q = (n) => `"${String(n).replace(/"/g, '""')}"`;
      const rows = await claudeNotion(`Use the Notion query-data-sources tool in SQL mode on data_source_urls ["collection://${ds}"] with this query:
SELECT url, ${P.id ? `${q(P.id)} AS "TASK", ` : ''}${q(P.title)} AS "title", ${P.status ? `${q(P.status)} AS "status", ` : ''}${P.priority ? `${q(P.priority)} AS "priority", ` : ''}${q(config.notion.assigneeProp)} AS who FROM "collection://${ds}" WHERE ${q(ci.prop)} LIKE '%${String(ci.value).replace(/'/g, "''")}%' ORDER BY createdTime DESC LIMIT 50
Reply with ONLY the JSON array of result rows, nothing else.`, 'notion');
      list = rows.map((r) => ({ url: notionUrl(r.url), TASK: taskNumber(r.TASK, r.url), title: r.title, status: r.status, priority: r.priority, mine: String(r.who || '').includes(config.notion.userId) }))
        .filter((t) => !hide.includes(t.status));
    }
    topicsCache = { at: Date.now(), list, loading: null };
    return list;
  })().catch((e) => { topicsCache.loading = null; throw e; });
  return topicsCache.loading;
}

// Creates a task page in your database. Returns { url, task } (task = the TASK number, when Notion gives it back).
async function createNotionTask(b) {
  const title = String(b.title || '').trim();
  if (!title) throw new Error('Give the task a name.');
  const pick = (v, list) => (list.includes(v) ? v : undefined);
  const many = (v, list) => (Array.isArray(v) ? v.filter((x) => list.includes(x)) : []);
  const O = notionOptions();
  const P = PROPS();
  const ci = config.notion.checkin;
  const fields = {
    title, priority: pick(b.priority, O.priority), complexity: pick(b.complexity, O.complexity),
    testingType: pick(b.testingType, O.testingType), tags: many(b.tags, O.tags),
    checkin: !!(b.checkin && ci?.prop), due: /^\d{4}-\d{2}-\d{2}$/.test(b.due || '') ? b.due : undefined,
    me: b.assignToMe !== false, body: String(b.description || '').slice(0, 8000),
  };
  let made;
  if (process.env.NOTION_API_TOKEN) {
    const props = {
      [P.title]: notionProp('title', fields.title),
      ...(fields.priority && P.priority && { [P.priority]: notionProp('priority', fields.priority) }),
      ...(fields.complexity && P.complexity && { [P.complexity]: notionProp('complexity', fields.complexity) }),
      ...(fields.testingType && P.testingType && { [P.testingType]: notionProp('testingType', fields.testingType) }),
      ...(fields.tags.length && P.tags && { [P.tags]: notionProp('tags', fields.tags) }),
      ...(fields.checkin && { [ci.prop]: { multi_select: [{ name: ci.value }] } }),
      ...(fields.due && P.due && { [P.due]: notionProp('due', fields.due) }),
      ...(fields.me && config.notion.userId && { [config.notion.assigneeProp]: { people: [{ id: config.notion.userId }] } }),
    };
    const children = fields.body ? fields.body.split(/\n{2,}/).map((para) => ({ object: 'block', type: 'paragraph', paragraph: { rich_text: [{ type: 'text', text: { content: para.slice(0, 1900) } }] } })) : [];
    const res = await fetch('https://api.notion.com/v1/pages', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.NOTION_API_TOKEN}`, 'Notion-Version': '2025-09-03', 'Content-Type': 'application/json' },
      body: JSON.stringify({ parent: { type: 'data_source_id', data_source_id: config.notion.dataSourceId }, properties: props, children }),
    });
    if (!res.ok) throw new Error(`Notion API ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const page = await res.json();
    made = { url: page.url, task: taskNumber(propValue(page.properties[P.id]), page.id) };
  } else {
    const props = {
      [P.title]: fields.title,
      ...(fields.priority && P.priority && { [P.priority]: fields.priority }), ...(fields.complexity && P.complexity && { [P.complexity]: fields.complexity }),
      ...(fields.testingType && P.testingType && { [P.testingType]: fields.testingType }),
      ...(fields.tags.length && P.tags && { [P.tags]: JSON.stringify(fields.tags) }), ...(fields.checkin && { [ci.prop]: JSON.stringify([ci.value]) }),
      ...(fields.due && P.due && { [`date:${P.due}:start`]: fields.due, [`date:${P.due}:is_datetime`]: 0 }),
      ...(fields.me && config.notion.userId && { [config.notion.assigneeProp]: JSON.stringify([config.notion.userId]) }),
    };
    made = await claudeNotion(`Create exactly one page with the Notion create-pages tool in the data source collection://${config.notion.dataSourceId}.
Properties (use exactly these values): ${JSON.stringify(props)}
${fields.body ? `Page content (Notion-flavored Markdown, copy as is):\n${fields.body}\n` : ''}Then fetch the new page${P.id ? ` and read its "${P.id}" id` : ''}.
Reply with ONLY this JSON: {"url": "<page url>", "task": <that id number, or null>}`, 'notion');
  }
  const num = taskNumber(made.task, made.url);
  if (fields.me && num) {
    notion.tasks.unshift({ url: made.url, TASK: num, 'Task Name': fields.title, Status: '', Priority: fields.priority, Tags: fields.tags, Complexity: fields.complexity, 'Testing Type': fields.testingType, due: fields.due, createdTime: new Date().toISOString() });
    writeJson(tasksFile, notion);
    broadcast({ type: 'reload' });
  }
  if (fields.checkin) topicsCache.at = 0;
  return { url: made.url, task: num || null };
}

// ---------- gauge: how hard is this task, and which model should take it ----------

const MODELS = ['haiku', 'sonnet', 'opus', 'fable'];
async function gaugeTask(id) {
  const t = findTask(id);
  const g = await claudeNotion(`Fetch the Notion page ${t.url} (the task "${t['Task Name']}"), including its comments, and judge how hard and how risky it is to implement in a React Native + Next.js codebase.
Severity 1-5: 1 = copy or style tweak, 2 = small contained change, 3 = normal feature or bug fix, 4 = cross-cutting, data, auth or money, 5 = risky architecture, security or migration work.
Model: haiku for 1, sonnet for 2-3, opus for 4, fable for 5 (lower it if the page shows the work is simpler than it sounds).
Reply with ONLY this JSON: {"severity": <1-5>, "model": "haiku|sonnet|opus|fable", "reasons": ["<max 3 short reasons, plain words>"]}`, 'gauge');
  return { severity: Math.min(5, Math.max(1, Number(g.severity) || 3)), model: MODELS.includes(g.model) ? g.model : 'sonnet', reasons: (g.reasons || []).slice(0, 3).map(String) };
}

// ---------- clock out: after the merge, end the agent and remove the worktree ----------

// The repo a worktree belongs to. When git has already dropped the worktree (a removal that stopped half
// way), rev-parse fails, but the leftover .git file still names the repo.
async function worktreeRoot(dir) {
  const common = (await git(dir, 'rev-parse', '--path-format=absolute', '--git-common-dir')).stdout.trim();
  if (common) return { root: path.dirname(common), orphan: false };
  let m = null;
  try { m = fs.readFileSync(path.join(dir, '.git'), 'utf8').match(/gitdir:\s*(.+?)\/\.git\/worktrees\//); } catch {}
  return { root: m ? m[1] : null, orphan: true };
}

// A dev server or Metro the agent started from a worktree keeps writing into it and blocks removal.
async function stopProcessesIn(dirs) {
  const r = await run('ps', ['-axo', 'pid=,ppid=,command=']);
  const rows = r.stdout.split('\n').map((l) => l.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/)).filter(Boolean)
    .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), cmd: m[3] }));
  const kill = new Set(rows.filter((p) => dirs.some((d) => p.cmd.includes(`${d}/`))).map((p) => p.pid));
  kill.delete(process.pid);
  for (let grew = true; grew;) {
    grew = false;
    for (const p of rows) if (kill.has(p.ppid) && !kill.has(p.pid)) { kill.add(p.pid); grew = true; }
  }
  for (const pid of kill) try { process.kill(pid, 'SIGTERM'); } catch {}
  if (kill.size) await new Promise((res) => setTimeout(res, 1500));
  for (const pid of kill) try { process.kill(pid, 'SIGKILL'); } catch {}
  return kill.size;
}

async function clockOut(id, { deleteBranch, force } = {}) {
  const w = W(id);
  if (!w.worktree) throw new Error('This task has no worktree.');
  if (w.agent?.status === 'running' || w.checksRunning) { stopAgent(id); w.checksRunning = false; await new Promise((r) => setTimeout(r, 800)); }
  const dirs = [w.worktree, ...(w.extra || [])].filter((d) => fs.existsSync(d));
  // Undo what Clock in added (the node_modules link and copied env files), then look for real work.
  for (const dir of dirs) {
    try { if (fs.lstatSync(path.join(dir, 'node_modules')).isSymbolicLink()) fs.unlinkSync(path.join(dir, 'node_modules')); } catch {}
  }
  if (!force) {
    const dirty = [];
    for (const dir of dirs) {
      if ((await worktreeRoot(dir)).orphan) { dirty.push(`${path.basename(dir)} is a leftover folder git no longer tracks`); continue; }
      const r = await git(dir, 'status', '--porcelain');
      dirty.push(...r.stdout.split('\n').filter(Boolean).filter((l) => !/\s\.env(\.local)?$/.test(l)));
      const ahead = await git(dir, 'rev-list', '--count', '@{u}..HEAD');
      if (ahead.code === 0 && Number(ahead.stdout.trim()) > 0) dirty.push(`${ahead.stdout.trim()} commit(s) not pushed`);
    }
    if (dirty.length) {
      const e = new Error(`${dirty.length} change${dirty.length > 1 ? 's are' : ' is'} not committed or pushed: ${dirty.slice(0, 3).join('; ')}`);
      e.status = 409;
      throw e;
    }
  }
  const stopped = await stopProcessesIn([w.worktree, ...(w.extra || [])]);
  if (stopped) appendLog(id, { t: 'sys', text: `Stopped ${stopped} process${stopped > 1 ? 'es' : ''} still running from the worktree (dev server, Metro)` });
  for (const dir of dirs) {
    const { root, orphan } = await worktreeRoot(dir);
    if (!orphan) {
      const r = await git(root, 'worktree', 'remove', '--force', dir);
      if (r.code !== 0 && fs.existsSync(dir) && !(await worktreeRoot(dir)).orphan) throw new Error(r.stderr.trim() || `Could not remove ${dir}`);
    }
    // Whatever is left is no longer a worktree, just a folder.
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    if (root) {
      await git(root, 'worktree', 'prune');
      if (deleteBranch && w.branch) await git(root, 'branch', '-D', w.branch);
    }
  }
  appendLog(id, { t: 'sys', text: `Clocked out: worktree removed${deleteBranch ? ' and local branch deleted' : ''}. The desk is free.` });
  work[id] = { steps: {}, checks: [], agent: { status: 'idle', queue: [] }, pr: w.pr, prs: w.prs, reports: w.reports, notes: w.notes, clockedOut: Date.now() };
  updateShip(id);
  save();
  pushTask(id);
}

// ---------- release desk: rc branch, version bump PR, yarn release:native / release:ota ----------
// The release scripts are interactive (they ask for version, environment, platform and a final y/N),
// so they run in a pseudo-terminal and every prompt is answered from the desk or the phone.

const releaseFile = path.join(DATA, 'release.json');
let release = readJson(releaseFile, {});
if (['running', 'waiting'].includes(release.run?.status)) release.run.status = 'stopped';
const saveRelease = () => writeJson(releaseFile, release);
const publicRelease = () => { const { proc, ...run } = release.run || {}; return { ...release, run: release.run ? { ...run, out: undefined } : null }; };
const pushRelease = () => { broadcast({ type: 'release', release: publicRelease() }); applyAlwaysOn(); };

const relRepo = () => {
  const name = releaseRepoName();
  if (!name) throw new Error('No repo has release scripts set up.');
  const repo = config.repos[name];
  return { name, root: expand(repo.path), base: repo.base || 'main' };
};
const SEMVER = /^\d+\.\d+\.\d+$/;
const verCmp = (a, b) => a.split('.').map(Number).reduce((r, n, i) => r || n - (Number(b.split('.')[i]) || 0), 0);
// Release conventions, all overridable in config.release. The defaults fit an Expo app with
// `const APP_VERSION = '1.2.3'` in app.config.ts, `release:native` / `release:ota` scripts, and GitHub
// release tags like production/ios/2026-10-30-1/1.2.3 (odd patch versions go to production).
const REL = () => ({
  versionFile: 'app.config.ts', versionVar: 'APP_VERSION', runner: 'yarn', oddPatchIsProduction: true,
  tagPattern: '^(production|staging)/(ios|android|expo)/[\\d-]+/(\\d+\\.\\d+\\.\\d+)$', ...(config.release || {}),
});
const versionRe = () => new RegExp(`^(const ${REL().versionVar} = ')([^']+)(')`, 'm');
const envFor = (v) => (!REL().oddPatchIsProduction || Number(v.split('.')[2]) % 2 ? 'production' : 'staging');
const ansi = (t) => String(t).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');

async function releaseInfo(fresh) {
  const { root, base, name } = relRepo();
  if (fresh) await git(root, 'fetch', 'origin', '--prune', '--quiet');
  const rcs = (await git(root, 'branch', '-r', '--list', 'origin/rc-*')).stdout.split('\n').map((b) => b.trim().replace(/^origin\//, ''))
    .filter((b) => SEMVER.test(b.slice(3))).sort((a, b) => verCmp(a.slice(3), b.slice(3)));
  const latest = rcs.length ? rcs[rcs.length - 1].slice(3) : '0.0.0';
  const mainVersion = (await git(root, 'show', `origin/${base}:${REL().versionFile}`)).stdout.match(versionRe())?.[2] || null;
  const [M, m, p] = latest.split('.').map(Number);
  const suggestions = [
    { version: `${M}.${m}.${p % 2 ? p + 2 : p + 1}`, env: 'production', note: 'next production patch' },
    { version: `${M}.${m}.${p % 2 ? p + 1 : p + 2}`, env: 'staging', note: 'next staging patch' },
    { version: `${M}.${m + 1}.1`, env: 'production', note: 'next minor' },
  ];
  const gh = await ghRepo().catch(() => null);
  // Branches the scripts can run on: main and the newest rc branches, each with its APP_VERSION.
  const runnable = [base, ...rcs.slice(-5).reverse()];
  if (release.rc && !runnable.includes(release.rc.branch)) runnable.splice(1, 0, release.rc.branch);
  const branches = await Promise.all(runnable.map(async (b) => ({
    name: b, version: (await git(root, 'show', `origin/${b}:${REL().versionFile}`)).stdout.match(versionRe())?.[2] || null,
  })));
  const live = liveSummary(await ghReleases(fresh).catch(() => []));
  return { repo: gh ? gh.split('/')[1] : name, base, mainVersion, rcBranches: rcs.slice(-5).reverse(), branches, live, latest, suggestions, owner: gh ? gh.split('/')[0] : null, state: publicRelease() };
}

function startRelease(version) {
  if (!SEMVER.test(version || '')) throw new Error('Use a version like 5.10.3.');
  if (release.version !== version) release = { version, env: envFor(version), rc: null, bumps: [], runs: {} };
}

async function createRc(version) {
  if (['running', 'waiting'].includes(release.run?.status)) throw new Error('A release script is running.');
  startRelease(version);
  const { root, base } = relRepo();
  const branch = `rc-${version}`;
  const remote = (await git(root, 'ls-remote', '--heads', 'origin', branch)).stdout.trim();
  if (remote) {
    release.rc = { branch, sha: remote.split(/\s/)[0], existed: true, at: Date.now() };
  } else {
    const f = await git(root, 'fetch', 'origin', base, '--quiet');
    if (f.code !== 0) throw new Error(f.stderr.trim() || `Could not fetch origin/${base}`);
    const sha = (await git(root, 'rev-parse', `origin/${base}`)).stdout.trim();
    // Straight to GitHub: the branch is made from origin/main without touching any local checkout.
    const r = await git(root, 'push', 'origin', `${sha}:refs/heads/${branch}`);
    if (r.code !== 0) throw new Error(r.stderr.trim() || 'git push failed');
    release.rc = { branch, sha, from: base, at: Date.now() };
  }
  await git(root, 'fetch', 'origin', branch, '--quiet');
  saveRelease();
  pushRelease();
}

// owner/repo of the release checkout's origin on GitHub (gh must target exactly that repo).
async function ghRepo() {
  const url = (await git(relRepo().root, 'remote', 'get-url', 'origin')).stdout.trim();
  const m = url.match(/github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (!m) throw new Error(`origin (${url || 'none'}) is not a GitHub repo, so there is nowhere to open the PR.`);
  return `${m[1]}/${m[2]}`;
}

// The release scripts publish a GitHub release per store build and OTA, tagged
// <env>/<ios|android|expo>/<YYYY-MM-DD>-<n>/<version>: the record of what is live, whoever shipped it.
let ghRelCache = { at: 0, list: [] };
async function ghReleases(fresh) {
  if (!fresh && Date.now() - ghRelCache.at < 5 * 60e3) return ghRelCache.list;
  const gh = await ghRepo().catch(() => null);
  if (!gh) return [];
  const r = await run('gh', ['release', 'list', '-R', gh, '--limit', '150', '--json', 'tagName,publishedAt']);
  if (r.code !== 0) return ghRelCache.list;
  const list = JSON.parse(r.stdout || '[]').map((x) => {
    const m = x.tagName.match(new RegExp(REL().tagPattern));
    return m && { tag: x.tagName, env: m[1], kind: m[2], version: m[3], at: Date.parse(x.publishedAt), url: `https://github.com/${gh}/releases/tag/${x.tagName.split('/').map(encodeURIComponent).join('/')}` };
  }).filter(Boolean).sort((a, b) => b.at - a.at);
  ghRelCache = { at: Date.now(), list };
  return list;
}
function liveSummary(list) {
  const out = {};
  for (const env of ['production', 'staging']) {
    const mine = list.filter((x) => x.env === env);
    out[env] = { ios: mine.find((x) => x.kind === 'ios') || null, android: mine.find((x) => x.kind === 'android') || null, ota: mine.filter((x) => x.kind === 'expo').slice(0, 3) };
  }
  return out;
}
// Releases published today, grouped per version + channel: "5.10.1 to production: OTA ×3".
async function releasedToday() {
  const since = dayStart();
  const today = (await ghReleases(true).catch(() => [])).filter((x) => x.at >= since);
  const groups = {};
  for (const x of today) {
    const g = (groups[`${x.env}/${x.version}`] ||= { version: x.version, env: x.env, kinds: {}, url: x.url, tasks: new Set() });
    for (const t of shipped[x.tag]?.tasks || []) g.tasks.add(t);
    const k = x.kind === 'expo' ? 'OTA update' : `${x.kind === 'ios' ? 'iOS' : 'Android'} store build`;
    g.kinds[k] = (g.kinds[k] || 0) + 1;
  }
  return Object.values(groups).map((g) => ({
    ...g, what: Object.entries(g.kinds).map(([k, n]) => (n > 1 ? `${k} ×${n}` : k)).join(' + '),
    tasks: [...g.tasks].map((id) => ({ id, short: findTask(id) ? shortTitle(findTask(id)['Task Name']) : '' })),
  }));
}

// ---------- what shipped: tasks per release ----------
// Each GitHub release is diffed against the release before it (see below); the TASK ids in the commit
// subjects between the two tags are the tasks it carried. Kept in shipped.json for good.
const shippedFile = path.join(DATA, 'shipped.json');
let shipped = readJson(shippedFile, {});
const KIND_WORD = { expo: 'OTA', ios: 'iOS', android: 'Android' };
function shippedIndex() {
  const idx = {};
  for (const r of Object.values(shipped)) for (const t of r.tasks || []) (idx[t] ||= []).push(r);
  for (const list of Object.values(idx)) list.sort((a, b) => a.at - b.at);
  return idx;
}
let matching = null;
function matchReleases(fresh) {
  matching ||= (async () => {
    const list = await ghReleases(fresh).catch(() => []);
    const { root } = relRepo();
    let fetched = false;
    let added = 0;
    for (const x of list) {
      if (shipped[x.tag]) continue;
      // An OTA is diffed against the last release of the same version (an earlier OTA, or the store build it
      // updates), since OTAs for two versions often go out side by side. A store build is diffed against the
      // previous store build for that platform.
      const prev = (x.kind === 'expo' && list.find((y) => y.env === x.env && y.version === x.version && y.at < x.at))
        || list.find((y) => y.env === x.env && y.kind === x.kind && y.at < x.at);
      if (!prev) continue; // the oldest release we can see has nothing to diff against
      if (!fetched) { await git(root, 'fetch', 'origin', '--tags', '--quiet'); fetched = true; }
      const r = await git(root, 'log', '--format=%s', `${prev.tag}..${x.tag}`);
      if (r.code !== 0) continue;
      shipped[x.tag] = { ...x, prev: prev.tag, tasks: [...new Set([...r.stdout.matchAll(/TASK-(\d+)/g)].map((m) => `TASK-${m[1]}`))] };
      added++;
    }
    if (added) {
      writeJson(shippedFile, shipped);
      for (const id of Object.keys(work)) if (findTask(id)) { updateShip(id); pushTask(id); }
      save();
    }
    return shipped;
  })().finally(() => { matching = null; });
  return matching;
}
setInterval(() => matchReleases().catch(() => {}), 15 * 60e3);

// A finished task stays on the board until a production release carries it (or a month passes),
// even after Notion says done, so you can see it go out.
const SHIP_WAIT_MS = 30 * 864e5;
function awaitingRelease(id, idx = shippedIndex()) {
  const w = work[id];
  const prs = w?.prs || (w?.pr ? [w.pr] : []);
  if (!prs.length || !prs.every((p) => p.state === 'MERGED')) return false;
  if (Date.now() - (w.clockedOut || w.steps?.ship?.at || Date.now()) > SHIP_WAIT_MS) return false;
  return !(idx[id] || []).some((r) => r.env === 'production');
}

// The last station: after every PR is merged it waits for a release, then names the release that carried it.
function updateShip(id) {
  const w = W(id);
  const prs = w.prs || (w.pr ? [w.pr] : []);
  if (!prs.length || !prs.every((p) => p.state === 'MERGED')) { delete w.steps.ship; return; }
  const rel = shippedIndex()[id] || [];
  const prod = rel.filter((r) => r.env === 'production');
  w.steps.ship = rel.length
    ? { status: prod.length ? 'pass' : 'waiting', at: rel[rel.length - 1].at, summary: (prod.length ? prod : rel).slice(-2).map((r) => `${r.version} ${KIND_WORD[r.kind]} · ${r.env}`).join(', ') }
    : { status: 'waiting', at: w.steps.ship?.at || Date.now(), summary: 'Merged · waiting for a release' };
}

// Done with a task: clock out (worktree + local branch) and set the Notion status.
async function finishTask(id, { force, notionStatus = doneStatus() } = {}) {
  const w = W(id);
  if (w.worktree) await clockOut(id, { deleteBranch: true, force });
  if (notionStatus) {
    setNotionStatus(id, notionStatus)
      .then(() => { appendLog(id, { t: 'sys', text: `Notion status set to ${notionStatus}` }); broadcast({ type: 'reload' }); })
      .catch((e) => appendLog(id, { t: 'error', text: `Could not update Notion: ${e.message}` }));
  }
}

async function setNotionStatus(id, status) {
  const t = findTask(id);
  if (!t) throw new Error('Unknown task');
  if (process.env.NOTION_API_TOKEN) {
    const pageId = (t.url.match(/[0-9a-f]{32}/i) || [])[0];
    const res = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${process.env.NOTION_API_TOKEN}`, 'Notion-Version': '2025-09-03', 'Content-Type': 'application/json' },
      body: JSON.stringify({ properties: { Status: { status: { name: status } } } }),
    });
    if (!res.ok) throw new Error(`Notion API ${res.status}`);
  } else {
    await claudeNotion(`Set the "Status" property of the Notion page ${t.url} to "${status}". Change nothing else on the page. Reply with only {"ok":true}.`, 'notion');
  }
  t.Status = status;
  writeJson(tasksFile, notion);
}

// One PR per target: the rc branch, and optionally main so it doesn't lag behind.
async function bumpPr(alsoMain) {
  const v = release.version;
  if (!release.rc) throw new Error('Create the rc branch first.');
  const { root, base } = relRepo();
  const gh = await ghRepo();
  const targets = [release.rc.branch, ...(alsoMain ? [base] : [])].filter((t) => !(release.bumps || []).some((b) => b.base === t));
  for (const target of targets) {
    await git(root, 'fetch', 'origin', target, '--quiet');
    const current = (await git(root, 'show', `origin/${target}:${REL().versionFile}`)).stdout.match(versionRe())?.[2];
    if (current === v) { release.bumps.push({ base: target, skipped: `already ${v}` }); continue; }
    const branch = `${config.branchPrefix}/bump-${v}${target === base ? `-${base}` : ''}`;
    const dir = path.join(root, '.claude', 'worktrees', `bump-${v}-${target.replace(/\W+/g, '-')}`);
    if (fs.existsSync(dir)) await git(root, 'worktree', 'remove', '--force', dir);
    const add = await git(root, 'worktree', 'add', '-B', branch, dir, `origin/${target}`);
    if (add.code !== 0) throw new Error(add.stderr.trim());
    try {
      const file = path.join(dir, REL().versionFile);
      const src = fs.readFileSync(file, 'utf8');
      const next = src.replace(versionRe(), `$1${v}$3`);
      if (next === src) throw new Error(`Could not find ${REL().versionVar} in ${REL().versionFile}`);
      fs.writeFileSync(file, next);
      for (const args of [['commit', '-q', '-m', `chore: bump app version to ${v}`, '--', REL().versionFile], ['push', '-q', '-u', 'origin', branch]]) {
        const r = await git(dir, ...args);
        if (r.code !== 0) throw new Error(r.stderr.trim() || `git ${args[0]} failed`);
      }
      const body = `Sets \`${REL().versionVar}\` in \`${REL().versionFile}\` to **${v}** (${current || '?'} → ${v}) for the \`${release.rc.branch}\` release (${envFor(v)}).\n\nOpened from Workfloor's release desk.`;
      const pr = await run('gh', ['pr', 'create', '-R', gh, '--base', target, '--head', branch, '--title', `chore: bump app version to ${v}${target === base ? ` (${base})` : ''}`, '--body', body], { cwd: dir });
      if (pr.code !== 0) throw new Error(pr.stderr.trim() || 'gh pr create failed');
      const url = pr.stdout.trim().split('\n').pop();
      release.bumps.push({ base: target, branch, url, number: Number(url.match(/\/pull\/(\d+)/)?.[1]), state: 'OPEN', from: current });
    } finally {
      await git(root, 'worktree', 'remove', '--force', dir);
    }
  }
  saveRelease();
  pushRelease();
  await refreshBumps();
}

async function refreshBumps() {
  const gh = await ghRepo().catch(() => null);
  for (const b of release.bumps || []) {
    if (!b.number || !gh) continue;
    const r = await run('gh', ['pr', 'view', String(b.number), '-R', gh, '--json', 'state,mergeable,reviewDecision,statusCheckRollup']);
    if (r.code !== 0) continue;
    const pr = JSON.parse(r.stdout);
    const checks = (pr.statusCheckRollup || []).map((c) => (c.conclusion || c.state || c.status || '').toLowerCase());
    Object.assign(b, {
      state: pr.state, mergeable: pr.mergeable, review: pr.reviewDecision,
      ci: checks.length ? `${checks.filter((c) => c === 'success').length}/${checks.length} checks passed` : 'no checks',
      failing: checks.some((c) => ['failure', 'error', 'timed_out'].includes(c)),
    });
  }
  saveRelease();
  pushRelease();
}

async function mergeBump(number) {
  const r = await run('gh', ['pr', 'merge', String(number), '-R', await ghRepo(), '--squash', '--delete-branch'], { timeout: 120000 });
  if (r.code !== 0) throw new Error(r.stderr.trim().split('\n').pop() || 'gh pr merge failed');
  await refreshBumps();
}

// The release worktree: its own checkout of the rc branch with its own node_modules (yarn install
// there must never touch the main checkout's).
async function releaseWorktree(rc) {
  const { root } = relRepo();
  const dir = path.join(root, '.claude', 'worktrees', `release-${rc.replace(/[^\w.-]+/g, '-')}`);
  const f = await git(root, 'fetch', 'origin', rc, '--quiet');
  if (f.code !== 0) throw new Error(f.stderr.trim() || `Could not fetch ${rc}`);
  if (!fs.existsSync(dir)) {
    let r = await git(root, 'worktree', 'add', '-B', rc, dir, `origin/${rc}`);
    if (r.code !== 0) r = await git(root, 'worktree', 'add', '--detach', dir, `origin/${rc}`); // rc is checked out elsewhere
    if (r.code !== 0) throw new Error(r.stderr.trim());
  } else if (!(await git(dir, 'status', '--porcelain', '--untracked-files=no')).stdout.trim()) {
    const onBranch = (await git(dir, 'symbolic-ref', '-q', 'HEAD')).code === 0;
    await git(dir, ...(onBranch ? ['merge', '--ff-only', `origin/${rc}`] : ['checkout', '--detach', `origin/${rc}`]));
  }
  for (const envFile of ['.env', '.env.local', '.env.production.local', '.env.test.local']) {
    const src = path.join(root, envFile);
    if (fs.existsSync(src) && !fs.existsSync(path.join(dir, envFile))) fs.copyFileSync(src, path.join(dir, envFile));
  }
  return dir;
}

const PROMPT = /(\[y\/N\]\s*$|\?\s*$|:\s*$|\]:\s*$)/;
async function releaseRun(kind, opts = {}) {
  if (!['native', 'ota'].includes(kind)) throw new Error('Unknown release script');
  if (['running', 'waiting'].includes(release.run?.status)) throw new Error('A release script is already running.');
  const { root, base } = relRepo();
  const ref = String(opts.ref || release.rc?.branch || '');
  if (!(ref === base || /^rc-\d+\.\d+\.\d+$/.test(ref))) throw new Error('Pick main or an rc branch to run on.');
  if (!(await git(root, 'ls-remote', '--heads', 'origin', ref)).stdout.trim()) throw new Error(`${ref} is not on origin.`);
  const dir = await releaseWorktree(ref);
  const version = fs.readFileSync(path.join(dir, REL().versionFile), 'utf8').match(versionRe())?.[2] || '?';
  const forRelease = ref === release.rc?.branch;
  const flags = [opts.dryRun && '--dry-run', kind === 'ota' && opts.ignoreFingerprint && '--ignore-fingerprint'].filter(Boolean).join(' ');
  const install = fs.existsSync(path.join(dir, 'node_modules')) ? '' : 'echo "› First run for this release: yarn install…" && yarn install --frozen-lockfile && ';
  const cmd = `${install}${REL().runner} release:${kind}${flags ? ' ' + flags : ''}`;
  // mac/ptyrun.py gives the script a real terminal and relays our stdin, which is a socket
  // (macOS `script` refuses those).
  const proc = spawn('/usr/bin/python3', [path.join(ROOT, 'mac', 'ptyrun.py'), 'bash', '-lc', cmd], { cwd: dir, env: { ...ENV, TERM: 'xterm-256color', FORCE_COLOR: '1', COLUMNS: '120', LINES: '40' } });
  const runInfo = { kind, cmd, dir, ref, version, dryRun: !!opts.dryRun, status: 'running', startedAt: Date.now(), out: '', prompt: null, proc };
  release.run = runInfo;
  // Runs on the current release's rc branch fill in its stations; runs on main or older rcs are one-offs.
  if (forRelease) release.runs = { ...(release.runs || {}), [kind]: { status: 'running', dryRun: !!opts.dryRun, at: Date.now() } };
  else release.adhoc = { kind, ref, version, status: 'running', dryRun: !!opts.dryRun, at: Date.now() };
  saveRelease();
  pushRelease();
  let idle = null;
  const onData = (chunk) => {
    const text = String(chunk);
    runInfo.out = (runInfo.out + text).slice(-400000);
    broadcast({ type: 'release-out', chunk: text });
    clearTimeout(idle);
    // A prompt is a last line without a newline that ends like "[y/N] " or ": ", and then silence.
    idle = setTimeout(() => {
      const last = ansi(runInfo.out).split(/\r?\n/).pop().split('\r').pop().trim();
      if (last && PROMPT.test(last) && runInfo.prompt !== last && release.run === runInfo) {
        runInfo.prompt = last;
        runInfo.status = 'waiting';
        pushRelease();
        emit(null, 'release-ask', last, `The release needs your answer. ${last.replace(/\[y\/N\]/, 'yes or no')}`);
      }
    }, 500);
  };
  proc.stdout.on('data', onData);
  proc.stderr.on('data', onData);
  proc.on('close', (code) => {
    clearTimeout(idle);
    const ok = code === 0;
    runInfo.status = ok ? 'done' : 'failed';
    runInfo.prompt = null;
    runInfo.endedAt = Date.now();
    runInfo.code = code;
    if (forRelease) release.runs[kind] = { status: runInfo.status, dryRun: runInfo.dryRun, at: Date.now() };
    else release.adhoc = { kind, ref, version, status: runInfo.status, dryRun: runInfo.dryRun, at: Date.now() };
    try { fs.mkdirSync(path.join(DATA, 'release-logs'), { recursive: true }); fs.writeFileSync(path.join(DATA, 'release-logs', `${ref}-${kind}-${runInfo.startedAt}.log`), ansi(runInfo.out)); } catch {}
    saveRelease();
    pushRelease();
    const label = `${REL().runner} release:${kind}${runInfo.dryRun ? ' (dry run)' : ''} on ${ref}`;
    emit(null, ok ? 'release-done' : 'release-fail', `${label} (${version}) ${ok ? 'finished' : `failed (exit ${code})`}`,
      `Release ${kind === 'ota' ? 'O T A' : 'native'} for ${version} ${ok ? 'finished' : 'failed'}.`);
    // The script publishes a GitHub release; give it a moment, then record which tasks it carried.
    if (ok && !runInfo.dryRun) setTimeout(() => matchReleases(true).catch(() => {}), 20000);
  });
}

function releaseInput(text, key) {
  const r = release.run;
  if (!r?.proc || !['running', 'waiting'].includes(r.status)) throw new Error('No release script is running.');
  r.proc.stdin.write(key === 'ctrl-c' ? '\x03' : `${String(text ?? '')}\n`);
  r.prompt = null;
  r.status = 'running';
  pushRelease();
}

// ---------- drive a simulator or emulator from the live screen ----------
// The phone sends taps as fractions of the screen; Android takes pixels, iOS simulators take points
// (through agent-device).

const adSessions = new Map(); // simulator udid -> agent-device session opening
async function deviceInput(id, body) {
  const dev = (await listDevices()).booted.find((d) => d.id === id);
  if (!dev || dev.kind === 'ios-device') throw new Error('Only running simulators and emulators can be driven from here.');
  if (!devSize.get(id)) await screenshot(dev);
  const size = devSize.get(id);
  if (!size) throw new Error('Could not read the screen size.');
  const n = (v) => Math.min(1, Math.max(0, Number(v) || 0));
  let r;
  if (dev.kind.startsWith('android')) {
    const px = (fx, fy) => [String(Math.round(n(fx) * size.w)), String(Math.round(n(fy) * size.h))];
    const sh = (...a) => run('adb', ['-s', id, 'shell', 'input', ...a], { timeout: 20000 });
    if (body.type === 'tap') r = await sh('tap', ...px(body.x, body.y));
    else if (body.type === 'swipe') r = await sh('swipe', ...px(body.x, body.y), ...px(body.x2, body.y2), '300');
    else if (body.type === 'home') r = await sh('keyevent', 'KEYCODE_HOME');
    else if (body.type === 'back') r = await sh('keyevent', 'KEYCODE_BACK');
    else if (body.type === 'text') r = await sh('text', String(body.text || '').replace(/ /g, '%s'));
  } else {
    const scale = /iPad|SE|XR|iPhone 11$/.test(dev.name) ? 2 : 3;
    const pt = (fx, fy) => [String(Math.round((n(fx) * size.w) / scale)), String(Math.round((n(fy) * size.h) / scale))];
    // agent-device acts inside a session; open one per simulator (no app needed), and retry once while
    // its runner warms up on first use.
    const target = ['--platform', 'ios', '--udid', id, '--session', `workfloor-${id.slice(0, 8)}`];
    if (!adSessions.has(id)) adSessions.set(id, run('agent-device', ['open', ...target], { timeout: 180000 }));
    const opened = await adSessions.get(id);
    if (opened.code !== 0) {
      adSessions.delete(id);
      const why = (opened.stderr || opened.stdout).split('\n').find((l) => /^Error/.test(l)) || '';
      throw new Error(`agent-device could not take this simulator${why ? `: ${why.replace(/^Error\s*/, '')}` : ''}. A running sim test may be using it.`);
    }
    const ad = async (...a) => {
      const first = await run('agent-device', [...a, ...target], { timeout: 120000 });
      return first.code === 0 ? first : run('agent-device', [...a, ...target], { timeout: 120000 });
    };
    if (body.type === 'tap') r = await ad('press', ...pt(body.x, body.y));
    else if (body.type === 'swipe') r = await ad('swipe', ...pt(body.x, body.y), ...pt(body.x2, body.y2));
    else if (body.type === 'home') r = await ad('home');
    else if (body.type === 'back') r = await ad('back');
    else if (body.type === 'text') r = await ad('type', String(body.text || ''));
  }
  if (!r) throw new Error('Unknown input');
  shots.delete(id);
  if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim().split('\n').filter(Boolean).pop() || 'The input did not go through.');
}

// ---------- tunnel (reach the floor off Wi-Fi) ----------

let tunnel = { proc: null, url: null };
function toggleTunnel(on) {
  if (!on) {
    tunnel.proc?.kill();
    tunnel = { proc: null, url: null };
    return tunnel;
  }
  if (tunnel.proc) return tunnel;
  // A named tunnel (set up once with `cloudflared tunnel create`) keeps the same address; a quick tunnel gets a new one each time.
  const named = settings.tunnel.name;
  const args = named ? ['tunnel', '--no-autoupdate', 'run', named] : ['tunnel', '--no-autoupdate', '--url', `http://localhost:${PORT}`];
  const proc = spawn('cloudflared', args, { env: ENV });
  tunnel = { proc, url: named ? settings.tunnel.url || null : null };
  if (tunnel.url) broadcast({ type: 'tunnel', url: tunnel.url });
  const watch = (c) => {
    const m = String(c).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (m && !tunnel.url) { tunnel.url = m[0]; broadcast({ type: 'tunnel', url: tunnel.url }); }
  };
  proc.stdout.on('data', watch);
  proc.stderr.on('data', watch);
  proc.on('close', () => { if (tunnel.proc === proc) { tunnel = { proc: null, url: null }; broadcast({ type: 'tunnel', url: null }); } });
  return tunnel;
}

// ---------- HTTP ----------

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.md': 'text/markdown; charset=utf-8', '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webmanifest': 'application/manifest+json' };

const isLocal = (req) => {
  const a = req.socket.remoteAddress || '';
  const viaTunnel = !!req.headers['cf-connecting-ip'];
  return !viaTunnel && (a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1');
};
const cookieToken = (req) => (req.headers.cookie || '').split(/;\s*/).map((c) => c.split('=')).find(([k]) => k === 'wf')?.[1];
const authed = (req) => isLocal(req) || cookieToken(req) === secret.token || req.headers['x-workfloor-token'] === secret.token;

const sendJson = (res, code, body) => {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
};
const readBody = (req) => new Promise((resolve) => {
  let s = '';
  req.on('data', (c) => { s += c; if (s.length > 1e6) req.destroy(); });
  req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}); } catch { resolve({}); } });
});

// ---------- setup: first-run wizard (tools, Notion, repos, your name) ----------
// Everything a new Mac needs. `cmd` proves a tool is there, `install` runs here with live output,
// `terminal` opens Terminal for anything interactive (Homebrew's installer, sign-ins).
const TOOLS = [
  { id: 'git', label: 'Git', need: 'required', cmd: 'git --version', terminal: 'xcode-select --install', why: 'A worktree and branch for every task.' },
  { id: 'brew', label: 'Homebrew', need: 'recommended', cmd: 'brew --version', terminal: '/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"', why: 'Lets Workfloor install the rest for you.' },
  { id: 'npm', label: 'Node.js and npm', need: 'recommended', cmd: 'npm --version', install: 'brew install node', why: 'Installs the Expo, agent-device and Yarn tools below.' },
  { id: 'claude', label: 'Claude Code', need: 'required', cmd: 'claude --version', install: 'curl -fsSL https://claude.ai/install.sh | bash', why: 'The agent at every desk.',
    auth: { check: 'claude auth status', ok: (out) => /"loggedIn":\s*true/.test(out), label: 'Sign in', terminal: 'claude auth login' } },
  { id: 'gh', label: 'GitHub CLI', need: 'required', cmd: 'gh --version', install: 'brew install gh', why: 'Pull requests, CI and releases.',
    auth: { check: 'gh auth status', label: 'Sign in', terminal: 'gh auth login' } },
  { id: 'xcode', label: 'Xcode and the iOS Simulator', need: 'mobile', cmd: 'xcrun simctl help >/dev/null && xcodebuild -version | head -1', terminal: 'open "macappstore://apps.apple.com/app/xcode/id497799835"', why: 'Simulator tests for iOS apps.' },
  { id: 'pod', label: 'CocoaPods', need: 'mobile', cmd: 'pod --version', install: 'brew install cocoapods', why: 'Native iOS dependencies.' },
  { id: 'watchman', label: 'Watchman', need: 'mobile', cmd: 'watchman --version', install: 'brew install watchman', why: 'Fast file watching for Metro.' },
  { id: 'eas', label: 'EAS CLI (Expo)', need: 'mobile', cmd: 'eas --version', install: 'npm install -g eas-cli', why: 'Expo builds, store submits and OTA updates.' },
  { id: 'agent-device', label: 'agent-device', need: 'mobile', cmd: 'agent-device --version', install: 'npm install -g agent-device', why: 'Lets agents tap through the app on a simulator.' },
  { id: 'yarn', label: 'Yarn', need: 'optional', cmd: 'yarn --version', install: 'npm install -g yarn', why: 'For repos that use Yarn.' },
  { id: 'bun', label: 'Bun', need: 'optional', cmd: 'bun --version', install: 'brew install oven-sh/bun/bun', why: 'For repos that use Bun.' },
  { id: 'adb', label: 'Android platform tools', need: 'optional', cmd: 'adb --version | head -1', install: 'brew install --cask android-platform-tools', why: 'Android emulators and phones in the device lab.' },
  { id: 'cloudflared', label: 'cloudflared', need: 'optional', cmd: 'cloudflared --version', install: 'brew install cloudflared', why: 'Reach Workfloor from your phone outside your Wi-Fi.' },
];

const shell = (cmd, timeout = 20000) => run('bash', ['-lc', cmd], { timeout });
async function checkTools() {
  const node = { id: 'node', label: 'Workfloor runtime', need: 'required', ok: true, version: `Node ${process.version}, built in`, why: 'Comes with the app.' };
  const rows = await Promise.all(TOOLS.map(async ({ install, terminal, auth, cmd, ...t }) => {
    const r = await shell(cmd);
    const row = { ...t, ok: r.code === 0, version: (r.stdout || r.stderr).trim().split('\n')[0].slice(0, 80), canInstall: !!install, canTerminal: !!terminal };
    if (row.ok && auth) {
      const a = await shell(auth.check);
      row.signedIn = auth.ok ? auth.ok(a.stdout + a.stderr) : a.code === 0;
      row.authLabel = auth.label;
    }
    if (!row.ok) row.version = '';
    return row;
  }));
  return [node, ...rows];
}

let setupJob = null; // { id, out, status }
function installTool(id) {
  const tool = TOOLS.find((t) => t.id === id);
  if (!tool?.install) throw new Error('Nothing to install for that.');
  if (setupJob?.status === 'running') throw new Error(`Still installing ${setupJob.id}.`);
  setupJob = { id, out: `$ ${tool.install}\n`, status: 'running' };
  const p = spawn('bash', ['-lc', tool.install], { env: { ...ENV, HOMEBREW_NO_AUTO_UPDATE: '1', NONINTERACTIVE: '1' } });
  const add = (c) => { setupJob.out = (setupJob.out + c).slice(-20000); broadcast({ type: 'setup-job', job: setupJob }); };
  p.stdout.on('data', add);
  p.stderr.on('data', add);
  p.on('close', (code) => { setupJob.status = code === 0 ? 'done' : 'failed'; add(code === 0 ? '\n✓ Installed\n' : `\n✗ Exit ${code}\n`); });
}
function openTerminal(cmd) {
  const script = `tell application "Terminal"\n activate\n do script ${JSON.stringify(cmd)}\nend tell`;
  spawn('osascript', ['-e', script], { detached: true, stdio: 'ignore' }).unref();
}
// Sign-ins and installers that ask questions run in Terminal, where you can answer them.
function toolTerminal(id, step) {
  const tool = TOOLS.find((t) => t.id === id);
  const cmd = step === 'auth' ? tool?.auth?.terminal : tool?.terminal;
  if (!cmd) throw new Error('Nothing to run for that.');
  openTerminal(cmd);
}

// Notion: an integration token is fastest; without one, Claude's own Notion connector answers.
const secretsFile = path.join(DATA, 'secrets.json');
const secrets = readJson(secretsFile, {});
if (secrets.notionToken && !process.env.NOTION_API_TOKEN) process.env.NOTION_API_TOKEN = secrets.notionToken;
const notionApi = async (pathname, body, method) => {
  const res = await fetch(`https://api.notion.com/v1/${pathname}`, {
    method: method || (body ? 'POST' : 'GET'),
    headers: { Authorization: `Bearer ${process.env.NOTION_API_TOKEN}`, 'Notion-Version': '2025-09-03', 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || `Notion API ${res.status}`);
  return data;
};
async function saveNotionToken(token) {
  const prev = process.env.NOTION_API_TOKEN;
  process.env.NOTION_API_TOKEN = String(token || '').trim();
  try {
    const me = await notionApi('users/me');
    secrets.notionToken = process.env.NOTION_API_TOKEN;
    fs.writeFileSync(secretsFile, JSON.stringify(secrets, null, 2), { mode: 0o600 });
    return { ok: true, bot: me.name || 'integration' };
  } catch (e) {
    process.env.NOTION_API_TOKEN = prev || '';
    throw new Error(`That token didn't work: ${e.message}`);
  }
}
// One Claude turn with only the Notion connector, answering in JSON.
async function connectorJson(prompt) {
  const r = await run('claude', ['-p', `${prompt}\nReply with ONLY the JSON, no prose and no code fence.`, '--output-format', 'json', '--model', 'sonnet',
    '--permission-mode', 'dontAsk', '--allowedTools', 'mcp__claude_ai_Notion'], { timeout: 240000, cwd: DATA });
  const out = JSON.parse(r.stdout || '{}');
  noteCost('setup', 'setup', out.total_cost_usd);
  const text = out.result || '';
  const start = text.search(/[[{]/);
  const end = Math.max(text.lastIndexOf(']'), text.lastIndexOf('}'));
  if (out.is_error || start < 0) throw new Error((text || r.stderr || 'Claude could not reach Notion. Is the Notion connector on in Claude?').trim().split('\n').pop());
  return JSON.parse(text.slice(start, end + 1));
}
async function notionDatabases() {
  if (process.env.NOTION_API_TOKEN) {
    const r = await notionApi('search', { filter: { property: 'object', value: 'data_source' }, page_size: 50 });
    return r.results.map((d) => ({ id: d.id, name: (d.title || []).map((x) => x.plain_text).join('') || 'Untitled' }));
  }
  return connectorJson('Use the Notion search tool to find databases in my workspace that hold tasks or tickets (search for words like tasks, tickets, backlog, sprint, issues). For each database, fetch it to get its data source id (the uuid in its collection:// url). Return up to 20 as [{"name": "...", "id": "<data source uuid>"}], task-like ones first.');
}
// Property list for the field mapping, plus who you are in that database.
async function notionSchema(id) {
  if (process.env.NOTION_API_TOKEN) {
    const ds = await notionApi(`data_sources/${id}`);
    const properties = Object.fromEntries(Object.entries(ds.properties).map(([name, p]) => [name, {
      type: p.type, options: (p[p.type]?.options || []).map((o) => o.name),
    }]));
    const people = new Map();
    const rows = await notionApi(`data_sources/${id}/query`, { page_size: 100 }).catch(() => ({ results: [] }));
    for (const page of rows.results) for (const p of Object.values(page.properties)) if (p.type === 'people') for (const u of p.people) if (u.name) people.set(u.id, u.name);
    return { properties, people: [...people].map(([uid, name]) => ({ id: uid, name })), me: null };
  }
  return connectorJson(`Fetch the Notion data source collection://${id} and call the get-self tool. Return {"properties": {"<property name>": {"type": "<one of title, rich_text, number, select, multi_select, status, date, people, unique_id, checkbox, url, relation, formula, other>", "options": ["<option names for select, multi_select or status>"]}}, "people": [], "me": {"id": "<my Notion user id>", "name": "<my name>"}}.`);
}
// First guess at which property is which; the wizard shows it so you can correct it.
function guessProps(properties) {
  const all = Object.entries(properties || {});
  const pick = (types, re) => (all.find(([n, p]) => types.includes(p.type) && re.test(n)) || all.find(([, p]) => types.includes(p.type)) || [''])[0];
  return {
    title: pick(['title'], /./), id: pick(['unique_id'], /./), status: pick(['status', 'select'], /status|state|stage/i),
    priority: pick(['select', 'status'], /prio/i), tags: pick(['multi_select'], /tag|label|area/i), due: pick(['date'], /due|deadline|date/i),
    assignee: pick(['people'], /assign|owner|who/i), testingType: '', complexity: '',
  };
}

async function detectRepo(input) {
  const dir = expand(String(input || '').trim());
  if (!dir || !fs.existsSync(dir)) throw new Error('No folder at that path.');
  const top = (await git(dir, 'rev-parse', '--show-toplevel')).stdout.trim();
  if (!top) throw new Error('That folder is not a git repository.');
  const remote = (await git(top, 'remote', 'get-url', 'origin')).stdout.trim();
  const gh = remote.match(/github\.com[:/]([^/]+)\/(.+?)(?:\.git)?$/);
  const head = (await git(top, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD')).stdout.trim();
  const pkg = readJson(path.join(top, 'package.json'), null);
  const has = (f) => fs.existsSync(path.join(top, f));
  const pm = has('bun.lockb') || has('bun.lock') ? 'bun' : has('yarn.lock') ? 'yarn' : has('pnpm-lock.yaml') ? 'pnpm' : 'npm';
  const x = { bun: 'bunx', yarn: 'yarn', pnpm: 'pnpm exec', npm: 'npx' }[pm];
  const deps = { ...pkg?.dependencies, ...pkg?.devDependencies };
  const checks = [];
  if (has('tsconfig.json')) checks.push({ name: 'Types', cmd: `${x} tsc --noEmit` });
  if (deps.eslint) checks.push({ name: 'Lint (changed files)', cmd: `${x} eslint {changed:ts,tsx,js,jsx}` });
  if (deps.jest || deps['jest-expo']) checks.push({ name: 'Unit tests (related)', cmd: `${x} jest --watchAll=false --passWithNoTests --findRelatedTests {changed:ts,tsx,js,jsx}` });
  else if (deps.vitest) checks.push({ name: 'Unit tests (related)', cmd: `${x} vitest related --run {changed:ts,tsx,js,jsx}` });
  else if (pkg?.scripts?.test) checks.push({ name: 'Unit tests', cmd: `${pm} run test` });
  return {
    path: top, key: gh?.[2] || path.basename(top), owner: gh?.[1] || '', base: head.replace(/^origin\//, '') || 'main', pm, checks,
    mobile: !!(deps.expo || deps['react-native']), release: !!(pkg?.scripts?.['release:native'] || pkg?.scripts?.['release:ota']),
  };
}

async function saveSetup(b) {
  const name = String(b.name || '').trim();
  if (!name) throw new Error('Tell Workfloor your name first.');
  const repos = (b.repos || []).filter((r) => r.path && r.key);
  if (!repos.length) throw new Error('Add at least one repo.');
  const slug = slugify(name.split(/\s+/)[0]);
  Object.assign(config, {
    name, me: config.me || slug, branchPrefix: b.branchPrefix || config.branchPrefix || slug, company: b.company ?? config.company ?? '',
    github: { owner: repos.find((r) => r.owner)?.owner || config.github?.owner || '' },
    repos: Object.fromEntries(repos.map((r) => [r.key, { path: r.path, base: r.base || 'main', checks: r.checks || [] }])),
  });
  if (b.notion) {
    const { props = {}, assignee, ...rest } = b.notion;
    config.notion = { ...config.notion, ...rest, assigneeProp: assignee ?? config.notion.assigneeProp, props: { ...config.notion.props, ...props } };
  }
  const mobile = repos.filter((r) => r.mobile).map((r) => r.key);
  for (const s of config.workflow) if (s.id === 'simtest') s.repos = mobile;
  const rel = repos.find((r) => r.release);
  config.release = rel ? { ...(config.release || {}), repo: rel.key } : { repo: null };
  config.onboarded = true;
  saveConfig();
  if (b.manager !== undefined) { settings.daily.manager = String(b.manager).trim(); writeJson(settingsFile, settings); }
  syncTasks();
}

function snapshot() {
  const hide = new Set(config.notion.hideStatuses || []);
  const shipIdx = shippedIndex();
  return {
    company: config.company, me: config.me,
    workflow: [...config.workflow.map(({ prompt, agentPrompt, ...s }) => s), ...(config.workflow.some((s) => s.id === 'ship') ? [] : [SHIP_STEP])],
    repos: Object.fromEntries(Object.entries(config.repos).map(([k, r]) => [k, { base: r.base, checks: r.checks.map((c) => c.name) }])),
    permissionMode: config.agent.permissionMode,
    notion: { source: notion.source, syncedAt: notion.syncedAt, syncing, hasToken: !!process.env.NOTION_API_TOKEN },
    tasks: notion.tasks.filter((t) => !hide.has(t.Status) || awaitingRelease(taskId(t), shipIdx)).map((t) => ({
      id: taskId(t), num: t.TASK, title: t['Task Name'], status: t.Status, stage: stageOf(t.Status), priority: t.Priority,
      tags: t.Tags || [], complexity: t.Complexity, testingType: t['Testing Type'], due: t.due, url: t.url, created: t.createdTime, hidden: hidden.has(taskId(t)),
      shipped: (shipIdx[taskId(t)] || []).map(({ version, env, kind, at, url }) => ({ version, env, kind, at, url })),
      awaitingRelease: awaitingRelease(taskId(t), shipIdx),
      work: publicWork(taskId(t)),
    })),
    tunnel: tunnel.url,
    usage: usageSummary(),
    storage: storageSummary(),
    settings,
    star: timesheet().star,
    release: publicRelease(),
    onboarded: config.onboarded !== false, name: config.name || '', releaseEnabled: !!releaseRepoName(), notionCheckin: !!config.notion.checkin?.prop,
    recent: eventsSince(Date.now() - 36 * 3600e3).slice(-14).reverse(),
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  // One-tap actions from push notifications: the signed token is the permission, for that action only.
  if (url.pathname.startsWith('/act/')) {
    const p = verifyAct(url.pathname.slice(5));
    if (!p) return sendJson(res, 403, { error: 'This button expired or was already used.' });
    try { await runAct(p); return sendJson(res, 200, { ok: true }); } catch (e) { return sendJson(res, 400, { error: e.message }); }
  }

  // Pairing link from the QR code: ?k=<token> sets a long-lived cookie, then drops the token from the URL.
  if (url.searchParams.get('k')) {
    if (url.searchParams.get('k') === secret.token) {
      res.writeHead(302, { 'Set-Cookie': `wf=${secret.token}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax`, Location: '/' });
      return res.end();
    }
  }

  const isApi = url.pathname.startsWith('/api/');
  if (!authed(req)) {
    if (isApi) return sendJson(res, 401, { error: 'Scan the QR code on your Mac to pair this device.' });
    if (url.pathname === '/' || url.pathname === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(fs.readFileSync(path.join(ROOT, 'public', 'locked.html')));
    }
  }

  try {
    if (isApi) return await api(req, res, url);
  } catch (e) {
    return sendJson(res, 400, { error: e.message });
  }

  let file = path.normalize(path.join(ROOT, 'public', url.pathname === '/' ? 'index.html' : url.pathname));
  if (!file.startsWith(path.join(ROOT, 'public')) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(ROOT, 'public', 'index.html');
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  fs.createReadStream(file).pipe(res);
});

async function api(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean).slice(1); // drop "api"
  const method = req.method;

  if (parts[0] === 'events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write('retry: 2000\n\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }
  if (parts[0] === 'state') return sendJson(res, 200, { ...snapshot(), local: isLocal(req) });
  if (parts[0] === 'settings') {
    if (method === 'POST' && parts[1] === 'push-test') { await pushAlert({ kind: 'done', id: null, text: 'Test from Workfloor: notifications work.' }, true); return sendJson(res, 200, { ok: true }); }
    if (method === 'POST' && parts[1] === 'say') { say(String((await readBody(req)).text || '').slice(0, 2000), true); return sendJson(res, 200, { ok: true }); }
    if (method === 'POST') updateSettings(await readBody(req));
    return sendJson(res, 200, settings);
  }
  if (parts[0] === 'standup') return sendJson(res, 200, standup());
  if (parts[0] === 'release') {
    const b = method === 'POST' ? await readBody(req) : {};
    if (method === 'GET' && parts[1] === 'log') return sendJson(res, 200, { out: release.run?.out || '' });
    if (method === 'GET') return sendJson(res, 200, await releaseInfo(url.searchParams.has('fresh')));
    if (parts[1] === 'rc') await createRc(String(b.version || '').trim());
    else if (parts[1] === 'bump') await bumpPr(!!b.alsoMain);
    else if (parts[1] === 'prs') await refreshBumps();
    else if (parts[1] === 'merge') await mergeBump(b.number);
    else if (parts[1] === 'run') await releaseRun(b.kind, b);
    else if (parts[1] === 'input') releaseInput(b.text, b.key);
    else if (parts[1] === 'stop') { release.run?.proc?.kill('SIGINT'); }
    else if (parts[1] === 'new') { if (['running', 'waiting'].includes(release.run?.status)) throw new Error('Stop the running script first.'); release = {}; saveRelease(); pushRelease(); }
    else return sendJson(res, 404, { error: 'Not found' });
    return sendJson(res, 200, publicRelease());
  }
  if (parts[0] === 'daily') {
    if (parts[1] === 'checkout' && method === 'GET') return sendJson(res, 200, { draft: checkoutDraft(await checkoutContext()), discord: !!settings.daily.discordWebhook, manager: settings.daily.manager });
    if (parts[1] === 'checkout' && method === 'POST') return sendJson(res, 200, { text: await checkoutWrite((await readBody(req)).text) });
    if (parts[1] === 'discord' && method === 'POST') { await postDiscord((await readBody(req)).text); return sendJson(res, 200, { ok: true }); }
  }
  if (parts[0] === 'notion') {
    if (parts[1] === 'options') return sendJson(res, 200, notionOptions());
    if (parts[1] === 'topics') return sendJson(res, 200, { topics: await checkinTopics(url.searchParams.has('fresh')) });
    if (parts[1] === 'tasks' && method === 'POST') return sendJson(res, 200, await createNotionTask(await readBody(req)));
  }
  if (parts[0] === 'approvals' && method === 'POST') {
    if (!parts[1]) {
      if (!isLocal(req)) return sendJson(res, 403, { error: 'Only agents on this Mac ask for approval.' });
      const b = await readBody(req);
      return requestApproval(b.task, b.tool, b.input || {}, res);
    }
    const b = await readBody(req);
    answerApproval(parts[1], !!b.allow, b.note, b.always);
    return sendJson(res, 200, { ok: true });
  }
  if (parts[0] === 'sync' && method === 'POST') { syncTasks(); return sendJson(res, 202, { ok: true }); }
  if (parts[0] === 'usage') {
    // Fresh enough unless asked; a forced check still waits 20s between probes.
    const age = Date.now() - (usage.limits?.at || 0);
    if (method === 'POST' && (age > 10 * 60e3 || ((await readBody(req)).force && age > 20e3))) probeLimits();
    return sendJson(res, 200, usageSummary());
  }
  if (parts[0] === 'storage') {
    if (method === 'POST' && parts[1] === 'scan') { scanStorage(); return sendJson(res, 202, storageSummary()); }
    if (method === 'POST' && parts[1] === 'clean') { await cleanStorage((await readBody(req)).ids || []); return sendJson(res, 202, storageSummary()); }
    return sendJson(res, 200, storageSummary());
  }
  if (parts[0] === 'devices') {
    if (!parts[1]) return sendJson(res, 200, await listDevices());
    if (parts[2] === 'shutdown' && method === 'POST') { await shutdownDevice(parts[1]); return sendJson(res, 200, await listDevices()); }
    if (parts[2] === 'delete' && method === 'POST') { await deleteSimulator(parts[1]); return sendJson(res, 200, await listDevices()); }
    if (parts[2] === 'input' && method === 'POST') { await deviceInput(parts[1], await readBody(req)); return sendJson(res, 200, { ok: true }); }
    if (parts[2] === 'boot' && method === 'POST') { await bootSimulator(parts[1]); return sendJson(res, 200, await listDevices()); }
    if (parts[2] === 'screen') {
      const dev = (await listDevices()).booted.find((d) => d.id === parts[1]);
      const buf = dev && await screenshot(dev);
      if (!buf) return sendJson(res, 404, { error: 'No screen for that device' });
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store' });
      return res.end(buf);
    }
  }
  if (parts[0] === 'connect') {
    const addrs = lanAddresses();
    return sendJson(res, 200, {
      lan: addrs.map((a) => `http://${a}:${PORT}/?k=${secret.token}`),
      tunnel: tunnel.url ? `${tunnel.url}/?k=${secret.token}` : null,
      local: isLocal(req),
    });
  }
  if (parts[0] === 'tunnel' && method === 'POST') {
    if (!isLocal(req)) throw new Error('Turn the tunnel on or off from the Mac.');
    const body = await readBody(req);
    toggleTunnel(!!body.on);
    return sendJson(res, 200, { url: tunnel.url, starting: !!tunnel.proc && !tunnel.url });
  }

  if (parts[0] === 'setup') {
    try {
      if (method === 'GET' && parts[1] === 'status') {
        return sendJson(res, 200, {
          onboarded: config.onboarded !== false, name: config.name || '', manager: settings.daily.manager || '',
          notion: { ...config.notion, hasToken: !!process.env.NOTION_API_TOKEN }, repos: config.repos, job: setupJob,
        });
      }
      if (method === 'GET' && parts[1] === 'tools') return sendJson(res, 200, { tools: await checkTools(), job: setupJob });
      if (method === 'GET' && parts[1] === 'databases') return sendJson(res, 200, { databases: await notionDatabases() });
      if (method === 'GET' && parts[1] === 'schema') {
        const schema = await notionSchema(url.searchParams.get('id'));
        return sendJson(res, 200, { ...schema, guess: guessProps(schema.properties) });
      }
      if (method === 'GET' && parts[1] === 'repo') return sendJson(res, 200, await detectRepo(url.searchParams.get('path')));
      const b = method === 'POST' ? await readBody(req) : {};
      if (method === 'POST' && parts[1] === 'install') { installTool(b.id); return sendJson(res, 200, { job: setupJob }); }
      if (method === 'POST' && parts[1] === 'terminal') { toolTerminal(b.id, b.step); return sendJson(res, 200, { ok: true }); }
      if (method === 'POST' && parts[1] === 'notion-token') return sendJson(res, 200, await saveNotionToken(b.token));
      if (method === 'POST' && parts[1] === 'save') { await saveSetup(b); broadcast({ type: 'reload' }); return sendJson(res, 200, { ok: true }); }
      if (method === 'POST' && parts[1] === 'name') {
        config.name = String(b.name || '').trim().slice(0, 60);
        saveConfig();
        broadcast({ type: 'reload' });
        return sendJson(res, 200, { ok: true });
      }
      if (method === 'POST' && parts[1] === 'reset') { config.onboarded = false; saveConfig(); broadcast({ type: 'reload' }); return sendJson(res, 200, { ok: true }); }
    } catch (e) { return sendJson(res, 400, { error: e.message }); }
    return sendJson(res, 404, { error: 'Not found' });
  }
  if (parts[0] === 'tasks' && parts[1]) {
    const id = parts[1];
    if (!findTask(id)) return sendJson(res, 404, { error: 'No such task' });
    const action = parts[2];
    if (method === 'GET' && action === 'log') return sendJson(res, 200, { log: readLog(id) });
    if (method === 'GET' && action === 'diff') return sendJson(res, 200, await branchDiff(id));
    if (method === 'GET' && action === 'brief') {
      try { return sendJson(res, 200, await taskBrief(id, url.searchParams.has('fresh'))); } catch (e) { return sendJson(res, 502, { error: e.message }); }
    }
    if (method === 'POST' && action === 'clockout') {
      try { await clockOut(id, await readBody(req)); } catch (e) { return sendJson(res, e.status || 400, { error: e.message, dirty: e.status === 409 }); }
      return sendJson(res, 200, { ok: true });
    }
    if (method === 'GET' && action === 'reports') return sendFile(req, res, path.join(REPORTS, id, path.basename(parts[3] || ''), path.basename(decodeURIComponent(parts[4] || 'report.md'))));
    const body = method === 'POST' ? await readBody(req) : {};
    if (action === 'step') { await runStep(id, parts[3], body); return sendJson(res, 200, { work: publicWork(id) }); }
    if (action === 'message') {
      if (!body.text?.trim()) throw new Error('Empty message');
      startAgent(id, body.text.trim(), null);
      return sendJson(res, 200, { work: publicWork(id) });
    }
    if (action === 'stop') { stopAgent(id); W(id).checksRunning = false; return sendJson(res, 200, { ok: true }); }
    if (action === 'mode') { W(id).mode = body.mode; save(); pushTask(id); return sendJson(res, 200, { ok: true }); }
    if (action === 'model') { W(id).model = MODELS.includes(body.model) ? body.model : undefined; save(); pushTask(id); return sendJson(res, 200, { ok: true }); }
    if (action === 'gauge') return sendJson(res, 200, await gaugeTask(id));
    if (action === 'pr') { const pr = await refreshPr(id); return sendJson(res, 200, { pr }); }
    if (action === 'open') { openOnMac(id, body.what); return sendJson(res, 200, { ok: true }); }
    if (method === 'POST' && action === 'notes') { await saveNotes(id, body.text, body.notion); return sendJson(res, 200, { ok: true }); }
    if (method === 'POST' && action === 'merge') return sendJson(res, 200, { pr: await mergePrs(id, body.number) });
    if (method === 'POST' && action === 'finish') {
      try { await finishTask(id, { force: body.force, notionStatus: body.notionStatus ?? doneStatus() }); } catch (e) { return sendJson(res, e.status || 400, { error: e.message, dirty: e.status === 409 }); }
      return sendJson(res, 200, { ok: true });
    }
    if (method === 'POST' && action === 'hide') {
      if (body.hide === false) hidden.delete(id); else hidden.add(id);
      writeJson(hiddenFile, [...hidden]);
      broadcast({ type: 'reload' });
      return sendJson(res, 200, { ok: true });
    }
    if (action === 'reset') { stopAgent(id); W(id).sessionId = null; W(id).agent = { status: 'idle', queue: [] }; appendLog(id, { t: 'sys', text: 'New conversation' }); save(); pushTask(id); return sendJson(res, 200, { ok: true }); }
  }
  return sendJson(res, 404, { error: 'Not found' });
}

server.listen(PORT, '0.0.0.0', async () => {
  const lan = lanAddresses()[0];
  console.log(`\n  Workfloor is open\n  Desk:  http://localhost:${PORT}\n  Phone: http://${lan || '<your-ip>'}:${PORT}/?k=${secret.token}\n`);
  await discover().catch(() => {});
  broadcast({ type: 'reload' });
  scanStorage();
  syncIfStale();
  setTimeout(() => matchReleases().catch(() => {}), 15000);
  if (settings.tunnel.atStart) toggleTunnel(true);
});
server.requestTimeout = 0; // approvals hold a request open until you answer

process.on('SIGINT', () => { tunnel.proc?.kill(); for (const w of Object.values(work)) w.proc?.kill('SIGINT'); writeJson(stateFile, work); process.exit(0); });
