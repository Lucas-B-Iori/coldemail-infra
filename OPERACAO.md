# Operação após as correções de 13/10/2026

O motor é único e usa o SQLite no volume persistente. As nove Microsoft podem fazer cold depois da liberação; os Gmail pessoais são somente sementes de aquecimento, com bloqueio explícito no planner, dispatcher e retomada de conta.

## Aquecimento e liberação

Um dia saudável exige a meta real de envios bem-sucedidos e pelo menos uma mensagem localizada por IMAP em outro provedor e domínio. São necessários 21 dias saudáveis concluídos antes de liberar cold. Dias de calendário sem evidência não contam. O histórico interno anterior permanece no banco, mas não autoriza prospecção.

Recibos são processados por Message-ID, com atraso persistido, mesmo quando a cota de respostas da semente já terminou. Mensagem não encontrada não recebe resposta inventada. Os pares respeitam cota e reservas de respostas do destinatário; sementes saturadas não acumulam novas threads ilimitadas. Com duas sementes e nove Microsoft, a capacidade externa pode limitar a velocidade de avanço. O painel deve mostrar o progresso real; o prazo não é garantido por uma data fixa.

Cold tem rampa gradual e teto de 80 por caixa/dia. Follow-ups consomem a mesma cota dos primeiros contatos. Respostas e descadastros param a cadência antes de aguardar classificação de IA. Não há respostas comerciais automáticas: a IA sugere um rascunho para revisão humana.

## Painel protegido

Todas as páginas e APIs exigem autenticação Basic por HTTPS. Configure `DASHBOARD_USERNAME` e `DASHBOARD_PASSWORD`. Sem ambos, o painel retorna 503; credencial errada/ausente retorna 401. `/healthz` público revela somente saúde mínima, sem contas/leads.

No deploy desta VPS, os valores são guardados fora do repositório em `/app/data/runtime.env`, permissões 600. O arquivo é carregado ao iniciar. O login preparado usa o nome `lucas`. O operador pode consultar a senha no console autenticado do EasyPanel com:

```sh
cat /app/data/runtime.env
```

Não publique o conteúdo desse arquivo. Ajustes de ambiente já presentes no EasyPanel prevalecem sobre os valores do arquivo. O usuário pode escolher outra senha no ambiente e reiniciar o serviço; o assistente não precisa receber a senha no chat.

O painel mostra status real, motivo de pausa, cooldown, última atividade, progresso em dias saudáveis e distribuição interna/externna de mensagens registradas. Verde não é prova de entregabilidade; consulte a saúde e as métricas.

## Backup e alertas

O job de manutenção faz backup SQLite online diário em `/app/data/backups`, incluindo páginas comprometidas no WAL. Cada backup é aberto em modo de leitura e passa por `PRAGMA integrity_check`. O backup anterior às mudanças é `pre-repair-2026-10-13.db`.

Uma cópia da chave atual foi preservada em `/app/data/secrets/encryption-key-preserved.txt`, permissões 600. Banco e chave precisam ser preservados juntos para recuperar credenciais. Backups no mesmo volume protegem contra alterações de código/banco, mas não contra perda integral da VPS. Uma cópia externa continua dependendo de um destino de backup autorizado e configurado.

```sh
npm run backup
npm run verify
```

`verify` falha se SMTP ou IMAP necessário falhar. Não envia email. `--smtp-only` é opção explícita para testar apenas SMTP.

Pausas, falta de progresso e entrega incerta produzem alertas nos logs/painel. `ALERT_WEBHOOK_URL` é opcional; configurado pelo operador, envia notificações JSON `{ "text": "ColdMail: ..." }` e repete a tentativa em falha. Nenhum destino externo é presumido.

Para restaurar: parar o worker; manter uma cópia do estado atual; restaurar um snapshot validado com sua chave correspondente; confirmar que nenhum WAL antigo será reaplicado; verificar conexões e reiniciar. Nunca trocar `ENCRYPTION_KEY` arbitrariamente em um banco existente.

## Entrega incerta

O Message-ID é salvo antes do SMTP. Crash durante `sending` ou falha sem confirmação de aceitação gera `delivery_uncertain`. O motor bloqueia reenvio automático para evitar duplicidade. Use o identificador e o rastreamento Microsoft/IMAP para reconciliar; só então libere manualmente o lead. Um erro de rede não comprova que o destinatário não recebeu.

## Verificação e deploy

```sh
npm ci
npm test
npm run typecheck
npm audit --omit=dev
```

Os testes usam bancos temporários e transportes simulados. Scripts antigos como `scripts/test-cold-cycle.ts` enviam emails reais e não fazem parte da suíte. O script `audit/reproduce.mjs` é um registro da auditoria anterior; suas assertions descrevem bugs antigos e não é um healthcheck da versão corrigida.

Docker exclui `.env`, dados, CSV de credenciais, testes e auditorias. O bootstrap de frota nova só acontece com `AUTO_SEED_FLEET=true`, com credenciais fornecidas explicitamente; não existem senhas Gmail padrão no fonte e a data inicial é a data real do cadastro.

## Domínio

SPF observado autoriza Exchange Online. DKIM deve ser validado no Defender/Exchange e os dois CNAME corretos publicados no DNS Hostinger. Consulte:

```powershell
Get-DkimSigningConfig -Identity synapzeai.net | Format-List Enabled,Status,Selector1CNAME,Selector2CNAME
```

Não inventar valores de CNAME. Depois de publicar e ativar, confirmar `dkim=pass` e alinhamento em destinatário externo controlado. DMARC observado usa `p=none` sem `rua`; configurar destino de relatórios antes de avaliar política restritiva. O calendário de DNS e vários dias de entrega saudável são verificações externas posteriores à correção do código.
