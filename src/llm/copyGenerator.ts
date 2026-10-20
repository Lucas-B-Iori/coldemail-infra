import { chatJson, isRecord, nonEmptyString } from './client.ts';
import type { Lead } from '../outreach/leads.ts';
import { firstName, leadVars, lintEmail, renderTemplate } from '../outreach/templates.ts';
import { config } from '../config.ts';
import { log } from '../lib/util.ts';

export interface GeneratedCopy {
  subject: string;
  body: string;
}

export interface CopyTemplate {
  subject_template: string;
  body_template: string;
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

/**
 * Gera a copy de um passo da cadência de venda de site one-page.
 * - COPY_MODE=template (padrão): renderiza o template da sequência (determinístico, já passou no lint).
 * - COPY_MODE=ai: um modelo barato (DeepSeek/MiMo via OpenRouter) reescreve o template para o lead;
 *   se a IA falhar ou violar o lint, usa o template renderizado.
 */
export async function generateAdaptiveCopy(
  lead: Lead,
  stepNumber: number,
  senderName: string,
  step: StepTemplate,
): Promise<GeneratedCopy> {
  const base: GeneratedCopy = {
    subject: renderTemplate(step.subject_template, lead, senderName),
    body: renderTemplate(step.body_template, lead, senderName),
  };
  if (config.copyMode !== 'ai') return base;

  const v = leadVars(lead, senderName);
  const systemPrompt = `Você escreve e-mails frios curtos, em português do Brasil, para donos de pequenos comércios locais (padaria, salão, oficina, clínica, restaurante, pet shop etc.).
Quem escreve é ${senderName}, que faz sites de uma página (one-page) por valor fechado de ${config.sitePrice}: apresentação, fotos, horários, endereço com mapa e botão de WhatsApp.

REGRAS INEGOCIÁVEIS:
1. Entre 50 e 100 palavras. Parágrafos curtos. Texto simples, como alguém escrevendo do celular.
2. Nenhum link, URL, domínio ou @ de Instagram no texto.
3. Nada de travessão (— ou --), nada de emoji, nada de palavras infladas ("revolucionário", "alavancar", "potencializar", "transformar seu negócio").
4. Abra falando do negócio do lead (o que você observou), nunca de você.
5. NÃO prometa resultado: proibido "mais clientes", "vender mais", "primeiro lugar no Google", "garantido", "grátis".
6. Use só os fatos fornecidos. Não invente nota, avaliações, bairro ou problemas do site.
7. Termine com UM pedido de permissão: posso montar uma prévia e te mandar para você ver?
8. Inclua uma linha de opt-out clara (ex.: "Se não fizer sentido, é só responder 'não' que eu não escrevo mais."), exceto no último toque.
9. Assine só com o primeiro nome: ${senderName}.

Responda SOMENTE com JSON: {"subject": "assunto curto em minúsculas, até 6 palavras", "body": "corpo com linhas em branco entre parágrafos"}`;

  const userPrompt = `Toque ${stepNumber} de 3${stepNumber === 1 ? ' (primeiro contato)' : stepNumber === 2 ? ' (follow-up curto na mesma conversa, 3 dias depois)' : ' (último e-mail, encerra com gentileza e deixa a porta aberta)'}.
Negócio: ${v.business}
Segmento: ${v.segment}
Local: ${v.place}
Contato conhecido: ${v.first_name || 'não (use saudação neutra "Oi, tudo bem?")'}
Situação do site: ${lead.site_status ?? 'desconhecida'}
Google Maps: ${lead.maps_rating ?? '?'} de nota, ${lead.maps_reviews ?? '?'} avaliações
Observação do pesquisador: ${lead.observed_fact || '(nenhuma)'}

Use este rascunho aprovado como base e mantenha a mesma estrutura e o mesmo pedido:
ASSUNTO: ${base.subject}
${base.body}`;

  if (selectedTemplate) {
    userPrompt = `Personalize o template da sequência selecionada, preservando assunto, intenção, contexto e CTA. Não invente contato anterior além do template. Remetente: ${senderName}.\nAssunto: ${renderTemplate(selectedTemplate.subject_template, lead)}\nCorpo: ${renderTemplate(selectedTemplate.body_template, lead)}\nInclua: ${OPT_OUT}`;
  }

  try {
    const res = await chatJson<unknown>(
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      0.7,
    );
    const subject = (res.subject || base.subject).replace(/[—–]/g, '-').replace(/["']/g, '').trim();
    const body = (res.body || '').replace(/[—–]/g, ',').replace(/\r\n/g, '\n').trim();
    const lintErr = lintEmail(subject, body, stepNumber) ?? promiseCheck(body);
    if (!lintErr && body) return { subject, body };
    log('copyGenerator', `IA gerou copy com alerta (${lintErr ?? 'vazia'}); usando template.`);
  } catch (e) {
    log('copyGenerator', `Falha na IA: ${e instanceof Error ? e.message : String(e)}; usando template.`);
  }
  return base;
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
