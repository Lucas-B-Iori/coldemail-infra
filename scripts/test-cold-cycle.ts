import { q } from '../src/db/index.ts';
import { getAccount } from '../src/accounts/accounts.ts';
import { generateAdaptiveCopy } from '../src/llm/copyGenerator.ts';
import { sendMail } from '../src/email/smtp.ts';
import { nowIso } from '../src/lib/util.ts';
import { pollAccount } from '../src/inbox/monitor.ts';

async function main() {
  console.log('========================================================');
  console.log('  TESTE COMPLETO: COLD EMAIL -> RESPOSTA -> IMAP & IA');
  console.log('========================================================\n');

  // 1. Limpa e recria o lead de teste
  q.run('DELETE FROM leads WHERE email=?', 'lucasbertolassiiori@gmail.com');
  const leadId = q.run(
    `INSERT INTO leads (name, email, firm_name, practice_area, observed_fact, need_hypothesis, status, sequence_id, current_step, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    'Dr. Lucas Bertolassi',
    'lucasbertolassiiori@gmail.com',
    'Bertolassi Advocacia',
    'Direito Trabalhista',
    'Foco em contencioso trabalhista com 3 advogados',
    'Acompanhamento de publicações e prazos do TRT',
    'pending',
    1,
    0,
    nowIso(),
    nowIso(),
  ).id;

  const lead = q.get<any>('SELECT * FROM leads WHERE id=?', leadId);
  const m365 = getAccount(1)!; // lucas@synapzeai.net
  const gmail = getAccount(10)!; // lucasbertolassiiori@gmail.com

  console.log('1. Gerando Cold Email Toque 1 com IA Adaptativa (OpenRouter)...');
  const copy = await generateAdaptiveCopy(lead, 1, 'Lucas Iori');
  console.log('   Assunto:', copy.subject);
  console.log('   Corpo:\n' + copy.body.split('\n').map(l => '     ' + l).join('\n'));

  console.log('\n2. Disparando Cold Email de lucas@synapzeai.net para lucasbertolassiiori@gmail.com...');
  const msgId = await sendMail(m365, {
    to: lead.email,
    subject: copy.subject,
    text: copy.body,
  });
  console.log('   Enviado com sucesso! Message-ID:', msgId);

  // Atualiza lead como enviado
  q.run(
    `UPDATE leads SET status='sent', current_step=1, assigned_account_id=?, thread_subject=?, last_message_id=?, last_contacted_at=?, updated_at=? WHERE id=?`,
    m365.id, copy.subject, msgId, nowIso(), nowIso(), lead.id,
  );
  q.run(
    `INSERT INTO outreach_queue (account_id, lead_id, step_number, subject, body, scheduled_for, sent_at, message_id, status, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    m365.id, lead.id, 1, copy.subject, copy.body, nowIso(), nowIso(), msgId, 'sent', nowIso(),
  );
  console.log('   Lead atualizado para status: sent (Passo 1)');

  console.log('\n3. Simulando a resposta do lead a partir do Gmail...');
  const replyText = 'Oi Lucas, achei bem interessante a proposta para o escritório. Pode mandar o vídeo de 90 segundos sim para eu dar uma olhada!';
  const replyMsgId = await sendMail(gmail, {
    to: m365.email,
    subject: 'Re: ' + copy.subject,
    text: replyText,
    inReplyTo: msgId,
    references: msgId,
  });
  console.log('   Resposta enviada do Gmail para o M365! Message-ID:', replyMsgId);

  console.log('\n4. Aguardando 7 segundos para a mensagem sincronizar no Exchange Online...');
  await new Promise((r) => setTimeout(r, 7000));

  console.log('\n5. Executando varredura IMAP na caixa lucas@synapzeai.net...');
  const pollRes = await pollAccount(m365);
  console.log(`   Resultado da varredura: ${pollRes.replies} resposta(s) processada(s)`);

  console.log('\n6. Conferindo estado final do Lead no banco de dados...');
  const updatedLead = q.get<any>('SELECT * FROM leads WHERE id=?', leadId);
  console.log('   Status:', updatedLead.status);
  console.log('   Intenção classificada pela IA:', updatedLead.reply_intent);
  console.log('   Trecho da resposta capturada:', updatedLead.last_reply_snippet);
  console.log('   Notas / Sugestão Copiloto:', updatedLead.notes);

  console.log('\n========================================================');
  console.log('  TESTE CONCLUÍDO COM SUCESSO ABSOLUTO!');
  console.log('========================================================\n');
}

main().catch((e) => {
  console.error('Erro no teste:', e);
  process.exit(1);
});
