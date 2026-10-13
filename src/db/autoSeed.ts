import { q } from "./index.ts";
import { encrypt } from "../lib/crypto.ts";
import { log } from "../lib/util.ts";

const M365_ACCOUNTS = [
  { email: "lucas@synapzeai.net", name: "Lucas Iori | Synapze" },
  { email: "miguel@synapzeai.net", name: "Miguel Tasso | Synapze" },
  { email: "felipe@synapzeai.net", name: "Felipe Silveira | Synapze" },
  { email: "pedro@synapzeai.net", name: "Pedro Mendes | Synapze" },
  { email: "gabriel@synapzeai.net", name: "Gabriel Ramos | Synapze" },
  { email: "camila@synapzeai.net", name: "Camila Rocha | Synapze" },
  { email: "mariana@synapzeai.net", name: "Mariana Costa | Synapze" },
  { email: "isabela@synapzeai.net", name: "Isabela Martins | Synapze" },
  { email: "lionel@synapzeai.net", name: "Lionel Duarte | Synapze" },
];

const GMAIL_SEEDS = [
  {
    email: "lucasbertolassiiori@gmail.com",
    name: "Lucas Iori",
    pass: process.env.GMAIL_SEED_1_PASS || String(),
  },
  {
    email: "nersodamat@gmail.com",
    name: "Nerso Mat",
    pass: process.env.GMAIL_SEED_2_PASS || String(),
  },
];

/**
 * Se o banco for novo (ex: primeiro deploy em container/Easypanel),
 * inicializa automaticamente as 11 contas da frota com início oficial em 09/10/2026.
 */
export function autoSeedFleetIfEmpty(): void {
  if (process.env.AUTO_SEED_FLEET !== "true") return;
  const count = q.get<{ n: number }>("SELECT COUNT(*) n FROM accounts")?.n ?? 0;
  if (count > 0) return;

  log(
    "autoSeed",
    "Banco novo detectado. Auto-inicializando frota de 11 contas...",
  );
  const warmupStart = new Date().toISOString();
  const now = new Date().toISOString();

  // 1. Inserir 9 caixas M365 (OAuth)
  for (const acc of M365_ACCOUNTS) {
    q.run(
      `INSERT INTO accounts (email, display_name, provider, auth_mode, group_name, smtp_host, smtp_port, smtp_user, smtp_pass,
         imap_host, imap_port, warmup_started_at, warmup_only, auto_promote, status, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      acc.email,
      acc.name,
      "m365",
      "oauth",
      "m365",
      "smtp.office365.com",
      587,
      acc.email,
      encrypt("oauth-app-auth"),
      "outlook.office365.com",
      993,
      warmupStart,
      0,
      1,
      "warming",
      now,
    );
  }

  // 2. Inserir 2 sementes Gmail (App Passwords)
  for (const s of GMAIL_SEEDS) {
    if (!s.pass) {
      log(
        "autoSeed",
        "Semente Gmail sem credencial configurada; cadastro adiado.",
      );
      continue;
    }
    q.run(
      `INSERT INTO accounts (email, display_name, provider, auth_mode, group_name, smtp_host, smtp_port, smtp_user, smtp_pass,
         imap_host, imap_port, warmup_started_at, warmup_only, auto_promote, status, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      s.email,
      s.name,
      "gmail",
      "password",
      "seed_gmail",
      "smtp.gmail.com",
      465,
      s.email,
      encrypt(s.pass),
      "imap.gmail.com",
      993,
      warmupStart,
      1,
      0,
      "warming",
      now,
    );
  }

  log(
    "autoSeed",
    "Frota de 11 contas inicializada com sucesso para o Dia 1 (09/10/2026)!",
  );
}
