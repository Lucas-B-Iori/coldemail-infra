/**
 * Verificação inicial das caixas: handshake SMTP (transporter.verify) e login IMAP, com diagnóstico em português.
 *
 * Uso:
 *   npm run verify                 -> todas as contas do banco
 *   npm run verify -- --group m365 -> só um grupo
 *   npm run verify -- --smtp-only  -> pula o IMAP
 */
import { parseArgs } from 'node:util';
import { selectAccounts } from '../src/accounts/accounts.ts';
import type { Account } from '../src/accounts/accounts.ts';
import { verifyImap } from '../src/email/imap.ts';
import { verifySmtp } from '../src/email/smtp.ts';
import { errMsg, pLimit } from '../src/lib/util.ts';
import { oauthConfigured } from '../src/email/oauth.ts';

const { values } = parseArgs({
  strict: false,
  options: { group: { type: 'string' }, 'smtp-only': { type: 'boolean' } },
});

/** Traduz os erros mais comuns do Microsoft 365 em causa provável + o que fazer. */
function diagnose(raw: string): string {
  if (/5\.7\.139|basic authentication is disabled|SmtpClientAuthentication is disabled/i.test(raw))
    return 'SMTP AUTH desligado. Se outras caixas funcionam, é override por caixa: PowerShell `Set-CASMailbox -Identity <email> -SmtpClientAuthenticationDisabled $false` (ou Admin Center > Usuários > Email > Gerenciar aplicativos de email > "SMTP autenticado"). Se TODAS falham: tenant com SMTP AUTH off (`Set-TransportConfig -SmtpClientAuthenticationDisabled $false`) ou Security Defaults ligado.';
  if (/5\.7\.3\b|535 5\.7\.3/i.test(raw)) return 'Usuário/senha rejeitados ou conta exige MFA. Confira a senha e Security Defaults.';
  if (/5\.7\.57|not authenticated/i.test(raw)) return 'Cliente não autenticado para enviar (SMTP AUTH desligado na caixa ou no tenant).';
  if (/AADSTS7000215|invalid_client/i.test(raw)) return 'M365_CLIENT_SECRET inválido (use o VALOR do segredo, não o ID).';
  if (/AADSTS700016|AADSTS90002/i.test(raw)) return 'M365_CLIENT_ID/M365_TENANT_ID incorretos.';
  if (/Login is disabled|AUTHENTICATE failed|AUTHENTICATIONFAILED|LOGIN failed|Invalid credentials/i.test(raw))
    return 'IMAP recusou login por senha (Exchange Online só aceita OAuth2 no IMAP desde 2022). Configure o app no Entra ID e preencha M365_* no .env (README > Microsoft 365). Se o OAuth já está configurado: falta `New-ServicePrincipal` + `Add-MailboxPermission` nesta caixa, ou IMAP desativado nela (`Set-CASMailbox -ImapEnabled $true`).';
  if (/OAuth2 não configurado/i.test(raw)) return 'Preencha M365_TENANT_ID, M365_CLIENT_ID e M365_CLIENT_SECRET no .env.';
  if (/ETIMEDOUT|ECONNREFUSED|ENOTFOUND|EDNS/i.test(raw)) return 'Falha de rede (firewall bloqueando a porta 587/993?).';
  return '';
}

async function check(a: Account): Promise<{ smtp: string; imap: string }> {
  const run = async (fn: () => Promise<void>) => {
    try {
      await fn();
      return '✓ conectada com sucesso';
    } catch (e) {
      const raw = errMsg(e).replace(/\s+/g, ' ');
      const d = diagnose(raw);
      return `✗ ${raw.slice(0, 140)}${d ? `\n         → ${d}` : ''}`;
    }
  };
  return {
    smtp: await run(() => verifySmtp(a)),
    imap: values['smtp-only'] ? '(ignorado)' : await run(() => verifyImap(a)),
  };
}

const accounts = selectAccounts({ all: true, group: values.group as string | undefined }).filter((a) => a.status !== 'banned');
if (!accounts.length) {
  console.log('Nenhuma conta no banco. Rode: npm run cli -- accounts import accounts.csv');
  process.exit(1);
}
console.log(`\nVerificando ${accounts.length} conta(s)... (OAuth2 ${oauthConfigured() ? 'configurado' : 'NÃO configurado'})\n`);

let okSmtp = 0, okImap = 0;
for (const a of accounts) {
  const r = await check(a);
  if (r.smtp.startsWith('✓')) okSmtp++;
  if (r.imap.startsWith('✓')) okImap++;
  console.log(`#${a.id} ${a.email}  [${a.auth_mode}]\n   SMTP ${r.smtp}\n   IMAP ${r.imap}\n`);
}
console.log(`Resumo: SMTP ${okSmtp}/${accounts.length} | IMAP ${okImap}/${accounts.length}`);
if (okSmtp === accounts.length && !values['smtp-only'] && okImap < accounts.length)
  console.log('⚠ SMTP ok mas IMAP falhou: sem IMAP o warm-up não marca como lido e o circuit breaker de bounces fica cego.');
process.exit(okSmtp === accounts.length && (values['smtp-only'] || okImap === accounts.length) ? 0 : 1);

