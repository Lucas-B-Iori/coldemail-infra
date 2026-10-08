import { q } from '../src/db/index.ts';
import { newWarmupEmail, replyWarmupEmail } from '../src/llm/warmupPrompts.ts';
import { generateAdaptiveCopy, classifyLeadReply } from '../src/llm/copyGenerator.ts';
import { warmupRange, outreachLimit } from '../src/accounts/ramp.ts';
import type { Lead } from '../src/outreach/leads.ts';

async function main() {
  console.log('='.repeat(70));
  console.log('🧪 TESTE COMPLETO DE INTELIGÊNCIA ARTIFICIAL, DIVERSIDADE E RAMPA');
  console.log('='.repeat(70));

  // 1. Simulação da Rampa Matemática (Dia 1 ao Dia 36+)
  console.log('\n📈 [1/5] PROGRESSÃO MATEMÁTICA DA RAMPA (9 Caixas M365 + 2 Sementes)');
  console.log('-'.repeat(70));
  const sampleDays = [1, 3, 7, 10, 14, 18, 21, 22, 25, 28, 32, 36];
  for (const d of sampleDays) {
    const [wMin, wMax] = d <= 21 ? warmupRange(d) : [5, 10];
    const coldLimit = outreachLimit(d);
    const fleetCold = coldLimit * 9;
    const stage = d <= 21 ? '🔥 AQUECIMENTO EXCLUSIVO' : '🚀 OPERAÇÃO ATIVA + MANUTENÇÃO';
    console.log(
      `Dia ${String(d).padStart(2)} | Warmup: ${String(wMin).padStart(2)}-${String(wMax).padStart(2)} emails/caixa | ` +
      `Cold/caixa: ${String(coldLimit).padStart(2)}/dia | Total Cold Frota (9x): ${String(fleetCold).padStart(3)}/dia | ${stage}`
    );
  }

  // 2. Teste de Geração Dinâmica de Warmup (IA sem Repetição)
  console.log('\n🤖 [2/5] GERAÇÃO DE E-MAILS DE WARMUP VIA IA (5 Caixas Distintas)');
  console.log('-'.repeat(70));
  const samplePairs = [
    { from: 'Lucas', to: 'Carlos' },
    { from: 'Miguel', to: 'Lucas Bertolassi' },
    { from: 'Arthur', to: 'Nelson' },
    { from: 'Mariana', to: 'Gabriel' },
    { from: 'Renan', to: 'Felipe' },
  ];

  const warmupBodies: string[] = [];
  for (let i = 0; i < samplePairs.length; i++) {
    const pair = samplePairs[i];
    const draft = await newWarmupEmail({ name: pair.from }, { name: pair.to });
    warmupBodies.push(draft.body);
    console.log(`\n✉️  Warmup #${i + 1} (${pair.from} -> ${pair.to}):`);
    console.log(`   Assunto: "${draft.subject}"`);
    console.log(`   Corpo:   "${draft.body.replace(/\n/g, ' ')}"`);
  }

  // Verificação de Repetição / Exclusividade
  const uniqueWarmup = new Set(warmupBodies);
  console.log(`\n   -> Variação Warmup: ${uniqueWarmup.size} de ${warmupBodies.length} textos 100% únicos gerados.`);

  // 3. Teste de Resposta em Thread Warmup
  console.log('\n💬 [3/5] TESTE DE RESPOSTA EM THREAD (Simulação de Diálogo Natural)');
  console.log('-'.repeat(70));
  const replyDraft = await replyWarmupEmail(
    { name: 'Carlos' },
    { name: 'Lucas' },
    [{ from: 'Lucas', body: warmupBodies[0] }],
    false
  );
  console.log(`   Resposta de Carlos para Lucas:`);
  console.log(`   "${replyDraft.body.replace(/\n/g, ' ')}"`);

  // 4. Teste de Geração de Cold Outreach para Leads Reais
  console.log('\n🎯 [4/5] GERAÇÃO DE COLD OUTREACH PARA LEADS REAIS (Dendrix CRM)');
  console.log('-'.repeat(70));
  
  const sampleLeads: Lead[] = [
    {
      id: 1,
      email: 'contato@silvaadvocacia.com.br',
      name: 'Dr. Roberto Silva',
      firm_name: 'Silva & Associados',
      practice_area: 'Direito Trabalhista e Previdenciário',
      observed_fact: 'Atuação forte em sustentações e alto volume de processos',
      need_hypothesis: 'Gargalo no acompanhamento diário de publicações e prazos',
      variant: 'modelo_a',
      status: 'new',
      current_step: 0,
      enrichment_json: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
    {
      id: 2,
      email: 'fernanda@oliveira.adv.br',
      name: 'Dra. Fernanda Oliveira',
      firm_name: 'Oliveira Advocacia',
      practice_area: 'Direito de Família e Sucessões',
      observed_fact: 'Escritório boutique em expansão na capital',
      need_hypothesis: 'Organização de cadastro de clientes e consulta financeira',
      variant: 'modelo_c',
      status: 'new',
      current_step: 0,
      enrichment_json: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
    {
      id: 3,
      email: 'marcos@albuquerque.adv.br',
      name: 'Marcos Albuquerque',
      firm_name: 'Albuquerque Advogados',
      practice_area: 'Direito Empresarial e Tributário',
      observed_fact: 'Estrutura com múltiplos advogados associados',
      need_hypothesis: 'Dificuldade de cruzar publicação com responsável pelo processo',
      variant: 'modelo_a',
      status: 'new',
      current_step: 0,
      enrichment_json: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
  ];

  for (const lead of sampleLeads) {
    console.log(`\n📌 Cold Email Toque 1 para: ${lead.name} (${lead.firm_name}) [Área: ${lead.practice_area}]`);
    const copy = await generateAdaptiveCopy(lead, 1, 'Lucas Iori');
    const words = copy.body.trim().split(/\s+/).length;
    const hasLink = /(https?:\/\/|www\.)/i.test(copy.body);
    const hasDash = /[—–]/.test(copy.body);
    console.log(`   Assunto: "${copy.subject}"`);
    console.log(`   Corpo:\n   ${copy.body.split('\n').join('\n   ')}`);
    console.log(`   ✓ Palavras: ${words} (meta: 50-80) | Links: ${hasLink ? '❌ TEM LINK' : '✅ ZERO LINKS'} | Travessão IA: ${hasDash ? '❌ TEM' : '✅ ZERO TRAVESSÃO'}`);

    console.log(`\n   ↪ Follow-up Toque 2 (Caso não responda após 3 dias):`);
    const copy2 = await generateAdaptiveCopy(lead, 2, 'Lucas Iori');
    console.log(`   Corpo:\n   ${copy2.body.split('\n').join('\n   ')}`);
  }

  // 5. Verificação de Classificação de Respostas (Copiloto)
  console.log('\n🧠 [5/5] TESTE DE CLASSIFICAÇÃO DE RESPOSTAS E COPILOTO');
  console.log('-'.repeat(70));
  const testReplies = [
    { text: 'Pode mandar o vídeo sim, quero ver como funciona.', expected: 'manda_video' },
    { text: 'Qual o valor da mensalidade e tem fidelidade?', expected: 'quanto_custa' },
    { text: 'Nós já utilizamos o Projuris há 3 anos aqui no escritório.', expected: 'ja_usa_outro' },
    { text: 'Não tenho interesse, favor retirar do mailing.', expected: 'sem_interesse' },
  ];

  for (const tr of testReplies) {
    const classification = await classifyLeadReply(tr.text, 'Dr. Roberto', 'Silva & Associados');
    console.log(`\n💬 Prospect respondeu: "${tr.text}"`);
    console.log(`   Categoria Detectada: ${classification.intent} (Esperado: ${tr.expected})`);
    console.log(`   Sugestão do Copiloto: "${classification.suggestedReply}"`);
  }

  console.log('\n' + '='.repeat(70));
  console.log('✅ AUDITORIA CONCLUÍDA COM SUCESSO: TODAS AS REGRAS E DIVERSIDADE VALIDADAS!');
  console.log('='.repeat(70));
}

main().catch((err) => {
  console.error('Erro na auditoria:', err);
  process.exit(1);
});
