#!/usr/bin/env node
// Permission prompt tool for the headless Claude Code runs Workfloor starts. Before an action that
// needs a yes, Claude calls mcp__workfloor__approve; this asks Workfloor, which asks you (phone or
// desk) and waits as long as it takes. Zero dependencies: MCP over stdio is one JSON-RPC message per line.

const http = require('node:http');

const BASE = process.env.WORKFLOOR_URL || 'http://127.0.0.1:4747';
const TASK = process.env.WORKFLOOR_TASK || '';
const TOOL = {
  name: 'approve',
  description: 'Ask the Workfloor user to allow or deny a tool call.',
  inputSchema: {
    type: 'object',
    properties: { tool_name: { type: 'string' }, input: { type: 'object' }, tool_use_id: { type: 'string' } },
    required: ['tool_name', 'input'],
  },
};

const send = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');

function ask(args) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ task: TASK, tool: args.tool_name, input: args.input || {} });
    const req = http.request(`${BASE}/api/approvals`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      let s = '';
      res.on('data', (c) => { s += c; });
      res.on('end', () => { try { resolve(JSON.parse(s)); } catch { resolve({ allow: false, message: 'Workfloor did not answer.' }); } });
    });
    req.on('error', () => resolve({ allow: false, message: 'Workfloor is not reachable, so this was not allowed.' }));
    req.end(body);
  });
}

async function handle(m) {
  if (m.method === 'initialize') {
    return send({ id: m.id, result: { protocolVersion: m.params?.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'workfloor', version: '1.0.0' } } });
  }
  if (m.method === 'tools/list') return send({ id: m.id, result: { tools: [TOOL] } });
  if (m.method === 'tools/call') {
    const args = m.params?.arguments || {};
    const r = await ask(args);
    const decision = r.allow ? { behavior: 'allow', updatedInput: args.input || {} } : { behavior: 'deny', message: r.message || 'Denied in Workfloor.' };
    return send({ id: m.id, result: { content: [{ type: 'text', text: JSON.stringify(decision) }] } });
  }
  if (m.method === 'ping') return send({ id: m.id, result: {} });
  if (m.id !== undefined) send({ id: m.id, error: { code: -32601, message: `Unknown method ${m.method}` } });
}

let buf = '';
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    handle(msg).catch((e) => msg.id !== undefined && send({ id: msg.id, error: { code: -32603, message: e.message } }));
  }
});
