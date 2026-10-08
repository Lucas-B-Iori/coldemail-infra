import { q, tx } from '../db/index.ts';
import { lintEmail, renderTemplate } from './templates.ts';

interface SeedStep {
  delay_days: number;
  reply_in_thread: 0 | 1;
  subject: string;
  body: string;
}

/**
 * Cadência principal (Dendrix -> advogado autônomo / escritório pequeno).
 * Princípios aplicados (pesquisa): ≤ 100 palavras, texto puro, ZERO link no toque 1, 1 pergunta/CTA por e-mail,
 * abertura sobre o PROSPECT (poke the bear), cada follow-up com ângulo novo, break-up no fim, opt-out claro (LGPD),
 * tom sóbrio (Provimento 205/2021 da OAB: sem promessa de resultado nem linguagem mercantilista).
 * Spintax {a|b} varia o texto entre leads.
 */
const MAIN: SeedStep[] = [
  {
    delay_days: 0,
    reply_in_thread: 0,
    subject: '{publicações do escritório|uma dúvida sobre o escritório, {{first_name}}}',
    body: `Oi, {{first_name}}.

Quando entra uma publicação, como vocês organizam a consulta junto ao acompanhamento dos processos?

Desenvolvi o Dendrix, um sistema jurídico simples com cadastro de clientes, acompanhamento de processos e publicações.

Posso te enviar um vídeo de 90 segundos mostrando como organizamos isso na prática?`,
  },
  {
    delay_days: 3,
    reply_in_thread: 1,
    subject: 'Re: publicações do escritório',
    body: `{{first_name}}, o exemplo que mencionei mostra três partes: cadastro do cliente, acompanhamento de processos e publicações no Dendrix.

Assim você consegue avaliar o funcionamento antes de decidir se vale conversar.

Posso enviar o vídeo?`,
  },
  {
    delay_days: 5,
    reply_in_thread: 1,
    subject: 'Re: publicações do escritório',
    body: `{{first_name}}, talvez avaliar um sistema agora não seja prioridade por aí.

Se vocês já usam outra ferramenta, o vídeo também serve para comparar uma rotina específica, sem compromisso algum.

Quer receber o exemplo ou prefere que eu encerre o contato por aqui para não ocupar sua caixa?`,
  },
];

/** Lista "quente que esfriou": quem respondeu e depois sumiu. */
const NURTURE: SeedStep[] = [
  {
    delay_days: 0,
    reply_in_thread: 1,
    subject: 'retomando nossa conversa',
    body: `{{first_name}}, {retomando|voltando a} nossa conversa.

Na última vez ficou de você me dizer {se faria sentido|quando poderíamos} ver o Dendrix na prática. {Ainda é um assunto para você?|Isso ainda está no seu radar?}

Se preferir, {posso ajustar o horário|me diga o melhor horário} que {encaixa|funciona} na sua agenda.`,
  },
  {
    delay_days: 10,
    reply_in_thread: 1,
    subject: 'última tentativa',
    body: `{{first_name}}, {última tentativa por e-mail|último e-mail por aqui}.

Se fizer mais sentido, posso te ligar rapidamente em vez de trocar mensagens. {É só me avisar um horário.|Me passe um horário que encaixe.}

{Se não for o momento, sem problema algum.|Se não for o momento, tudo bem.}`,
  },
];

export const DEFAULT_SEQUENCES = {
  dendrix_main: { description: 'Cadência fria principal (5 toques)', steps: MAIN },
  dendrix_nurture: { description: 'Reativação de leads que responderam e sumiram', steps: NURTURE },
};

export function seedSequences(): void {
  tx(() => {
    for (const [name, s] of Object.entries(DEFAULT_SEQUENCES)) {
      if (q.get('SELECT id FROM sequences WHERE name=?', name)) continue;
      const id = q.run('INSERT INTO sequences (name, description) VALUES (?,?)', name, s.description).id;
      s.steps.forEach((st, i) =>
        q.run(
          `INSERT INTO sequence_steps (sequence_id, step_number, delay_days, reply_in_thread, subject_template, body_template)
           VALUES (?,?,?,?,?,?)`,
          id, i + 1, st.delay_days, st.reply_in_thread, st.subject, st.body,
        ),
      );
    }
  });
}

/** Renderiza 30x cada passo com um lead fictício e roda o lint. Retorna os problemas encontrados. */
export function validateSequences(): string[] {
  const problems: string[] = [];
  const steps = q.all<{ name: string; step_number: number; subject_template: string; body_template: string }>(
    `SELECT s.name, st.step_number, st.subject_template, st.body_template
       FROM sequence_steps st JOIN sequences s ON s.id = st.sequence_id`,
  );
  for (const st of steps) {
    for (let i = 0; i < 30; i++) {
      const lead = { name: 'Dr. Carlos Silva', firm_name: 'Silva Advocacia', city_state: 'São Paulo/SP' };
      const p = lintEmail(renderTemplate(st.subject_template, lead), renderTemplate(st.body_template, lead), st.step_number);
      if (p) {
        problems.push(`${st.name} passo ${st.step_number}: ${p}`);
        break;
      }
    }
  }
  return problems;
}
