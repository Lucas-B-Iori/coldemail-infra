import { chatJson, isRecord, nonEmptyString } from './client.ts';
import type { ChatMessage } from './client.ts';
import { pick } from '../lib/util.ts';

/**
 * Sementes de CONTEXTO (não são templates): servem só para variar o tema entre conversas.
 * O texto final é 100% gerado pela LLM a cada chamada.
 */
const SCENARIOS = [
  'alinhar o horário de uma reunião de acompanhamento da semana',
  'dar feedback sobre o alinhamento mensal da equipe',
  'tirar uma dúvida sobre prazo de entrega de um fornecedor',
  'confirmar as prioridades combinadas e que vai revisar até amanhã',
  'pedir uma opinião rápida sobre uma proposta comercial',
  'remarcar uma call por conflito de agenda no final do dia',
  'perguntar o status de uma cotação enviada na semana passada',
  'agradecer pela ajuda numa demanda urgente de ontem',
  'combinar quem vai ficar responsável por uma tarefa do projeto',
  'perguntar se a nota fiscal de um serviço já foi emitida',
  'sugerir pauta para a reunião de alinhamento da equipe',
  'avisar que vai ficar fora um dia e deixar um pendente combinado',
  'pedir ajuste de um orçamento para caber no planejamento do trimestre',
  'confirmar presença em um treinamento interno na sexta',
  'perguntar sobre a renovação de um contrato de prestação de serviço',
  'solicitar segunda via do boleto de um serviço contratado',
  'pedir o contato do responsável técnico por uma integração',
  'alinhar as prioridades da equipe para a próxima quinzena',
  'perguntar se deu tempo de avaliar as prioridades combinadas ontem',
  'solicitar acesso a uma pasta compartilhada que está restrita',
  'perguntar sobre o status de um pagamento combinado',
  'perguntar se haverá expediente na véspera do feriado',
  'solicitar revisão de uma cláusula específica no rascunho de acordo',
  'pedir sugestão de fornecedor de serviços de nuvem ou TI',
  'agradecer pelos esclarecimentos sobre o fechamento contábil',
  'perguntar se a apresentação para os diretores já está fechada',
  'avisar que o link da sala virtual mudou para a call das 15h',
  'solicitar autorização para reembolso de despesa de viagem',
  'perguntar sobre a data de implantação da nova ferramenta interna',
  'alinhar detalhes da transição de um cliente novo',
  'pedir validação da lista de participantes para o workshop',
  'informar sobre uma manutenção preventiva agendada para o fim de semana',
  'perguntar se falta alguma certidão para concluir o dossiê',
  'combinar uma breve conversa de 10 minutos antes do almoço',
  'solicitar atualização sobre a entrega dos novos notebooks',
  'pedir indicação de modelo de procuração para um caso específico',
  'confirmar que os acessos ao painel de controle foram liberados',
  'pedir esclarecimento sobre a prioridade de uma tarefa da equipe',
  'perguntar se o feedback do cliente sobre o piloto já chegou',
  'agendar alinhamento de rotina com o time de suporte',
  'solicitar envio da relação de faturas pendentes de liquidação',
  'perguntar se o checklist de segurança foi finalizado',
  'pedir opinião sobre novo layout proposto para a documentação',
  'alinhar quem vai participar da reunião com a auditoria',
  'avisar sobre uma instabilidade temporária no acesso à VPN',
  'perguntar sobre o status da documentação complementar do processo',
  'pedir estimativa de horas necessárias para finalizar a tarefa',
  'perguntar se a gravação do treinamento de ontem já foi disponibilizada',
  'sugerir mudança no horário da daily para acomodar todo o time',
  'agradecer pela rápida solução do chamado de atendimento',
];

const RULES = `REGRAS OBRIGATÓRIAS:
- Português do Brasil, tom profissional natural de colegas/parceiros de trabalho.
- Texto curto: de 2 a 5 frases.
- PROIBIDO: links, URLs, anexos, números de telefone, emojis, termos promocionais, vendas, ofertas, "clique aqui".
- Não afirme que enviou ou recebeu arquivos, anexos ou documentos: esta conversa não transporta arquivos. Use somente fatos da conversa.
- Nada de saudações exageradas. Termine com um fecho curto e o primeiro nome do remetente.
- Não repita estruturas óbvias; escreva como uma pessoa real com pressa.
- Responda SOMENTE em JSON válido.`;

export interface WarmupDraft {
  subject: string;
  body: string;
}

const BANNED = /(https?:\/\/|www\.|\.com\b|\.br\b|promo|oferta|desconto|grátis|gratis|clique|compre|garanta|imperdível|@)/i;

export function validateWarmupText(t: unknown, needSubject: boolean): string | null {
  if (!isRecord(t) || !nonEmptyString(t.body) || t.body.trim().split(/\s+/).length < 3) return 'sem corpo';
  if ((needSubject || t.subject !== undefined) &&
      (!nonEmptyString(t.subject) || t.subject.trim().length < 3 || t.subject.length > 90 || /[\r\n\x00-\x1f\x7f]/.test(t.subject))) return 'assunto inválido';
  if (BANNED.test(t.body) || BANNED.test(typeof t.subject === 'string' ? t.subject : '')) return 'termo/link proibido';
  if (/\b(anex(?:o|os|ado|ada|ados|adas)|attach(?:ed|ment)?)\b|\b(?:enviei|enviamos|recebi|recebemos|segue|seguem)\b[^.!?\n]{0,50}\b(?:arquivo|documento|relatório|comprovante)\b/i.test(t.body)) return 'referência a arquivo inexistente';
  const sentences = t.body.split(/[.!?]+\s/).filter((s) => s.trim().length > 2).length;
  if (sentences < 2 || sentences > 8) return `frases fora do intervalo (${sentences})`;
  if (t.body.length > 700) return 'longo demais';
  if (t.body.trim().split(/\s+/).length > 120) return 'palavras demais';
  return null;
}

async function generate(messages: ChatMessage[], needSubject: boolean): Promise<WarmupDraft> {
  let lastReason = '';
  for (let i = 0; i < 3; i++) {
    try {
      const out = await chatJson<unknown>(messages);
      const reason = validateWarmupText(out, needSubject);
      if (!reason && isRecord(out)) return { subject: typeof out.subject === 'string' ? out.subject.trim() : '', body: (out.body as string).trim() };
      lastReason = reason || 'schema inválido';
    } catch (error) {
      lastReason = error instanceof Error ? error.message : String(error);
    }
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
