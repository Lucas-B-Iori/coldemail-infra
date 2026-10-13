import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import vm from 'node:vm';
import http from 'node:http';

const dir = mkdtempSync(join(tmpdir(), 'coldmail-dashboard-'));
process.env.DB_PATH = join(dir, 'test.db');
process.env.DASHBOARD_USERNAME = 'test-admin';
process.env.DASHBOARD_PASSWORD = 'test-password';
const setup = new DatabaseSync(process.env.DB_PATH);
setup.exec(readFileSync(new URL('../src/db/schema.sql', import.meta.url), 'utf8'));
const insert = setup.prepare(`INSERT INTO accounts (email, display_name, provider, smtp_host, smtp_port, smtp_user, smtp_pass, imap_host, warmup_started_at, status, pause_reason, cooldown_until, imap_last_poll_at, created_at) VALUES (?,?,'gmail','invalid.local',465,?,'TEST_SECRET','invalid.local',?,?,?,?,?,?)`);
for (const [i, status] of ['active', 'warming', 'paused', 'banned', 'active'].entries()) {
  insert.run(`test${i}@example.invalid`, '<img src=x onerror=alert(1)>', `test${i}@example.invalid`, new Date().toISOString(), status, status === 'paused' ? 'manual pause' : null, i === 4 ? '2999-01-01T00:00:00Z' : null, '2026-10-13T10:00:00Z', new Date().toISOString());
}
setup.close();
const { startDashboard } = await import('../src/dashboard/server.ts');
const { db, q } = await import('../src/db/index.ts');
const server = startDashboard(0);
await new Promise(resolve => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const authorization = `Basic ${Buffer.from('test-admin:test-password').toString('base64')}`;
const request = (path, init = {}) => fetch(base + path, { ...init, headers: { authorization, ...init.headers } });
after(async () => { await new Promise(resolve => server.close(resolve)); db.close(); rmSync(dir, { recursive: true, force: true }); });

test('protects every data route and HTML while leaving health minimal', async () => {
  for (const path of ['/', '/api/stats', '/api/leads', '/api/inbox', '/api/logs', '/api/import', '/unknown']) {
    const res = await fetch(base + path);
    assert.equal(res.status, 401, path);
    assert.match(res.headers.get('www-authenticate'), /^Basic/);
    assert.equal(res.headers.get('access-control-allow-origin'), null);
  }
  assert.equal((await fetch(base + '/api/stats', { headers: { authorization: 'Basic !!!' } })).status, 401);
  assert.deepEqual(await (await fetch(base + '/healthz')).json(), { ok: true });
});

test('fails closed when either dashboard credential is missing', async () => {
  const password = process.env.DASHBOARD_PASSWORD;
  delete process.env.DASHBOARD_PASSWORD;
  try { assert.equal((await request('/api/stats')).status, 503); }
  finally { process.env.DASHBOARD_PASSWORD = password; }
});

test('reports effective statuses, reasons, polls, counts and no account credentials', async () => {
  const res = await request('/api/stats');
  assert.equal(res.status, 200);
  const stats = await res.json();
  assert.equal(stats.activeAccounts, 1);
  assert.equal(stats.operatingAccounts, 2);
  assert.deepEqual(stats.fleet.map(a => a.effectiveStatus), ['active','warming','paused','banned','cooldown']);
  assert.equal(stats.fleet[2].pauseReason, 'manual pause');
  assert.equal(stats.fleet[0].lastPollAt, '2026-10-13T10:00:00Z');
  assert.equal(stats.warmupInternalSentToday, 0);
  assert.equal(stats.warmupExternalSentToday, 0);
  assert.equal(JSON.stringify(stats).includes('TEST_SECRET'), false);
});

test('counts warm-up deliveries by same or different provider/domain and local business date', async () => {
  q.run("UPDATE accounts SET email='external@gmail.invalid', provider='m365' WHERE id=5");
  const today = new Date().toISOString();
  const thread = q.run(`INSERT INTO warmup_threads (initiator_id,peer_id,subject,max_turns,created_at,updated_at) VALUES (1,2,'test',3,?,?)`, today, today).id;
  for (const [id, to, sent] of [['internal',2,today], ['external',5,today], ['old',5,'2000-01-01T00:00:00Z']]) {
    q.run(`INSERT INTO warmup_messages (thread_id,message_id,from_account_id,to_account_id,subject,body,sent_at) VALUES (?,?,1,?,'test','test',?)`, thread, id, to, sent);
  }
  const stats = await (await request('/api/stats')).json();
  assert.equal(stats.warmupInternalSentToday, 1);
  assert.equal(stats.warmupExternalSentToday, 1);
});

test('uses completed healthy days for ramp progress and reports today health evidence', async () => {
  const { localDate } = await import('../src/lib/util.ts');
  q.run(`INSERT INTO warmup_daily_health(account_id,day,target,sent,external_reads,healthy) VALUES(1,'2000-01-01',3,3,1,1)`);
  q.run(`INSERT INTO warmup_daily_health(account_id,day,target,sent,external_reads,healthy) VALUES(1,?,3,3,1,1)`, localDate());
  const stats = await (await request('/api/stats')).json();
  assert.equal(stats.fleet[0].healthyDays, 1);
  assert.equal(stats.fleet[0].warmupDay, 2);
  assert.equal(stats.fleet[0].healthToday.external_reads, 1);
  assert.equal(stats.healthSummary.healthyToday, 1);
});

test('rejects cross-origin imports, oversized payloads and malformed JSON without changing leads', async () => {
  const before = q.get('SELECT COUNT(*) n FROM leads').n;
  assert.equal((await request('/api/import', { method: 'POST', headers: { origin: 'https://evil.invalid', 'content-type': 'application/json' }, body: '{}' })).status, 403);
  assert.equal((await request('/api/import', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ csvText: 'x'.repeat(1024 * 1024) }) })).status, 413);
  const malformed = await request('/api/import', { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: '{' });
  assert.equal(malformed.status, 400);
  assert.deepEqual(await malformed.json(), { ok: false, error: 'Invalid import payload' });
  assert.equal(q.get('SELECT COUNT(*) n FROM leads').n, before);
});

test('renders hostile data as escaped text and displays the actual account status', async () => {
  const html = await (await request('/')).text();
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const nodes = new Map();
  const document = { getElementById: id => { if (!nodes.has(id)) nodes.set(id, {}); return nodes.get(id); } };
  const context = vm.createContext({ document, fetch: async () => { throw new Error('disabled'); }, console: { error() {} }, setInterval() {} });
  vm.runInContext(script, context);
  const stats = await (await request('/api/stats')).json();
  context.fleetFixture = stats.fleet;
  vm.runInContext('renderFleetTable(fleetFixture)', context);
  const rendered = nodes.get('fleet-table-body').innerHTML;
  assert.equal(rendered.includes('<img'), false);
  assert.match(rendered, /&lt;img/);
  assert.match(rendered, /PAUSADA/);
  assert.match(rendered, /COOLDOWN/);
  assert.equal(html.includes('11 Caixas Operando'), false);
});

test('escapes hostile lead, reply, suggestion and log text in every view', async () => {
  const hostile = '<svg onload=alert(1)>"&';
  const now = new Date().toISOString();
  q.run(`INSERT INTO leads(name,email,firm_name,status,last_reply_snippet,notes,reply_intent,created_at,updated_at) VALUES(?,'hostile@example.invalid',?,'replied',?,?,?,?,?)`, hostile, hostile, hostile, hostile, hostile, now, now);
  q.run(`INSERT INTO bounces_and_logs(account_id,kind,event,detail,created_at) VALUES(1,'error',?,?,?)`, hostile, hostile, now);
  const script = (await (await request('/')).text()).match(/<script>([\s\S]*?)<\/script>/)[1];
  const nodes = new Map();
  const document = { getElementById: id => { if (!nodes.has(id)) nodes.set(id, {}); return nodes.get(id); } };
  const context = vm.createContext({ document, fetch: path => request(path), console: { error() {} }, setInterval() {} });
  vm.runInContext(script, context);
  await vm.runInContext('Promise.all([loadInbox(), loadLeads(), loadLogs()])', context);
  for (const id of ['inbox-cards-container', 'leads-table-body', 'logs-container']) {
    assert.equal(nodes.get(id).innerHTML.includes('<svg'), false, id);
    assert.match(nodes.get(id).innerHTML, /&lt;svg/, id);
  }
});

test('malformed request URLs get a safe error and the server stays available', async () => {
  const status = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: server.address().port, path: 'http://[', headers: { authorization } }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject); req.end();
  });
  assert.equal(status, 400);
  assert.equal((await request('/api/stats')).status, 200);
});
