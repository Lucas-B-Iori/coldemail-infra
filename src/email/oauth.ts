import { config } from '../config.ts';

let cached: { token: string; expiresAt: number } | null = null;

export const oauthConfigured = (): boolean =>
  !!(config.m365.tenantId && config.m365.clientId && config.m365.clientSecret);

/**
 * Token app-only (client credentials) para o Exchange Online.
 * Um único token serve IMAP (IMAP.AccessAsApp) e SMTP (SMTP.SendAsApp) de TODAS as caixas
 * autorizadas no tenant; o usuário é informado no XOAUTH2 de cada conexão.
 */
export async function getM365Token(): Promise<string> {
  if (!oauthConfigured()) {
    throw new Error('OAuth2 não configurado: defina M365_TENANT_ID, M365_CLIENT_ID e M365_CLIENT_SECRET no .env');
  }
  if (cached && cached.expiresAt - Date.now() > 120_000) return cached.token;

  const res = await fetch(`https://login.microsoftonline.com/${config.m365.tenantId}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: config.m365.clientId,
      client_secret: config.m365.clientSecret,
      scope: 'https://outlook.office365.com/.default',
    }),
    signal: AbortSignal.timeout(20_000),
  });
  const data = (await res.json()) as { access_token?: string; expires_in?: number; error_description?: string };
  if (!res.ok || !data.access_token) {
    throw new Error(`Falha ao obter token OAuth2: ${(data.error_description ?? res.statusText).split('\n')[0]}`);
  }
  cached = { token: data.access_token, expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000 };
  return cached.token;
}
