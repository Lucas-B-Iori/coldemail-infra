import { chatJson, isRecord, nonEmptyString } from './client.ts';
import type { Lead } from '../outreach/leads.ts';
import { firstName, leadVars, lintEmail, renderTemplate } from '../outreach/templates.ts';
import { config } from '../config.ts';
import { maxSimilarity, normalizeCore, recordCopy } from './uniqueness.ts';
import { log } from '../lib/util.ts';

export interface GeneratedCopy {
  subject: string;
  body: string;
}

export interface ReplyClassification {
  intent:
    | 'manda_video'
    | 'quanto_custa'
    | 'vamos_marcar'
    | 'ja_usa_outro'
    | 'agora_nao'
    | 'sem_interesse'
    | 'outro_responsavel'
    | 'out_of_office'
    | 'outros';
  reasoning: string;
  suggestedReply: string;
}

export interface StepTemplate {
  subject_template: string;
  body_template: string;
}

export type CopyResult = { ok: true; copy: GeneratedCopy } | { ok: false; reason: string };

const OPT_OUTS = [
  'Se não fizer sentido, é só responder "não" que eu não escrevo mais.',
  'Se não for do seu interesse, responda "sair" e eu tiro seu contato da lista.',
  'Caso não queira receber mais mensagens minhas, é só responder "não".',
  'Se preferir não receber mais e-mails, responda "sair" e eu paro por aqui.',
];

const ANGLES_STEP1 = [
  'abra comentando algo concreto do fato observado e conecte com quem procura o negócio pelo celular',
  'abra com uma pergunta curta e específica sobre como os clientes encontram o negócio hoje, baseada no fato observado',
  'abra elogiando com sobriedade um detalhe real do fato observado (sem exagero) e siga para a oferta',
  'abra contando em uma frase como você encontrou o negócio (segmento + cidade) e cite o fato observado',
  'abra pelo que um cliente novo precisa ver antes de ir até lá (horário, endereço, fotos), ligando ao fato observado',
];
const ANGLES_FOLLOW = [
  'traga um detalhe novo e prático da prévia (o que ela mostraria para esse negócio específico)',
  'reforce em uma frase que a prévia é vista antes de qualquer decisão e pergunte se pode montar',
  'seja bem curto e direto, retomando o fato observado com outras palavras',
];

/**
 * Copy ÚNICA por lead e por passo (COPY_MODE=ai, padrão do cold).
 * - Exige fato_observado: sem ele não gera (lead vai para revisão).
 * - A IA escreve só o núcleo (saudação + texto + pedido); opt-out e assinatura são anexados pelo código.
 * - Cada candidato passa por lint, filtro de promessas e checagem de similaridade (Jaccard de shingles)
 *   contra as últimas copies geradas e contra as tentativas da própria rodada; acima do limite, regera.
 * - Se a IA falhar ou esgotar as tentativas: NÃO cai para template; retorna { ok:false, reason }.
 * COPY_MODE=template mantém o comportamento antigo (template da sequência), só se escolhido explicitamente.
 */
export async function generateAdaptiveCopy(
  lead: Lead,
  stepNumber: number,
  senderName: string,
  step: StepTemplate,
): Promise<CopyResult> {
  if (config.copyMode === 'template') {
    return {
      ok: true,
      copy: {
        subject: renderTemplate(step.subject_template, lead, senderName),
        body: renderTemplate(step.body_template, lead, senderName),
      },
    };
  }

  const fact = (lead.observed_fact ?? '').trim();
  if (fact.length < 8) return { ok: false, reason: 'sem fato_observado (obrigatório para copy única)' };

  const v = leadVars(lead, senderName);
  const leadTokens = [lead.firm_name, v.first_name, lead.name, v.city, lead.neighborhood, lead.practice_area, senderName];
  const tried: string[] = [];
  const issues: string[] = [];

  for (let attempt = 1; attempt <= config.uniq.maxAttempts; attempt++) {
    const angles = stepNumber === 1 ? ANGLES_STEP1 : ANGLES_FOLLOW;
    const angle = angles[(lead.id + attempt + stepNumber) % angles.length];
    const systemPrompt = `Você escreve e-mails frios curtos, em português do Brasil, para donos de pequenos comércios locais.
Quem escreve é ${senderName}, que faz sites de uma página (one-page) por valor fechado de ${config.sitePrice}: apresentação, fotos, horários, endereço com mapa e botão de WhatsApp.

REGRAS INEGOCIÁVEIS:
1. Entre 45 e 85 palavras. Parágrafos curtos. Texto simples, como alguém escrevendo do celular. Cada e-mail deve soar escrito à mão para ESTE negócio.
2. Nenhum link, URL, domínio ou @ de Instagram.
3. Nada de travessão (— ou --), emoji ou palavras infladas ("revolucionário", "alavancar", "potencializar", "transformar seu negócio").
4. Use o fato observado de forma natural e verdadeira. Não invente nota, avaliações, bairro, nomes ou problemas do site.
5. NÃO prometa resultado: proibido "mais clientes", "vender mais", "primeiro lugar no Google", "garantido", "grátis", "sem custo".
6. Termine com UM pedido de permissão para montar uma prévia e mandar para a pessoa ver antes de decidir.
7. NÃO escreva linha de descadastro nem assinatura (o sistema adiciona).
8. Comece com saudação curta: ${v.first_name ? `"Oi, ${v.first_name}"` : 'neutra ("Oi, tudo bem?" ou "Olá")'}.

Responda SOMENTE com JSON: {"subject": "assunto curto em minúsculas, até 6 palavras, sem ponto de exclamação", "body": "texto com linhas em branco entre parágrafos"}`;

    const userPrompt = `Toque ${stepNumber} de 3${stepNumber === 1 ? ' (primeiro contato)' : stepNumber === 2 ? ' (follow-up curto na mesma conversa, 3 dias depois; 25 a 50 palavras)' : ' (último e-mail: encerra com gentileza e deixa a porta aberta; 25 a 45 palavras)'}.
Ângulo desta versão: ${angle}.
Negócio: ${v.business}
Segmento: ${v.segment}
Cidade/bairro: ${[v.city, lead.neighborhood].filter(Boolean).join(' / ') || 'não informado'}
Situação do site: ${lead.site_status ?? 'desconhecida'}
Google Maps: ${lead.maps_rating ?? '?'} de nota, ${lead.maps_reviews ?? '?'} avaliações (só cite se nota ≥ 4,3 e ≥ 20 avaliações)
FATO OBSERVADO (use): ${fact}
${tried.length ? `\nAs versões abaixo ficaram parecidas demais com e-mails já enviados. Escreva algo com estrutura, abertura e frases DIFERENTES:\n${tried.map((t, i) => `[${i + 1}] ${t.slice(0, 400)}`).join('\n')}` : ''}`;

    let raw: unknown;
    try {
      raw = await chatJson<unknown>(
        [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
        Math.min(1.1, 0.75 + 0.15 * attempt),
      );
    } catch (e) {
      issues.push(`IA falhou: ${e instanceof Error ? e.message.slice(0, 120) : String(e)}`);
      continue;
    }

    // validação de schema (reliability): rejeita envelope inválido e caracteres de controle no assunto
    if (!isRecord(raw) || !nonEmptyString(raw.subject) || !nonEmptyString(raw.body)) { issues.push('IA devolveu schema inválido'); continue; }
    if (/[\r\n\x00-\x1f\x7f]/.test(raw.subject)) { issues.push('assunto com caractere de controle'); continue; }
    const res = { subject: raw.subject, body: raw.body };
    const subject = (res.subject || '').replace(/[—–]/g, '-').replace(/["'!]/g, '').trim().toLowerCase();
    const core = (res.body || '').replace(/[—–]/g, ',').replace(/\r\n/g, '\n').trim();
    if (!subject || !core) { issues.push('IA devolveu vazio'); continue; }
    const optOut = OPT_OUTS[(lead.id + stepNumber) % OPT_OUTS.length];
    const body = `${core}\n\n${optOut}\n\n${senderName}`;

    const problem = lintEmail(subject, body, stepNumber) ?? promiseCheck(body) ?? (/\{|\}/.test(body) ? 'chaves no texto' : null);
    if (problem) { issues.push(`lint: ${problem}`); tried.push(core); continue; }

    const norm = normalizeCore(`${subject} ${core}`, leadTokens);
    const { score } = maxSimilarity(norm, tried.map((t) => normalizeCore(t, leadTokens)));
    if (score > config.uniq.maxJaccard) {
      issues.push(`similaridade ${score.toFixed(2)} > ${config.uniq.maxJaccard}`);
      tried.push(core);
      continue;
    }
    recordCopy(lead.id, stepNumber, subject, norm, score);
    return { ok: true, copy: { subject, body } };
  }
  return { ok: false, reason: `copy única não gerada em ${config.uniq.maxAttempts} tentativa(s): ${issues.join(' | ').slice(0, 400)}` };
}

const PROMISE_RE = /(mais clientes|vender mais|primeiro lugar|1º lugar|topo do google|garant|grátis|gratuito|sem custo)/i;
const promiseCheck = (body: string): string | null => (PROMISE_RE.test(body) ? 'promessa proibida' : null);

/**
 * Classifica a resposta humana recebida do advogado em uma das 8 intenções do Plano Mestre
 * e gera um rascunho de resposta para o copiloto.
 */
export async function classifyLeadReply(
  replyText: string,
  leadName: string,
  firmName?: string | null,
): Promise<ReplyClassification> {
  const fName = firstName(leadName);

  const prompt = `Analise a resposta de um dono de comércio local a um e-mail frio que oferecia montar uma prévia de site de uma página por ${config.sitePrice}${firmName ? ` (negócio: ${firmName})` : ''}:
---
RESPOSTA DO PROSPECT:
"${replyText}"
---

Categorize em EXATAMENTE UMA intenção:
1. manda_video: aceitou ver a prévia/exemplo (ex: "pode mandar", "quero ver", "manda aí").
2. quanto_custa: perguntou preço, forma de pagamento, domínio/hospedagem ou o que está incluso.
3. vamos_marcar: quer conversar por telefone/WhatsApp/reunião.
4. ja_usa_outro: já tem site/agência ou acha que o Instagram basta.
5. agora_nao: sem tempo/dinheiro agora, pediu para retomar depois.
6. sem_interesse: recusou ou pediu para não receber mais (ex: "não", "sair", "remova meu e-mail").
7. outro_responsavel: indicou outra pessoa.
8. out_of_office: resposta automática.
9. outros: ambíguo.

Sugira uma resposta curta e humana em pt-BR (sem travessões, sem promessas de resultado):
- manda_video: agradeça, diga que vai montar a prévia e peça 2 ou 3 fotos ou o @ do Instagram e o WhatsApp de contato.
- quanto_custa: valor fechado de ${config.sitePrice} pelo site; diga que domínio/hospedagem você explica e confirma por escrito antes (NÃO invente valores); ofereça montar a prévia antes de qualquer pagamento.
- vamos_marcar: peça o melhor número de WhatsApp e ofereça 2 horários.
- ja_usa_outro: agradeça e pergunte se o site atual mostra horários, mapa e WhatsApp; sem insistir.
- sem_interesse: agradeça e confirme que não vai mais escrever.

Retorne JSON:
{
  "intent": "manda_video|quanto_custa|vamos_marcar|ja_usa_outro|agora_nao|sem_interesse|outro_responsavel|out_of_office|outros",
  "reasoning": "explicação breve em 1 linha",
  "suggestedReply": "texto da resposta sugerida"
}`;

  try {
    const result = await chatJson<unknown>(
      [
        { role: 'system', content: 'Você é um classificador e copiloto comercial de uma pequena agência que vende sites one-page para comércio local.' },
        { role: 'user', content: prompt },
      ],
      0.3,
    );
    const intents: ReplyClassification['intent'][] = ['manda_video', 'quanto_custa', 'vamos_marcar', 'ja_usa_outro', 'agora_nao', 'sem_interesse', 'outro_responsavel', 'out_of_office', 'outros'];
    if (!isRecord(result) || typeof result.intent !== 'string' || !intents.includes(result.intent as ReplyClassification['intent']) ||
        !nonEmptyString(result.reasoning) || !nonEmptyString(result.suggestedReply) || result.reasoning.length > 1000 || result.suggestedReply.length > 2000) {
      throw new Error('Classificação com schema inválido');
    }
    return { intent: result.intent as ReplyClassification['intent'], reasoning: result.reasoning.trim(), suggestedReply: result.suggestedReply.trim() };
  } catch {
    return {
      intent: 'outros',
      reasoning: 'Não foi possível classificar automaticamente via IA',
      suggestedReply: `Olá, ${fName}. Obrigado pelo retorno! Como podemos te ajudar?`,
    };
  }
}
