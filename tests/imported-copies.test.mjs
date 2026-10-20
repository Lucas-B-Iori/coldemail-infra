import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'coldmail-copies-')), 'test.db');
process.env.SIGNATURE_BLOCK = 'Synapze | Sites';
const { q } = await import('../src/db/index.ts');
const { config } = await import('../src/config.ts');
const { importLeadCopies, importedCopyFor, ensureOptOut, hasOptOut } = await import('../src/outreach/importedCopies.ts');
const now = new Date().toISOString();
for (const e of ['a@x.com', 'b@x.com']) q.run(`INSERT INTO leads (name,email,list_name,created_at,updated_at) VALUES (?,?,'t',?,?)`, e, e, now, now);

test('imports exact copy, sets priority, reports duplicates and unmatched', () => {
  const r = importLeadCopies([
    { prioridade: '2', email: 'a@x.com', assunto: 'Assunto {a|b} exato', corpo: 'Oi, tudo bem? Texto do Davi com {chaves|literais} aqui.\n\nTopa conversar? Se não fizer sentido, é só me avisar.\n\nLucas\n[ASSINATURA]' },
    { prioridade: '1', email: 'b@x.com', assunto: 'Outro assunto', corpo: 'Oi, texto diferente sem opt-out nenhum aqui dentro.\n\nLucas\n[ASSINATURA]' },
    { prioridade: '3', email: 'b@x.com', assunto: 'dup', corpo: 'x y z w v u' },
    { prioridade: '4', email: 'zz@x.com', assunto: 'sem lead', corpo: 'Oi, texto para lead inexistente aqui.' },
  ]);
  assert.equal(r.imported, 2);
  assert.deepEqual(r.duplicates, ['b@x.com']);
  assert.deepEqual(r.unmatched, ['zz@x.com']);
  assert.equal(q.get("SELECT priority FROM leads WHERE email='b@x.com'").priority, 1);
});
test('rendered copy is exact (no spintax), signature replaced, optout added only when missing', () => {
  const a = importedCopyFor(q.get("SELECT id FROM leads WHERE email='a@x.com'").id, 1);
  assert.equal(a.ok, true);
  assert.equal(a.copy.subject, 'Assunto {a|b} exato');
  assert.match(a.copy.body, /\{chaves\|literais\}/);
  assert.match(a.copy.body, /Lucas\nSynapze \| Sites$/);
  assert.doesNotMatch(a.copy.body, /responda "sair"/);
  const b = importedCopyFor(q.get("SELECT id FROM leads WHERE email='b@x.com'").id, 1);
  assert.ok(hasOptOut(b.copy.body));
  assert.ok(b.copy.body.indexOf('sair') < b.copy.body.indexOf('Lucas'));
  assert.equal(ensureOptOut('Texto.\n\nSe preferir, é só me avisar.'), 'Texto.\n\nSe preferir, é só me avisar.');
});
test('refuses to enqueue without SIGNATURE_BLOCK and returns null for leads without imported copy', () => {
  const id = q.get("SELECT id FROM leads WHERE email='a@x.com'").id;
  const saved = config.signatureBlock;
  config.signatureBlock = '';
  try { assert.equal(importedCopyFor(id, 1).ok, false); } finally { config.signatureBlock = saved; }
  assert.equal(importedCopyFor(id, 2), null);
});
