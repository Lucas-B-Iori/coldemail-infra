import { q, tx } from '../db/index.ts';
import { lintEmail, renderTemplate } from './templates.ts';

interface SeedStep {
  delay_days: number;
  reply_in_thread: 0 | 1;
  subject: string;
  body: string;
}

/**
 * Cadência principal: site one-page por preço fixo para comércio local sem site ou com site fraco.
 * Princípios: texto puro, ≤ 110 palavras, ZERO link no toque 1, abertura sobre o NEGÓCIO do lead,
 * 1 pedido por e-mail (permissão para mandar uma prévia), opt-out explícito em todos os toques (LGPD),
 * nenhuma promessa de resultado (sem "mais clientes", "1º lugar no Google" etc.).
 * Variáveis: veja leadVars() em templates.ts. Spintax {a|b} varia o texto entre leads.
 */
const OPT_OUT = '{Se não fizer sentido, é só responder "não" que eu não escrevo mais.|Se não for do seu interesse, responda "sair" e eu tiro seu contato da lista.}';

const MAIN: SeedStep[] = [
  {
    delay_days: 0,
    reply_in_thread: 0,
    subject: '{site para {{business}}|uma prévia de site|{{business}} no Google}',
    body: `{{greeting}}

{Encontrei|Achei} vocês {procurando|pesquisando} {{segment}} em {{place}}{{maps_phrase}}. Reparei que {{site_phrase}}.

Eu faço sites de uma página para {negócios|comércios} locais: quem vocês são, fotos, horários, endereço com mapa e botão de WhatsApp. Valor fechado de {{price}}.

{Posso montar uma prévia com a cara de vocês e te mandar aqui|Topa que eu monte uma prévia com a cara de vocês e te mande aqui} para você ver antes de decidir qualquer coisa?

${OPT_OUT}

{{sender}}`,
  },
  {
    delay_days: 3,
    reply_in_thread: 1,
    subject: 'Re: site para {{business}}',
    body: `{{greeting}}

Só complementando: a prévia fica pronta em {poucos dias|uns 2 ou 3 dias} e você vê antes de pagar qualquer coisa. Se não gostar, fica por isso mesmo.

Quer que eu prepare a de vocês?

${OPT_OUT}

{{sender}}`,
  },
  {
    delay_days: 5,
    reply_in_thread: 1,
    subject: 'Re: site para {{business}}',
    body: `{{greeting}}

{Imagino que a rotina esteja corrida|Sei que o dia a dia de quem atende cliente é corrido}, então este é meu último e-mail sobre o assunto.

Se um dia quiser ver como ficaria o site de vocês, é só responder aqui que eu monto a prévia.

{Obrigado pela atenção|Valeu pela atenção},
{{sender}}`,
  },
];

/** Lista "quente que esfriou": quem respondeu e depois sumiu. */
const NURTURE: SeedStep[] = [
  {
    delay_days: 0,
    reply_in_thread: 1,
    subject: 'retomando sobre o site',
    body: `{{greeting}}

{Retomando|Voltando a} nossa conversa sobre o site. Ainda faz sentido eu montar a prévia para você ver?

${OPT_OUT}

{{sender}}`,
  },
  {
    delay_days: 10,
    reply_in_thread: 1,
    subject: 'último contato',
    body: `{{greeting}}

Último e-mail por aqui. Se preferir, me passe um WhatsApp e eu te mando a prévia por lá.

Se não for o momento, sem problema.

{{sender}}`,
  },
];

export const DEFAULT_SEQUENCE = 'site_main';

export const DEFAULT_SEQUENCES = {
  site_main: { description: 'Site one-page para comércio local (3 toques)', steps: MAIN },
  site_nurture: { description: 'Reativação de leads que responderam e sumiram', steps: NURTURE },
};

export function seedSequences(): void {
  tx(() => {
    for (const [name, s] of Object.entries(DEFAULT_SEQUENCES)) {
      const existing = q.get<{ id: number }>('SELECT id FROM sequences WHERE name=?', name);
      const id = existing ? existing.id : q.run('INSERT INTO sequences (name, description) VALUES (?,?)', name, s.description).id;
      q.run('DELETE FROM sequence_steps WHERE sequence_id=?', id);
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

export const SAMPLE_LEADS = [
  { name: 'Padaria Pão Dourado', firm_name: 'Padaria Pão Dourado', city: 'Campinas', neighborhood: 'Cambuí', practice_area: 'Padaria',
    maps_rating: 4.7, maps_reviews: 312, site_status: 'nenhum', contact_known: 0 },
  { name: 'Marcos Lima', firm_name: 'Oficina do Marcos', city: 'Santos', practice_area: 'Oficina mecânica',
    maps_rating: 4.1, maps_reviews: 18, site_status: 'ruim', contact_known: 1 },
];

/** Renderiza 30x cada passo com um lead fictício e roda o lint. Retorna os problemas encontrados. */
export function validateSequences(): string[] {
  const problems: string[] = [];
  const steps = q.all<{ name: string; step_number: number; subject_template: string; body_template: string }>(
    `SELECT s.name, st.step_number, st.subject_template, st.body_template
       FROM sequence_steps st JOIN sequences s ON s.id = st.sequence_id`,
  );
  for (const st of steps) {
    for (let i = 0; i < 30; i++) {
      const lead = SAMPLE_LEADS[i % SAMPLE_LEADS.length];
      const p = lintEmail(renderTemplate(st.subject_template, lead, 'Lucas'), renderTemplate(st.body_template, lead, 'Lucas'), st.step_number);
      if (p) {
        problems.push(`${st.name} passo ${st.step_number}: ${p}`);
        break;
      }
    }
  }
  return problems;
}
