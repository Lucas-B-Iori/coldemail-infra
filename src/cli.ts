import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import {
  accountDay, addAccount, autoPause, getAccount, resumeAccount, selectAccounts, setStatus, rollDay,
} from './accounts/accounts.ts';
import type { Account, AccountFilter } from './accounts/accounts.ts';
import { addLog, q } from './db/index.ts';
import { verifyImap } from './email/imap.ts';
import { verifySmtp } from './email/smtp.ts';
import { parseCsv } from './lib/csv.ts';
import { errMsg, localDate, pLimit } from './lib/util.ts';
import { newWarmupEmail } from './llm/warmupPrompts.ts';
import { enrollLead, importLeads, setLeadStatus } from './outreach/leads.ts';
import type { Lead, LeadStatus } from './outreach/leads.ts';
import { SAMPLE_LEADS, seedSequences, validateSequences } from './outreach/sequences.ts';
import { lintEmail, renderTemplate, signature } from './outreach/templates.ts';
import { WARMUP_DAYS, config } from './config.ts';

const { positionals, values } = parseArgs({
  allowPositionals: true,
  strict: false,
  options: {
    password: { type: 'string' }, name: { type: 'string' }, provider: { type: 'string' }, group: { type: 'string' },
    day: { type: 'string' }, ids: { type: 'string' }, status: { type: 'string' }, all: { type: 'boolean' },
    reason: { type: 'string' }, list: { type: 'string' }, sequence: { type: 'string' }, limit: { type: 'string' },
    step: { type: 'string' }, to: { type: 'string' }, 'older-than-days': { type: 'string' }, 'to-list': { type: 'string' },
    'smtp-host': { type: 'string' }, 'smtp-port': { type: 'string' }, 'imap-host': { type: 'string' }, 'imap-port': { type: 'string' },
    account: { type: 'string' }, 'set-status': { type: 'string' }, json: { type: 'boolean' }, auth: { type: 'string' },
    'warmup-only': { type: 'boolean' },
  },
});
const v = values as Record<string, string | boolean | undefined>;
const s = (k: string) => (typeof v[k] === 'string' ? (v[k] as string) : undefined);
const [cmd, sub, ...rest] = positionals;

function filterFromFlags(extra?: string): AccountFilter {
  return {
    ids: s('ids')?.split(',').map(Number).filter(Boolean),
    group: s('group'), status: s('status'), all: !!v.all,
    ...(extra ? { ids: [...(s('ids')?.split(',').map(Number) ?? []), ...resolveIds([extra])] } : {}),
  };
}
function resolveIds(refs: string[]): number[] {
  return refs.flatMap((r) => {
    if (/^\d+$/.test(r)) return [Number(r)];
    const a = q.get<{ id: number }>('SELECT id FROM accounts WHERE email=?', r.toLowerCase());
    return a ? [a.id] : [];
  });
}
function target(): Account[] {
  const t = selectAccounts(filterFromFlags(rest[0] && !rest[0].startsWith('-') ? rest[0] : undefined));
  if (!t.length) throw new Error('Nenhuma conta selecionada. Use <email|id>, --ids 1,2, --group X, --status X ou --all');
  return t;
}

const phase = (a: Account) => {
  const d = accountDay(a);
  return a.status === 'banned' ? '-' : d <= WARMUP_DAYS ? `warmup ${d}/${WARMUP_DAYS}` : `produção d${d}`;
};

function accountsTable(list: Account[]) {
  console.table(
    list.map((a) => ({
      id: a.id, email: a.email, grupo: a.group_name, papel: a.warmup_only ? 'semente (warmup)' : 'disparo', status: a.status, fase: phase(a),
      'cold hoje': `${a.sent_today}/${a.daily_limit}`, 'warm hoje': `${a.warmup_sent_today}/${a.warmup_target_today}`,
      bounces: a.bounces_today, obs: a.pause_reason?.slice(0, 50) ?? '',
    })),
  );
}

const commands: Record<string, () => Promise<void> | void> = {
  init() {
    seedSequences();
    const bad = validateSequences();
    console.log('Banco pronto em', config.dbPath, '| sequências padrão criadas.');
    if (bad.length) console.log('ATENÇÃO:', bad);
  },

  async run() {
    seedSequences();
    const { runEngine } = await import('./scheduler.ts');
    await runEngine();
  },

  status() {
    rollDay();
    const list = selectAccounts({ all: true, group: s('group'), status: s('status') });
    if (v.json) return void console.log(JSON.stringify(list.map(({ smtp_pass: _p, ...r }) => r), null, 2));
    console.log(`\n== CAIXAS (${list.length}) — hoje ${localDate()} ==`);
    accountsTable(list);
    const counts = q.all<{ status: string; n: number }>(`SELECT status, COUNT(*) n FROM accounts GROUP BY status`);
    console.log('Frota:', counts.map((c) => `${c.status}=${c.n}`).join('  '));
    const leads = q.all<{ status: string; n: number }>(`SELECT status, COUNT(*) n FROM leads GROUP BY status`);
    console.log('Leads:', leads.map((c) => `${c.status}=${c.n}`).join('  ') || '(nenhum)');
    const qd = q.all<{ status: string; n: number }>(
      `SELECT status, COUNT(*) n FROM outreach_queue WHERE substr(COALESCE(sent_at, created_at),1,10) >= ? GROUP BY status`,
      new Date(Date.now() - 86_400_000).toISOString().slice(0, 10),
    );
    console.log('Fila (24h):', qd.map((c) => `${c.status}=${c.n}`).join('  ') || '(vazia)');
    const w = q.get<{ n: number; r: number }>(
      `SELECT COUNT(*) n, SUM(rescued_from_spam) r FROM warmup_messages WHERE sent_at >= ?`, new Date(Date.now() - 86_400_000).toISOString(),
    )!;
    console.log(`Warm-up (24h): ${w.n} msgs, ${w.r ?? 0} resgatadas do spam\n`);
  },

  async accounts() {
    switch (sub) {
      case 'add': {
        const email = rest[0];
        if (!email || !s('password')) throw new Error('uso: accounts add <email> --password "app password" [--name Nome] [--group g] [--day N] [--warmup-only]');
        const id = addAccount({
          email, password: s('password')!, displayName: s('name'), group: s('group'),
          provider: s('provider') as 'gmail' | 'outlook' | 'm365' | 'other' | undefined,
          authMode: s('auth') as 'password' | 'oauth' | undefined,
          startDay: s('day') ? Number(s('day')) : undefined,
          warmupOnly: Boolean(v['warmup-only']),
          smtp_host: s('smtp-host'), smtp_port: s('smtp-port') ? Number(s('smtp-port')) : undefined,
          imap_host: s('imap-host'), imap_port: s('imap-port') ? Number(s('imap-port')) : undefined,
        });
        console.log(`Conta #${id} cadastrada${v['warmup-only'] ? ' (papel: semente, apenas warmup)' : ''}. Rode: npm run cli -- accounts test ${id}`);
        return;
      }
      case 'import': {
        // CSV: email,password,name,group,provider[,day][,warmup_only]
        const rows = parseCsv(readFileSync(rest[0], 'utf8'));
        let ok = 0;
        for (const r of rows) {
          try {
            addAccount({
              email: r.email, password: r.password || r.senha, displayName: r.name || r.nome,
              group: r.group || r.grupo || s('group'), provider: (r.provider || undefined) as 'gmail' | 'outlook' | 'm365' | undefined,
              authMode: (r.auth || s('auth') || undefined) as 'password' | 'oauth' | undefined,
              startDay: r.day ? Number(r.day) : undefined,
              warmupOnly: Boolean(r.warmup_only === 'true' || r.warmup_only === '1' || v['warmup-only']),
            });
            ok++;
          } catch (e) {
            console.log(`  ✗ ${r.email}: ${errMsg(e)}`);
          }
        }
        console.log(`${ok}/${rows.length} contas importadas.`);
        return;
      }
      case 'list':
        return accountsTable(selectAccounts({ all: true, group: s('group'), status: s('status') }));
      case 'test': {
        const limit = pLimit(8);
        await Promise.all(
          target().map((a) =>
            limit(async () => {
              const res: string[] = [];
              try { await verifyImap(a); res.push('IMAP ✓'); } catch (e) { res.push(`IMAP ✗ ${errMsg(e).slice(0, 80)}`); }
              try { await verifySmtp(a); res.push('SMTP ✓'); } catch (e) { res.push(`SMTP ✗ ${errMsg(e).slice(0, 80)}`); }
              console.log(`#${a.id} ${a.email}: ${res.join(' | ')}`);
            }),
          ),
        );
        return;
      }
      case 'pause':
        return target().forEach((a) => (autoPause(a, s('reason') ?? 'pausa manual'), console.log(`#${a.id} pausada`)));
      case 'resume':
        return target().forEach((a) => (resumeAccount(a), console.log(`#${a.id} retomada`)));
      case 'ban':
        return target().forEach((a) => {
          setStatus(a.id, 'banned', s('reason') ?? 'banida/descartada');
          console.log(`#${a.id} ${a.email} marcada como banned (leads dela serão redistribuídos automaticamente)`);
        });
      case 'set-limit': {
        const val = rest[0];
        const t = selectAccounts(filterFromFlags());
        if (!t.length || !val) throw new Error('uso: accounts set-limit <n|auto> --group X | --ids 1,2 | --all');
        t.forEach((a) => {
          const n = val === 'auto' ? null : Number(val);
          q.run('UPDATE accounts SET limit_override=?, daily_limit=COALESCE(?, daily_limit) WHERE id=?', n, n, a.id);
        });
        return console.log(`${t.length} conta(s) atualizada(s). ${val === 'auto' ? 'Rampa automática reativada (vale amanhã).' : ''}`);
      }
      case 'set-auth': {
        // accounts set-auth oauth|password --group m365   (SMTP; o IMAP do M365 já usa OAuth sempre)
        const mode = rest[0];
        const t = selectAccounts(filterFromFlags());
        if (!t.length || (mode !== 'oauth' && mode !== 'password')) throw new Error('uso: accounts set-auth <oauth|password> --group X | --ids 1,2 | --all');
        t.forEach((a) => q.run('UPDATE accounts SET auth_mode=? WHERE id=?', mode, a.id));
        return console.log(`${t.length} conta(s) -> SMTP via ${mode}.`);
      }
      case 'set-warmup-only': {
        const val = rest[0];
        const isWarmupOnly = val === 'false' || val === '0' ? 0 : 1;
        const t = selectAccounts(filterFromFlags());
        if (!t.length) throw new Error('uso: accounts set-warmup-only [true|false] --ids 1,2 | --group X | --all');
        t.forEach((a) => {
          q.run(
            'UPDATE accounts SET warmup_only=?, auto_promote=?, status=CASE WHEN ?=1 THEN "warming" ELSE status END WHERE id=?',
            isWarmupOnly, isWarmupOnly ? 0 : a.auto_promote, isWarmupOnly, a.id,
          );
        });
        return console.log(`${t.length} conta(s) -> papel: ${isWarmupOnly ? 'semente (apenas warmup)' : 'disparo normal'}.`);
      }
      case 'set-group': {
        const t = selectAccounts(filterFromFlags());
        if (!t.length || !rest[0]) throw new Error('uso: accounts set-group <grupo> --ids 1,2 | --status X');
        t.forEach((a) => q.run('UPDATE accounts SET group_name=? WHERE id=?', rest[0], a.id));
        return console.log(`${t.length} conta(s) movida(s) para "${rest[0]}".`);
      }
      case 'replace': {
        // accounts replace <velha> <nova@email> --password X
        const [oldRef, newEmail] = rest;
        const old = getAccount(resolveIds([oldRef])[0]);
        if (!old || !newEmail || !s('password')) throw new Error('uso: accounts replace <id|email antigo> <novo email> --password "app password"');
        setStatus(old.id, 'banned', `substituída por ${newEmail}`);
        const id = addAccount({ email: newEmail, password: s('password')!, displayName: s('name') ?? old.display_name, group: old.group_name });
        console.log(`#${old.id} banida. Nova conta #${id} entra em warm-up (dia 1). Capacidade será redistribuída pelas demais.`);
        return;
      }
      default:
        throw new Error('accounts: add | import | list | test | pause | resume | ban | set-limit | set-group | replace');
    }
  },

  leads() {
    switch (sub) {
      case 'import': {
        const rows = parseCsv(readFileSync(rest[0], 'utf8'));
        const r = importLeads(rows, { list: s('list') ?? 'default', sequence: s('sequence') ?? 'site_main' });
        return console.log(`Leads: +${r.added} novos, ${r.duplicates} duplicados, ${r.invalid} inválidos.`);
      }
      case 'list': {
        const where: string[] = [];
        const p: (string | number)[] = [];
        if (s('status')) (where.push('status=?'), p.push(s('status')!));
        if (s('list')) (where.push('list_name=?'), p.push(s('list')!));
        console.table(
          q.all<Lead>(`SELECT * FROM leads ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`, ...p, Number(s('limit') ?? 30))
            .map((l) => ({ id: l.id, nome: l.name, email: l.email, lista: l.list_name, status: l.status, passo: l.current_step, proximo: l.next_due_at?.slice(0, 16) ?? '', caixa: l.assigned_account_id ?? '', resposta: l.last_reply_snippet?.slice(0, 40) ?? '' })),
        );
        return;
      }
      case 'set': {
        // leads set <email> --status call|nurture|replied|unsubscribed...
        const l = q.get<Lead>('SELECT * FROM leads WHERE email=?', (rest[0] ?? '').toLowerCase());
        if (!l || !s('status')) throw new Error('uso: leads set <email> --status <status> [--reason nota]');
        setLeadStatus(l.id, s('status') as LeadStatus, s('reason'));
        return console.log(`${l.email} -> ${s('status')}`);
      }
      case 'move': {
        // Reaproveita leads em lote: respondeu e sumiu -> nova sequência / lista de ligação
        // leads move --status replied --older-than-days 7 --sequence site_nurture --to-list nurture
        // leads move --status replied --older-than-days 7 --set-status call
        const days = Number(s('older-than-days') ?? 0);
        const ls = q.all<Lead>(
          `SELECT * FROM leads WHERE status=? AND COALESCE(replied_at, last_contacted_at, created_at) <= ?`,
          s('status') ?? 'replied', new Date(Date.now() - days * 86_400_000).toISOString(),
        );
        for (const l of ls) {
          if (s('sequence')) enrollLead(l.id, s('sequence')!, s('to-list'));
          else if (s('set-status')) {
            setLeadStatus(l.id, s('set-status') as LeadStatus);
            if (s('to-list')) q.run('UPDATE leads SET list_name=? WHERE id=?', s('to-list'), l.id);
          }
        }
        return console.log(`${ls.length} lead(s) movido(s).`);
      }
      default:
        throw new Error('leads: import | list | set | move');
    }
  },

  sequences() {
    if (sub === 'seed') return seedSequences();
    if (sub === 'validate') {
      const p = validateSequences();
      return console.log(p.length ? p.join('\n') : 'Todas as sequências passaram no lint (30 renders por passo).');
    }
    console.table(
      q.all(`SELECT s.name, st.step_number passo, st.delay_days "espera(d)", st.reply_in_thread "na thread", substr(st.subject_template,1,45) assunto
               FROM sequences s JOIN sequence_steps st ON st.sequence_id=s.id ORDER BY s.id, st.step_number`),
    );
  },

  /** Mostra como o e-mail ficará, sem enviar nada. */
  preview() {
    const seq = s('sequence') ?? 'site_main';
    const step = Number(s('step') ?? 1);
    const st = q.get<{ subject_template: string; body_template: string }>(
      `SELECT st.* FROM sequence_steps st JOIN sequences s ON s.id=st.sequence_id WHERE s.name=? AND st.step_number=?`, seq, step,
    );
    if (!st) throw new Error('passo não encontrado');
    const lead = SAMPLE_LEADS[Number(s('sample') ?? 0) % SAMPLE_LEADS.length];
    const subject = renderTemplate(st.subject_template, lead, 'Lucas');
    const body = renderTemplate(st.body_template, lead, 'Lucas');
    console.log(`Assunto: ${subject}\n\n${body}\n\n[lint: ${lintEmail(subject, body, step) ?? 'OK'} | ${body.split(/\s+/).length} palavras]`);
  },

  logs() {
    const where = s('account') ? 'WHERE account_id=' + Number(s('account')) : '';
    console.table(q.all(`SELECT created_at, account_id acc, lead_id lead, kind, event, substr(detail,1,70) detail, action_taken FROM bounces_and_logs ${where} ORDER BY id DESC LIMIT ${Number(s('limit') ?? 25)}`));
  },

  async 'llm-test'() {
    for (let i = 0; i < 3; i++) console.log(await newWarmupEmail({ name: 'Marcos' }, { name: 'Juliana' }), '\n');
  },
};

async function main() {
  const fn = cmd && commands[cmd];
  if (!fn) {
    console.log(`Uso: npm run cli -- <comando>
  init | run | status [--group g] [--status s] [--json]
  accounts add|import|list|test|pause|resume|ban|set-limit|set-group|replace
  leads import|list|set|move      sequences [seed|validate]
  preview [--step N]              logs [--account id]      llm-test`);
    return;
  }
  try {
    await fn();
  } catch (e) {
    console.error('Erro:', errMsg(e));
    process.exitCode = 1;
  }
  void addLog; // mantém import usado quando comandos evoluírem
}
await main();
if (cmd !== 'run') process.exit(process.exitCode ?? 0);
