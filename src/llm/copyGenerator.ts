import { chatJson, isRecord, nonEmptyString } from './client.ts';
import type { Lead } from '../outreach/leads.ts';
import { firstName, lintEmail, renderTemplate, withOptOut, OPT_OUT } from '../outreach/templates.ts';
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

/**
 * Gera um e-mail de cold outreach personalizado para um lead jurídico com base no Plano Mestre:
 * - Inspirado no framework Alex Hormozi ($100M Leads) e mentoria Hustler BR.
 * - Máximo de 3 parágrafos curtos (50 a 85 palavras).
 * - ZERO links e zero URLs.
 * - ZERO travessões (—), sem tom robótico de IA, sem promessas milagrosas.
 * - CTA suave pedindo permissão para enviar vídeo de 90 segundos.
 */
export async function generateAdaptiveCopy(
  lead: Lead,
  stepNumber: number,
  senderName: string,
  selectedTemplate?: CopyTemplate,
): Promise<GeneratedCopy> {
  const fName = firstName(lead.name);
  const firm = lead.firm_name || 'seu escritório';
  const role = lead.role || 'advogado(a)';
  const area = lead.practice_area || 'advocacia';
  const fact = lead.observed_fact || '';
  const hypothesis = lead.need_hypothesis || '';
  const variant = lead.variant || 'modelo_a';

  const systemPrompt = `Você é um copywriter executivo de alto nível especializado em Cold Mail B2B para advogados e escritórios de advocacia no Brasil.
Seu objetivo é redigir um e-mail curto, extremamente natural, sóbrio e humano para apresentar o Dendrix (CRM jurídico simples focado em cadastro de clientes, acompanhamento de processos e publicações).

REGRAS INEGOCIÁVEIS (SANTO GRAAL DO COLD MAIL):
1. Extensão: Máximo de 3 parágrafos curtos. Entre 50 e 80 palavras no total. Ninguém lê e-mail longo.
2. ZERO LINKS: Nunca inclua links, URLs de site, domínios nem links de WhatsApp no e-mail.
3. ZERO CHEIRO DE IA: É ESTRITAMENTE PROIBIDO usar travessões ("—" ou "--"). Nunca use palavras infladas como "revolucionário", "inovador", "alavancar", "potencializar", "ecossistema", "espero que este e-mail o encontre bem".
4. Foco no cliente: Comece falando sobre a rotina/situação do escritório, nunca sobre "eu desenvolvi" ou "nossa empresa".
5. CTA Suave: Termine sempre com uma pergunta simples de baixo atrito pedindo permissão para mandar um vídeo de 90 segundos mostrando a rotina com dados fictícios.
6. Linguagem: Português do Brasil, tom profissional, sóbrio e respeitoso (conforme Provimento 205 da OAB, sem promessas absurdas de nunca perder prazos).
7. Inclua sempre esta opção de descadastro: "${OPT_OUT}". O limite de palavras inclui essa frase.
8. Se houver um template da sequência selecionada, preserve sua intenção e CTA; ele tem precedência sobre as instruções genéricas de toque.

Retorne SEMPRE um JSON válido com os campos:
{
  "subject": "assunto curto em minúsculas (máximo 5 palavras)",
  "body": "corpo do e-mail com quebras de linha duplas entre os parágrafos"
}`;

  let userPrompt = '';

  if (stepNumber === 1) {
    userPrompt = `Redija o Toque 1 (primeiro contato frio) para o seguinte prospect:
Nome: ${fName} (${lead.name})
Escritório: ${firm}
Função: ${role}
Área/Segmento: ${area}
Fato observado: ${fact || 'Advogado atuante na região'}
Hipótese de dor: ${hypothesis || 'Consulta de publicações e organização de processos'}
Modelo base: ${variant}
Remetente: ${senderName}

Exemplo de estrutura ideal:
Oi, ${fName}.
Quando entra uma publicação, como vocês organizam a consulta junto ao acompanhamento dos processos?
Desenvolvi o Dendrix, um sistema jurídico simples com cadastro de clientes, processos e publicações.
Posso te enviar um vídeo de 90 segundos mostrando como organizamos isso na prática?
${senderName} | Dendrix`;
  } else if (stepNumber === 2) {
    userPrompt = `Redija o Toque 2 (Follow-up 1, após 3 dias sem resposta) na mesma thread para:
Nome: ${fName}
Escritório: ${firm}
Remetente: ${senderName}

Objetivo: Concretizar o valor com brevidade. O vídeo de 90s mostra 3 partes (cadastro de clientes, processos e publicações) para ele avaliar antes de decidir conversar.
Perguntar se pode enviar o vídeo.
Manter no máximo 35 a 55 palavras. Sem links. Sem travessões.`;
  } else {
    userPrompt = `Redija o Toque 3 (Follow-up 2 / Break-up final, após 8 dias) para:
Nome: ${fName}
Escritório: ${firm}
Remetente: ${senderName}

Objetivo: Encerrar com gentileza para desocupar a caixa de entrada. Dizer que talvez não seja prioridade agora, mas deixar a porta aberta caso queira ver o vídeo no futuro.
Manter no máximo 35 a 50 palavras. Sem links. Sem travessões.`;
  }

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

    if (!isRecord(res) || !nonEmptyString(res.subject) || !nonEmptyString(res.body)) throw new Error('Copy com schema inválido');
    if (/[\r\n\x00-\x1f\x7f]/.test(res.subject)) throw new Error('Assunto contém caracteres de controle');
    const originalProblem = lintEmail(res.subject, res.body, stepNumber);
    if (originalProblem) throw new Error(`Copy inválida: ${originalProblem}`);

    // Sanitização rigorosa pós-IA
    let cleanSubject = (res.subject || 'publicações do escritório')
      .replace(/[—–]/g, '-')
      .replace(/["']/g, '')
      .trim();
    let cleanBody = withOptOut(res.body
      .replace(/[—–]/g, '')
      .replace(/\r\n/g, '\n')
      .trim());

    // Validação de segurança de entrega
    const lintErr = lintEmail(cleanSubject, cleanBody, stepNumber);
    if (!lintErr) {
      return { subject: cleanSubject, body: cleanBody };
    }
    log('copyGenerator', `IA gerou copy com alerta de lint (${lintErr}); usando fallback seguro.`);
  } catch (e) {
    log('copyGenerator', `Falha na geração via IA: ${e instanceof Error ? e.message : String(e)}; usando fallback.`);
  }

  // Fallback seguro baseado nos modelos oficiais do relatório
  if (selectedTemplate) {
    const rendered = {
      subject: renderTemplate(selectedTemplate.subject_template, lead).trim(),
      body: withOptOut(renderTemplate(selectedTemplate.body_template, lead)),
    };
    const problem = lintEmail(rendered.subject, rendered.body, stepNumber);
    if (problem) throw new Error(`Template da sequência inválido: ${problem}`);
    return rendered;
  }
  const fallback = getFallbackCopy(lead, stepNumber, senderName);
  fallback.body = withOptOut(fallback.body);
  const problem = lintEmail(fallback.subject, fallback.body, stepNumber);
  if (problem) throw new Error(`Fallback inválido: ${problem}`);
  return fallback;
}

/** Fallback baseado nos modelos validados da pesquisa */
function getFallbackCopy(lead: Lead, stepNumber: number, senderName: string): GeneratedCopy {
  const fName = firstName(lead.name);
  const firm = lead.firm_name || 'seu escritório';

  if (stepNumber === 1) {
    if (lead.variant === 'modelo_c') {
      return {
        subject: `financeiro do escritório, ${fName}`,
        body: `Oi, ${fName}.\n\nVocês consultam o financeiro no sistema jurídico ou mantêm esse controle em outra ferramenta?\n\nDesenvolvi o Dendrix, um sistema jurídico com controle financeiro, clientes e acompanhamento de processos.\n\nPosso te enviar uma demonstração rápida de 90 segundos do financeiro para você avaliar se atende ao escritório?\n\n${senderName} | Dendrix`,
      };
    }
    return {
      subject: `publicações do escritório`,
      body: `Oi, ${fName}.\n\nQuando entra uma publicação, como vocês organizam a consulta junto ao acompanhamento dos processos?\n\nDesenvolvi o Dendrix, um sistema jurídico simples com cadastro de clientes, acompanhamento de processos e publicações.\n\nPosso te enviar um vídeo de 90 segundos mostrando como funciona na prática?\n\n${senderName} | Dendrix`,
    };
  }

  if (stepNumber === 2) {
    return {
      subject: `Re: publicações do escritório`,
      body: `${fName}, o exemplo que mencionei mostra três partes: cadastro do cliente, processos e publicações no Dendrix.\n\nAssim você consegue avaliar o funcionamento antes de decidir se vale conversar.\n\nPosso enviar o vídeo?\n\n${senderName}`,
    };
  }

  return {
    subject: `Re: publicações do escritório`,
    body: `${fName}, imagino que a rotina esteja corrida, então vou encerrar o contato por aqui para não ocupar sua caixa.\n\nSe avaliar a organização do escritório fizer sentido mais adiante, é só me responder por aqui.\n\nObrigado,\n${senderName}`,
  };
}

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

  const prompt = `Analise a seguinte resposta enviada por um advogado/escritório após receber um cold mail sobre um sistema jurídico (Dendrix):
---
RESPOSTA DO PROSPECT:
"${replyText}"
---

Categorize em EXATAMENTE UMA das seguintes intenções:
1. manda_video: Prospect concordou em ver o vídeo/amostra (ex: "manda", "pode mandar", "quero ver").
2. quanto_custa: Perguntou valores, preços ou planos (ex: "qual o valor?", "quanto custa?").
3. vamos_marcar: Quer agendar reunião/call ou ver ao vivo (ex: "vamos marcar", "pode me ligar?", "tem horário?").
4. ja_usa_outro: Informou que já usa outro sistema (ex: "já usamos o Projuris", "uso o Astrea").
5. agora_nao: Sem tempo no momento ou pediu para retomar depois (ex: "agora está corrido", "fale comigo mês que vem").
6. sem_interesse: Recusou educadamente ou pediu descadastro (ex: "não tenho interesse", "retire meu e-mail").
7. outro_responsavel: Indicou outra pessoa ou setor (ex: "fale com o Dr. Marcos", "envie para o financeiro").
8. out_of_office: Resposta automática de férias/ausência.
9. outros: Qualquer outra situação ambígua.

Gere uma sugestão de resposta curta, educada e direta em português do Brasil (sem travessões).
Se for "manda_video": inclua link fictício [LINK_DO_VIDEO] e pergunte como organizam hoje.
Se for "quanto_custa": informe que o plano custa R$ 200/mês e pergunte qual rotina é mais crítica.
Se for "vamos_marcar": ofereça 2 opções de horários reais (10 a 15 min).
Se for "ja_usa_outro": agradeça e pergunte se há alguma rotina que ainda precisam resolver fora dele.
Se for "sem_interesse": agradeça com brevidade e confirme a retirada.

Retorne JSON:
{
  "intent": "manda_video|quanto_custa|vamos_marcar|ja_usa_outro|agora_nao|sem_interesse|outro_responsavel|out_of_office|outros",
  "reasoning": "explicação breve em 1 linha",
  "suggestedReply": "texto da resposta sugerida"
}`;

  try {
    const result = await chatJson<unknown>(
      [
        { role: 'system', content: 'Você é um classificador e copiloto comercial experiente em B2B jurídico.' },
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
