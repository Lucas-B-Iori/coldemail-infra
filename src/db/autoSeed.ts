import { q } from './index.ts';
import { encrypt } from '../lib/crypto.ts';
import { log } from '../lib/util.ts';

const M365_ACCOUNTS = [
  { email: 'lucas@synapzeai.net', name: 'Lucas Iori | Synapze' },
  { email: 'miguel@synapzeai.net', name: 'Miguel Tasso | Synapze' },
  { email: 'felipe@synapzeai.net', name: 'Felipe Silveira | Synapze' },
  { email: 'pedro@synapzeai.net', name: 'Pedro Mendes | Synapze' },
  { email: 'gabriel@synapzeai.net', name: 'Gabriel Ramos | Synapze' },
  { email: 'camila@synapzeai.net', name: 'Camila Rocha | Synapze' },
  { email: 'mariana@synapzeai.net', name: 'Mariana Costa | Synapze' },
  { email: 'isabela@synapzeai.net', name: 'Isabela Martins | Synapze' },
  { email: 'lionel@synapzeai.net', name: 'Lionel Duarte | Synapze' },
];

/**
 * Sementes Gmail (App Passwords) lidas EXCLUSIVAMENTE do ambiente.
 * Defina SEED_GMAIL_<N>_USER, SEED_GMAIL_<N>_PASS e (opcional) SEED_GMAIL_<N>_NAME, N=1..10.
 * Sementes sem USER e PASS são ignoradas com aviso.
 */
function loadGmailSeeds(): { email: string; name: string; pass: string }[] {
  const seeds: { email: string; name: string; pass: string }[] = [];
  for (let i = 1; i <= 10; i++) {
    const email = process.env[`SEED_GMAIL_${i}_USER`]?.trim();
    const pass = process.env[`SEED_GMAIL_${i}_PASS`]?.replace(/\s+/g, '');
    if (!email && !pass) continue;
    if (!email || !pass) {
      log('autoSeed', `AVISO: SEED_GMAIL_${i}_USER/PASS incompletos — semente ${i} ignorada.`);
      continue;
    }
    seeds.push({ email, pass, name: process.env[`SEED_GMAIL_${i}_NAME`]?.trim() || email });
  }
  return seeds;
}

/**
 * Se o banco for novo (ex: primeiro deploy em container/Easypanel),
 * inicializa automaticamente as 11 contas da frota com início oficial em 09/10/2026.
 */
export function autoSeedFleetIfEmpty(): void {
  const count = q.get<{ n: number }>('SELECT COUNT(*) n FROM accounts')?.n ?? 0;
  if (count > 0) return;

  log('autoSeed', 'Banco novo detectado. Auto-inicializando frota de 11 contas...');
  const warmupStart = '2026-10-09T12:00:00Z'; // Início oficial: 09/10/2026
  const now = new Date().toISOString();

  // 1. Inserir 9 caixas M365 (OAuth)
  for (const acc of M365_ACCOUNTS) {
    q.run(
      `INSERT INTO accounts (email, display_name, provider, auth_mode, group_name, smtp_host, smtp_port, smtp_user, smtp_pass,
         imap_host, imap_port, warmup_started_at, warmup_only, auto_promote, status, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      acc.email, acc.name, 'm365', 'oauth', 'm365',
      'smtp.office365.com', 587, acc.email, encrypt('oauth-app-auth'),
      'outlook.office365.com', 993, warmupStart, 0, 1, 'warming', now,
    );
  }

  // 2. Inserir sementes Gmail (App Passwords, via env)
  const GMAIL_SEEDS = loadGmailSeeds();
  if (GMAIL_SEEDS.length === 0) {
    log('autoSeed', 'AVISO: nenhuma semente Gmail configurada (SEED_GMAIL_<N>_USER/PASS). Pulando sementes.');
  }
  for (const s of GMAIL_SEEDS) {
    q.run(
      `INSERT INTO accounts (email, display_name, provider, auth_mode, group_name, smtp_host, smtp_port, smtp_user, smtp_pass,
         imap_host, imap_port, warmup_started_at, warmup_only, auto_promote, status, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      s.email, s.name, 'gmail', 'password', 'seed_gmail',
      'smtp.gmail.com', 465, s.email, encrypt(s.pass),
      'imap.gmail.com', 993, warmupStart, 1, 0, 'warming', now,
    );
  }

  log('autoSeed', `Frota inicializada: ${M365_ACCOUNTS.length} M365 + ${GMAIL_SEEDS.length} sementes Gmail.`);
}
