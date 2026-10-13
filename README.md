# Cold Outreach & Warm-up Engine (Dendrix)

> Atualização de confiabilidade de 13/10/2026: consulte [OPERACAO.md](OPERACAO.md) para o comportamento atual, acesso ao painel, dias saudáveis, testes e backup. As seções antigas abaixo registram a implementação anterior; datas de promoção e afirmações sobre OAuth sem suporte foram substituídas.

Motor próprio, local/VPS, **Node.js 22+ / TypeScript**, SQLite embutido. Sem SaaS, sem Apps Script.

## Por que esta stack
| Critério | Escolha | Motivo |
|---|---|---|
| Linguagem | Node.js + TypeScript | I/O assíncrono nativo: 8 (ou 500) caixas em paralelo sem Celery/Redis/threads. Um único processo. |
| SMTP / IMAP | `nodemailer` + `imapflow` + `mailparser` | `imapflow` é moderno (async/await, mantido); `imap-simple` está abandonado. |
| Banco | `node:sqlite` (nativo) | Zero dependência nativa para compilar no Windows; WAL; migra para Postgres trocando só `src/db`. |
| Agendamento | loops com guarda de sobreposição + `next_*_at` no banco | Sobrevive a restart: o estado do relógio de cada caixa está no banco, não na memória. |
| LLM | `fetch` em API compatível com OpenAI | DeepSeek, Qwen, Moonshot, OpenRouter: troque só `.env`. |

## Estrutura
```
src/
  config.ts            # .env, janelas, rampas, jitter
  cli.ts               # TODA a gestão (contas, leads, sequências, status)
  scheduler.ts         # liga os 3 loops: warmup(30s) dispatch(20s) inbox(60s)
  db/schema.sql        # DDL completo
  db/index.ts          # sqlite + logs
  accounts/            # accounts.ts (CRUD, virada de dia, disjuntores) · ramp.ts (21 dias + rampa cold)
  email/               # smtp.ts (nodemailer, classificação de erro) · imap.ts (flags, spam rescue, leitura)
  llm/                 # client.ts · warmupPrompts.ts (prompts + validação)
  warmup/worker.ts     # teia humanizada: iniciar conversas + responder com jitter 8–35 min
  outreach/            # templates.ts (spintax + lint) · sequences.ts (cadências) · leads.ts · planner.ts · dispatcher.ts
  inbox/               # parse.ts (bounce/DSN/auto-reply/opt-out) · monitor.ts (poll IMAP + circuit breaker)
```

## Como funciona (resumo)
- **Warm-up:** cada caixa `warming`/`active` recebe uma meta diária (3–5 → 10–15 → 20–30; 6–10 em manutenção depois do dia 21).
  Conversas são iniciadas espalhadas pela janela. O destinatário, após 8–35 min aleatórios, conecta por IMAP, acha a mensagem
  (se estiver no Spam/Junk, **move para a Inbox**), marca `\Seen`, 20% `\Flagged`, e responde com `Re:`, `In-Reply-To` e `References`.
  Textos 100% gerados pela LLM, validados (2–5 frases, sem link/promo) e regerados se reprovarem.
- **Cold:** caixa `active` (auto-promovida no dia 22). Limite diário 45 → 60 → 70–80. Cada caixa tem seu relógio:
  intervalo ≈ (tempo restante da janela ÷ cota restante) ± 90s, piso de 3 min. Só seg–sex, 08h–18h.
- **Follow-up:** o `planner` dá prioridade a follow-ups vencidos sobre leads novos (então 80/dia = mistura). Follow-up sai da
  **mesma caixa** e na **mesma thread**. Resposta, bounce ou opt-out ⇒ o lead sai da cadência e a fila dele é cancelada
  (revalidado no último segundo antes de enviar).
- **Circuit breaker:** > 3 bounces/dia ⇒ caixa pausada + fila devolvida ao pool. Também pausa em falha de autenticação e 5 erros seguidos.
- **Caixa banida/queimada:** `accounts ban` ou `accounts replace` ⇒ leads dela são redistribuídos automaticamente.

## Comandos (gestão em escala)
Seletores de conta: `<email|id>`, `--ids 1,2,3`, `--group nome`, `--status paused`, `--all`.
```
npm run cli -- accounts add x@gmail.com --password "abcd efgh ijkl mnop" --name "Marcos Almeida" --group gmail-a
npm run cli -- accounts import examples/accounts.csv       # 500 contas = 1 CSV
npm run cli -- accounts test --all                          # valida IMAP+SMTP
npm run cli -- accounts list --group gmail-a
npm run cli -- accounts pause|resume|ban --group gmail-a --reason "motivo"
npm run cli -- accounts set-limit 50 --group outlook-a      # trava limite (ou "auto")
npm run cli -- accounts set-group novo-grupo --ids 4,5
npm run cli -- accounts replace old@gmail.com new@gmail.com --password "..."
npm run cli -- status [--group g] [--status s] [--json]

npm run cli -- leads import leads.csv --list advogados-sp --sequence dendrix_main
npm run cli -- leads list --status replied
npm run cli -- leads set fulano@x.com --status call --reason "ligar terça"
# respondeu e sumiu há 7+ dias -> cadência de reativação / lista de ligação manual
npm run cli -- leads move --status replied --older-than-days 7 --sequence dendrix_nurture --to-list nurture
npm run cli -- leads move --status replied --older-than-days 7 --set-status call --to-list ligacao

npm run cli -- sequences            # lista passos
npm run cli -- sequences validate   # lint (30 renders/passo)
npm run cli -- preview --step 2     # vê o e-mail sem enviar
npm run cli -- logs --account 3
npm run cli -- llm-test             # testa geração do warm-up
npm start                           # liga o motor
```
Status dos leads: `pending` `queued` `sent` (em cadência) `replied` `bounced` `unsubscribed` `finished` `nurture` `call`.

## Checklist para rodar hoje à noite
1. `npm install` (já feito) e `copy .env.example .env`.
2. Edite `.env`: `ENCRYPTION_KEY` (frase longa; **faça backup**), `LLM_API_KEY` (DeepSeek), `SIGNATURE_ROLE`, `SIGNATURE_PHONE`.
3. Em cada caixa Gmail: ative 2FA → gere **Senha de app** (IMAP já vem habilitado). Outlook/Hotmail: ative 2FA → senha de app e IMAP.
4. Preencha `examples/accounts.csv` (copie p/ `accounts.csv`) e rode: `npm run cli -- init` → `accounts import accounts.csv`.
5. `npm run cli -- accounts test --all` → todas devem mostrar `IMAP ✓ | SMTP ✓`. Corrija as que falharem **antes** de seguir.
6. `npm run cli -- llm-test` → confira que os 3 e-mails saem naturais.
7. `npm run cli -- preview --step 1` e revise a copy; ajuste a assinatura. Importe a lista de leads (`leads import`).
8. `npm start` (deixe o terminal/VPS ligado 24/7; em VPS use `pm2 start "npm start" --name engine`).
9. No dia seguinte: `npm run cli -- status` e `logs`. Rotina diária: olhar `leads list --status replied` e responder manualmente.

> A partir do dia 22 o cold começa sozinho. Se o `leads import` já foi feito, ele só dispara depois da promoção. Para testar o cold antes, adicione UMA conta teste com `--day 26`.

## Playbook de copy (síntese da pesquisa — praticantes, não docs oficiais)
Fontes de referência: Josh Braun ("poke the bear"), Alex Berman, Eric Nowoslawski (Growth Engine X), posts de Instantly/Smartlead/Zapmail
e conteúdo BR de Growth Machine, Ramper e Agendor. **Não consegui assistir aos vídeos** — são resumos de artigos; valide
as táticas com seus próprios números.
1. **Lista > copy.** ~70% do resultado vem do ICP e da qualidade do e-mail (verifique antes de enviar). Bounce < 2%.
2. **Curto como mensagem de WhatsApp:** 50–100 palavras (o toque 1 pronto tem 87), 1 ideia, 1 CTA.
3. **Primeira linha sobre o prospect**, nunca "meu nome é X e trabalho na Y".
4. **Pergunta neutra ("poke the bear")** em vez de pitch: "como você controla prazos hoje?" faz o advogado perceber o gap sozinho.
5. **CTA de baixa fricção:** "basta responder este e-mail" > "agende no link". Evite "teria interesse?" (resposta fácil de "não").
6. **Assunto curto, minúsculo, parecendo interno** ("pergunta rápida sobre prazos"), 2–5 palavras, sem clickbait.
7. **Sem link, sem imagem, sem HTML no toque 1.** Só texto e assinatura simples.
8. **Follow-ups com ângulo novo** (prazo → tempo operacional → facilidade) e nunca "só passando para ver se viu". 4–5 toques
   em ~3 semanas; **break-up** no último (costuma ser o que mais gera resposta).
9. **Pare ao responder** e sempre ofereça opt-out (LGPD, legítimo interesse B2B) — já está nos templates.
10. **Tom sóbrio** (OAB, Provimento 205/2021): sem promessa de resultado, sem "oferta imperdível".
11. **Teste A/B por tempo:** mude 1 variável por vez (assunto OU CTA) e compare taxa de resposta por 200+ envios. Os `{a|b}` (spintax) já variam o texto entre leads e ajudam contra fingerprint.
12. **Personalização real melhora muito:** adicione colunas ao CSV (área de atuação, cidade) e crie variáveis em `templates.ts`. Ex.: "vi que o {{firm_name}} atua em {{area}}…".

Edite as cadências em `src/outreach/sequences.ts` (ou direto na tabela `sequence_steps`) — textos são spintax: `{opção A|opção B}`.

## Riscos e limitações (leia)
- **Contas gratuitas para cold email violam os termos de uso** do Google e da Microsoft; espere suspensões. O desenho assume contas descartáveis.
  Gmail free envia no máx. ~500/dia e Outlook.com bem menos — 70–80/dia é viável, mas é onde o risco cresce.
- **Outlook/Hotmail:** a Microsoft vem restringindo autenticação básica (IMAP/SMTP) em contas pessoais. Rode `accounts test` antes de contar com elas;
  se falhar, a alternativa é OAuth2 (não implementado) ou usar só Gmail.
- **Remetente-assinatura:** como todas as caixas enviam como pessoas diferentes, a assinatura usa o `display_name` de cada conta + cargo/telefone comuns do `.env`.
- Warm-up entre contas do mesmo operador é detectável em escala; o motor mitiga (volume progressivo, jitter, spam rescue, threads multi-turno, textos únicos).
- Recomendação futura: domínio próprio com SPF/DKIM/DMARC dá entregabilidade e controle muito melhores do que contas free.
- A `Message-ID` é definida por nós; se o provedor reescrevê-la, a busca por ela falha: o motor tenta 3x, depois registra `not_found` e responde mesmo assim (sem marcar lido). Se isso aparecer no Outlook, o próximo passo é buscar por assunto+remetente.
- Validar na prática: reconhecimento de bounces depende do formato do DSN de cada provedor (testei o parser com um DSN do Gmail simulado).

## Microsoft 365 (`synapzeai.net`, 9 caixas)

**Estado medido em 08/10/2026 com `npm run verify`:** SMTP com senha 8/9 ✓ (lionel@ com SMTP AUTH desligado); IMAP 0/9
(`Login is disabled`). O Exchange Online não aceita senha em IMAP desde 2022, e a Microsoft planeja desligar o SMTP AUTH
com senha por padrão no fim de dezembro de 2026. Por isso o caminho de produção é **OAuth2**.

### Setup OAuth2 (uma vez, ~15 min)
1. **Entra ID > Registros de aplicativo > Novo** (locatário único). Anote *Tenant ID* e *Client ID*.
2. **Certificados e segredos > Novo segredo do cliente** → copie o **Valor** (não o ID).
3. **Permissões de API > Adicionar > APIs que minha organização usa > Office 365 Exchange Online > Permissões de aplicativo**:
   `IMAP.AccessAsApp` e `SMTP.SendAsApp` → **Conceder consentimento do administrador**.
4. **Aplicativos empresariais > (seu app)** → copie o **Object ID** (é diferente do registro!).
5. PowerShell: `.\scripts\m365-setup.ps1 -AppId <ClientID> -EnterpriseAppObjectId <ObjectID>` (registra o app no Exchange,
   dá permissão nas 9 caixas, liga IMAP e libera SMTP AUTH por caixa — isso também corrige a `lionel@`).
6. Preencha `M365_TENANT_ID`, `M365_CLIENT_ID`, `M365_CLIENT_SECRET` no `.env`.
7. `npm run cli -- accounts set-auth oauth --group m365` (SMTP via OAuth; o IMAP do M365 já usa OAuth sempre) e `npm run verify`.

Caixa nova no futuro: adicione no CSV/`accounts add --provider m365`, inclua o e-mail no `.ps1` e rode de novo.

### Throttling do M365
`451 4.7.500 Server busy` e `550 5.7.708 Access denied` colocam a caixa em **cooldown** com backoff exponencial
(30→60→120… min, máx 6 h; `5.7.708` começa em 2 h, máx 12 h). Leads novos da fila dela voltam ao pool e outra caixa saudável os pega;
follow-ups esperam a mesma caixa (para manter a thread). Veja em `logs --account N` (evento `cooldown`).

### Config extra
`DAILY_CAP` (teto global por caixa/dia), `COLD_INTERVAL_MIN_SEC` / `COLD_INTERVAL_MAX_SEC` / `COLD_JITTER_SEC`,
`SEND_HTML=true` para enviar multipart (texto + HTML simples, sem tabelas/rastreadores). Padrão: texto puro.
