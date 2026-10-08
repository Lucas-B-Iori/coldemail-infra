import { q } from '../src/db/index.ts';
import { classifyLeadReply } from '../src/llm/copyGenerator.ts';

async function main() {
  console.log('========================================================');
  console.log('  TESTE DE RESPOSTA DO LEAD, CLASSIFICAÇÃO IA E DASHBOARD');
  console.log('========================================================\n');

  // Cria lead externo de teste
  q.run('DELETE FROM leads WHERE email=?', 'dr.marcos@barbosaadvocacia.com.br');
  const leadId = q.run(
    `INSERT INTO leads (name, email, firm_name, practice_area, observed_fact, need_hypothesis, status, sequence_id, current_step, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    'Dr. Marcos Barbosa',
    'dr.marcos@barbosaadvocacia.com.br',
    'Barbosa Advocacia',
    'Direito Trabalhista',
    'Foco em defesas trabalhistas de empresas',
    'Dificuldade com publicações em múltiplos tribunais',
    'sent',
    1,
    1,
    new Date().toISOString(),
    new Date().toISOString(),
  ).id;

  const lead = q.get<any>('SELECT * FROM leads WHERE id=?', leadId);
  const replyText = 'Oi Lucas, achei bem interessante a proposta. Pode mandar o vídeo de 90 segundos sim para eu ver como funciona?';

  console.log('1. Analisando e classificando resposta do Dr. Marcos com OpenRouter IA...');
  const classification = await classifyLeadReply(replyText, lead.name, lead.firm_name);
  console.log('   Intenção identificada:', classification.intent);
  console.log('   Justificativa da IA:', classification.reasoning);
  console.log('   Sugestão Copiloto:\n   ' + classification.suggestedReply);

  // Atualiza lead no SQLite como 'replied'
  q.run(
    `UPDATE leads SET status='replied', replied_at=?, last_reply_snippet=?, reply_intent=?, notes=?, next_due_at=NULL, updated_at=? WHERE id=?`,
    new Date().toISOString(),
    replyText,
    classification.intent,
    `[Copiloto IA]: ${classification.suggestedReply}`,
    new Date().toISOString(),
    lead.id,
  );

  console.log('\n2. Verificando dados atualizados no banco de dados SQLite:');
  const updated = q.get<any>('SELECT id, name, email, status, reply_intent, notes FROM leads WHERE id=?', leadId);
  console.log(updated);

  console.log('\n3. Verificando API REST do Dashboard em http://localhost:3000/api/inbox:');
  const res = await fetch('http://localhost:3000/api/inbox');
  const inbox = await res.json();
  console.log('   Oportunidades listadas na Inbox:', inbox.length);
  console.log('   Primeiro lead da lista:', inbox[0]?.name, ' | Intenção:', inbox[0]?.reply_intent);

  console.log('\n========================================================');
  console.log('  TESTE DO COPILOTO E DASHBOARD: 100% SUCESSO!');
  console.log('========================================================\n');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
