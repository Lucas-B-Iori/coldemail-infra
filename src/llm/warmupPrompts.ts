import { chatJson } from './client.ts';
import type { ChatMessage } from './client.ts';
import { pick } from '../lib/util.ts';

/**
 * Sementes de CONTEXTO (não são templates): servem só para variar o tema entre conversas.
 * O texto final é 100% gerado pela LLM a cada chamada.
 */
const SCENARIOS = [
  'alinhar o horário de uma reunião de acompanhamento da semana',
  'dar feedback sobre um relatório mensal que acabou de receber',
  'tirar uma dúvida sobre prazo de entrega de um fornecedor',
  'confirmar que recebeu um arquivo e que vai revisar até amanhã',
  'pedir uma opinião rápida sobre uma proposta comercial',
  'remarcar uma call por conflito de agenda',
  'perguntar o status de uma cotação enviada na semana passada',
  'agradecer pela ajuda numa demanda urgente de ontem',
  'combinar quem vai ficar responsável por uma tarefa do projeto',
  'perguntar se a nota fiscal de um serviço já foi emitida',
  'sugerir pauta para a reunião de alinhamento da equipe',
  'avisar que vai ficar fora um dia e deixar um pendente combinado',
  'pedir ajuste de um orçamento para caber no planejamento do trimestre',
  'confirmar presença em um treinamento interno',
  'perguntar sobre a renovação de um contrato de prestação de serviço',
];

const RULES = `REGRAS OBRIGATÓRIAS:
- Português do Brasil, tom profissional natural de colegas/parceiros de trabalho.
- Texto curto: de 2 a 5 frases.
- PROIBIDO: links, URLs, anexos, números de telefone, emojis, termos promocionais, vendas, ofertas, "clique aqui".
- Nada de saudações exageradas. Termine com um fecho curto e o primeiro nome do remetente.
- Não repita estruturas óbvias; escreva como uma pessoa real com pressa.
- Responda SOMENTE em JSON válido.`;

export interface WarmupDraft {
  subject: string;
  body: string;
}

const BANNED = /(https?:\/\/|www\.|\.com\b|\.br\b|promo|oferta|desconto|grátis|gratis|clique|compre|garanta|imperdível|@)/i;

export function validateWarmupText(t: Partial<WarmupDraft>, needSubject: boolean): string | null {
  if (!t.body || typeof t.body !== 'string') return 'sem corpo';
  if (needSubject && (!t.subject || t.subject.length < 3 || t.subject.length > 90)) return 'assunto inválido';
  if (BANNED.test(t.body) || BANNED.test(t.subject ?? '')) return 'termo/link proibido';
  const sentences = t.body.split(/[.!?]+\s/).filter((s) => s.trim().length > 2).length;
  if (sentences < 2 || sentences > 8) return `frases fora do intervalo (${sentences})`;
  if (t.body.length > 700) return 'longo demais';
  return null;
}

async function generate(messages: ChatMessage[], needSubject: boolean): Promise<WarmupDraft> {
  let lastReason = '';
  for (let i = 0; i < 3; i++) {
    const out = await chatJson<Partial<WarmupDraft>>(messages);
    const reason = validateWarmupText(out, needSubject);
    if (!reason) return { subject: (out.subject ?? '').trim(), body: out.body!.trim() };
    lastReason = reason;
  }
  throw new Error(`LLM gerou texto inválido 3x (${lastReason})`);
}

export function newWarmupEmail(from: { name: string }, to: { name: string }): Promise<WarmupDraft> {
  return generate(
    [
      { role: 'system', content: `Você escreve e-mails corporativos curtos e realistas entre colegas no Brasil.\n${RULES}` },
      {
        role: 'user',
        content: `Remetente: ${from.name}. Destinatário: ${to.name}.\nSituação: ${pick(SCENARIOS)}.\nEscreva o PRIMEIRO e-mail da conversa.\nFormato: {"subject": "assunto curto e natural", "body": "texto do e-mail"}`,
      },
    ],
    true,
  );
}

export function replyWarmupEmail(
  from: { name: string },
  to: { name: string },
  history: { from: string; body: string }[],
  isLast: boolean,
): Promise<WarmupDraft> {
  const convo = history.map((h) => `${h.from} escreveu:\n${h.body}`).join('\n\n---\n\n');
  return generate(
    [
      { role: 'system', content: `Você escreve respostas de e-mail corporativo curtas e realistas no Brasil.\n${RULES}` },
      {
        role: 'user',
        content: `Você é ${from.name}, respondendo a ${to.name}. Conversa até agora:\n\n${convo}\n\nEscreva a resposta de ${from.name}.${
          isLast ? ' Esta resposta encerra a conversa (um agradecimento ou confirmação simples).' : ''
        }\nFormato: {"body": "texto da resposta"}`,
      },
    ],
    false,
  );
}
