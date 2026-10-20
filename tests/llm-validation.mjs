import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'coldmail-llm-')), 'test.db');
process.env.LLM_API_KEY = 'test-only';
const isolated = new DatabaseSync(process.env.DB_PATH);
isolated.exec(readFileSync(new URL('../src/db/schema.sql', import.meta.url), 'utf8'));
isolated.prepare(`INSERT INTO accounts (email,display_name,provider,smtp_host,smtp_port,smtp_user,smtp_pass,imap_host,warmup_started_at,created_at)
 VALUES ('test@example.invalid','Test','other','example.invalid',587,'test','unused','example.invalid','2026-01-01','2026-01-01')`).run();
isolated.close();
const { lintEmail } = await import('../src/outreach/templates.ts');
const { validateWarmupText, newWarmupEmail } = await import('../src/llm/warmupPrompts.ts');
const { generateAdaptiveCopy, classifyLeadReply } = await import('../src/llm/copyGenerator.ts');
const { chatJson } = await import('../src/llm/client.ts');
const { seedSequences, DEFAULT_SEQUENCES } = await import('../src/outreach/sequences.ts');
const { q, db } = await import('../src/db/index.ts');
const { config } = await import('../src/config.ts');
const lead = { id: 1, name: 'Padaria Pão Dourado', firm_name: 'Padaria Pão Dourado', practice_area: 'Padaria', city: 'Campinas', site_status: 'nenhum', contact_known: 0, variant: 'modelo_a', observed_fact: 'fila na porta de manhã e horário só no Instagram' };
const replyWith = (value) => { globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(value) } }] })); };
const optout = /(não escrevo mais|tiro seu contato da lista|responder "não"|responda "sair"|basta me avisar)/i;

test('cold lint rejects empty, nonstring, header injection and oversized copy', () => {
  for (const [subject, body] of [['',''], ['Assunto','  '], [42,'Olá.'], ['Assunto',42], ['Oi\r\nBcc: hidden','Corpo válido.'], ['Oi', 'palavra '.repeat(141)]]) {
    assert.ok(lintEmail(subject, body, 1), `${subject}: ${body}`);
  }
});
test('warmup validation rejects malformed schemas, empty bodies and fictional attachments', () => {
  for (const value of [null, [], {subject:42,body:'Recebi. Vou revisar hoje.'}, {subject:'Oi',body:'  '}, {subject:'Revisão',body:'Segue em anexo o relatório. Pode revisar?'}]) {
    assert.ok(validateWarmupText(value, true));
  }
});
test('warmup retries malformed object output and returns only a valid draft', async () => {
  let calls = 0;
  globalThis.fetch = async () => new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(++calls < 3 ? null : {subject:'Prioridades da semana',body:'Podemos alinhar as prioridades hoje? Vou confirmar o horário. Lucas'})}}]}));
  const draft = await newWarmupEmail({name:'Lucas'}, {name:'Carlos'});
  assert.equal(calls, 3);
  assert.equal(validateWarmupText(draft, true), null);
  replyWith(null);
  await assert.rejects(newWarmupEmail({name:'Lucas'}, {name:'Carlos'}), /texto inválido 3x/);
});
test('client retries malformed API envelopes without leaking a TypeError', async () => {
  let calls = 0;
  globalThis.fetch = async () => new Response(JSON.stringify(++calls === 1 ? {choices:[]} : {choices:[{message:{content:'```json\n{"ok":true}\n```'}}]}));
  assert.deepEqual(await chatJson([{role:'user',content:'test'}]), {ok:true});
  assert.equal(calls, 2);
});
test('adaptive copy never falls back to generic text; valid output always carries explicit optout', async () => {
  // respostas inválidas -> ok:false (lead vai para needs_review), nunca um template genérico
  for (const response of [null, {subject:42,body:42}, {subject:'inválido',body:'x'}, {subject:'oi\r\nBcc: x',body:'Texto qualquer com palavras suficientes aqui.'}]) {
    replyWith(response);
    for (const step of [1,2,3]) {
      const result = await generateAdaptiveCopy({ ...lead, id: 100 + step }, step, 'Lucas', { subject_template: 'x', body_template: 'y' });
      assert.equal(result.ok, false);
    }
  }
  // sem fato observado -> ok:false sem chamar a IA
  let called = false;
  globalThis.fetch = async () => { called = true; return new Response('{}'); };
  const noFact = await generateAdaptiveCopy({ ...lead, observed_fact: '' }, 1, 'Lucas', { subject_template: 'x', body_template: 'y' });
  assert.equal(noFact.ok, false); assert.equal(called, false);
  // resposta válida -> ok:true, opt-out explícito, lint ok
  replyWith({subject:'horário da padaria', body:'Oi, tudo bem?\n\nVi a fila na porta de manhã e que o horário só aparece no Instagram.\n\nFaço sites de uma página com fotos, horário, mapa e WhatsApp.\n\nPosso montar uma prévia e te mandar para você ver antes de decidir?'});
  for (const step of [1,2,3]) {
    db.exec('DELETE FROM generated_copies');
    const result = await generateAdaptiveCopy({ ...lead, id: 200 + step }, step, 'Lucas', { subject_template: 'x', body_template: 'y' });
    assert.equal(result.ok, true);
    assert.match(result.copy.body, optout);
    assert.equal(lintEmail(result.copy.subject, result.copy.body, step), null);
  }
  // mesma resposta de novo -> similaridade alta -> ok:false
  const dup = await generateAdaptiveCopy({ ...lead, id: 300 }, 3, 'Lucas', { subject_template: 'x', body_template: 'y' });
  assert.equal(dup.ok, false); assert.match(dup.reason, /similaridade/);
});
test('classifications reject unknown intent and wrong field types', async () => {
  for (const response of [{intent:'remove_all',reasoning:'x',suggestedReply:'x'}, {intent:'manda_video',reasoning:42,suggestedReply:'x'}, null]) {
    replyWith(response);
    assert.equal((await classifyLeadReply('Pode mandar', 'Carlos')).intent, 'outros');
  }
  replyWith({intent:'sem_interesse',reasoning:'Recusou',suggestedReply:'Obrigado, retirarei seu email.'});
  assert.equal((await classifyLeadReply('Não tenho interesse', 'Carlos')).intent, 'sem_interesse');
});
test('COPY_MODE=template renders the selected sequence step (nurture) even for step one', async () => {
  const template = {subject_template:'retomando nossa conversa',body_template:'{{greeting}}\n\nRetomando nossa conversa sobre o site. Ainda faz sentido?\n\nSe não fizer sentido, é só responder "não" que eu não escrevo mais.'};
  config.copyMode = 'template';
  try {
    const result = await generateAdaptiveCopy(lead, 1, 'Lucas', template);
    assert.equal(result.ok, true);
    assert.match(result.copy.subject, /retomando/);
    assert.match(result.copy.body, /Retomando nossa conversa/);
    assert.match(result.copy.body, optout);
  } finally { config.copyMode = 'ai'; }
});
test('seeding preserves customized existing steps on repeated startup', () => {
  seedSequences();
  const id = q.get("SELECT id FROM sequences WHERE name='site_main'").id;
  q.run("UPDATE sequence_steps SET subject_template='customizado',body_template='Texto personalizado.' WHERE sequence_id=? AND step_number=1", id);
  seedSequences();
  assert.equal(q.get('SELECT subject_template FROM sequence_steps WHERE sequence_id=? AND step_number=1',id).subject_template, 'customizado');
  for (const sequence of Object.values(DEFAULT_SEQUENCES)) for (const step of sequence.steps) assert.match(step.body,optout);
});
test.after(() => db.close());
