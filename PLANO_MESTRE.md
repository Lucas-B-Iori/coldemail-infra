# Plano Mestre de Cold Mail Jurídico (CRM Dendrix)

> **Documento de Execução & Arquitetura Completa**  
> **Versão:** 1.0 • **Data:** 8 de outubro de 2026  
> **Meta da Frota:** 11 contas ativas (9 M365 corporativas + 2 Gmail sementes)  
> **Meta de Escala:** Rampa progressiva para **70 a 90 e-mails/dia por caixa** (630 a 810 cold e-mails/dia totais)  
> **Infraestrutura de Destino:** Repositório Git privado + VPS Hostinger + Dashboard Web

---

## 1. Princípios Inegociáveis da Operação ("O Santo Graal")

Com base na mentoria (*Hustler BR / Alex Hormozi - $100M Leads*) e na pesquisa profunda do mercado jurídico brasileiro, o motor operará sob 6 mandamentos estritos:

1. **Nunca repetir o mesmo corpo de mensagem:** A IA (OpenRouter) adaptará semanticamente cada e-mail para cada lead com base no fato observado e na hipótese de necessidade, quebrando qualquer algoritmo de similaridade (*Nilsimsa/SimHash*) dos filtros antispam.
2. **Máximo de 3 parágrafos curtos (50 a 80 palavras):** Texto limpo, sem floreios, sem parágrafos densos. Leitura instantânea no celular em menos de 5 segundos.
3. **Zero links e zero anexos no Toque 1:** Provedores (Google e Microsoft) rebaixam a reputação de e-mails frios que contêm URLs externas, rastreadores ou links de WhatsApp.
4. **Foco total no cliente (Menos você, mais o prospect):** Nunca abrir dizendo "somos uma empresa de tecnologia" ou "desenvolvi o melhor CRM". O foco é a rotina e o problema do advogado (*"Como vocês organizam a consulta de publicações junto ao acompanhamento de processos?"*).
5. **Zero "Cheiro de IA":** O prompt da LLM proíbe expressamente o uso de travessões (`—`), adjetivos inflados ("revolucionário", "inovador", "excepcional") e tom de vendedor corporativo. O texto parecerá 100% digitado manualmente por uma pessoa ocupada.
6. **Regra de Ouro da Parada Imediata:** Assim que o lead responde qualquer mensagem, a automação para no mesmo segundo. O monitor IMAP remove o lead da fila e transfere para o Copiloto de Atendimento Humano.

---

## 2. A Cadência Oficial de 3 Toques (10 Dias)

A pesquisa e os dados de entregabilidade demonstram que sequências infinitas queimam o domínio. A cadência oficial será de **3 toques estratégicos**:

* **Toque 1 (Dia 0 - Primeiro Contato):**
  * *Assunto:* Curto, sóbrio e direto (ex: `Publicações do escritório` ou `Uma dúvida sobre o escritório, {{primeiro_nome}}`).
  * *Corpo:* Pergunta sobre a rotina real de processos/publicações + constatação de dor + CTA suave pedindo permissão (*"Posso te enviar um vídeo de 90 segundos mostrando como organizamos isso?"*).
  * *Assinatura:* Apenas Nome | Dendrix (sem links de site, sem imagens).

* **Toque 2 (Dia 3 ou 4 - Concretização):**
  * *Assunto:* Responde na **mesma conversa** (`Re: [Assunto do Toque 1]`) com cabeçalhos `In-Reply-To` e `References` preservados.
  * *Corpo:* Reitera o que o vídeo mostra (cadastro de clientes, acompanhamento de prazos e publicações) para que ele possa avaliar antes de decidir se vale conversar.

* **Toque 3 (Dia 8 a 10 - Break-up Respeitoso):**
  * *Assunto:* Mantém a mesma thread (`Re:`).
  * *Corpo:* Assume que talvez não seja prioridade agora, dá a opção de encerrar o contato para não lotar a caixa e deixa a porta aberta caso o tema volte à pauta.

---

## 3. Matriz do Copiloto de Respostas (Monitor IMAP + IA)

Quando o lead responder, o monitor IMAP identificará a mensagem e a IA categorizará o conteúdo em uma das 8 ações imediatas:

| Classificação da IA | Intenção do Lead | Ação do Motor / Sugestão de Resposta |
|---|---|---|
| `manda_video` | Lead aceitou ver a demonstração | Envia link do vídeo de 90s + pergunta aberta sobre o fluxo atual |
| `quanto_custa` | Pediu preço ou condições | Informa com total transparência o valor (R$ 200/mês) e recursos inclusos |
| `vamos_marcar` | Quer conversar ou ver ao vivo | Apresenta 2 opções de horários reais (10 a 15 min) no fuso de Brasília |
| `ja_usa_outro` | Já tem software contratado | Pergunta educadamente se há alguma lacuna específica fora do sistema atual |
| `agora_nao` | Sem tempo no momento | Pergunta com respeito se faz sentido retomar em 30 ou 60 dias |
| `sem_interesse` / `opt_out` | Pediu remoção ou recusou | Marca como `unsubscribed`, agradece com brevidade e encerra definitivamente |
| `outro_responsavel` | Indicou sócio ou gestor | Registra o contato indicado e inicia abordagem direcionada |
| `out_of_office` | Resposta automática de férias/ausência | Extrai a data de retorno e reagenda o próximo passo para após essa data |

---

## 4. Engenharia do Aquecimento & Rampa até 70–90 E-mails/Dia

Para levar cada caixa postal até o volume alvo de **70 a 90 cold e-mails diários** com segurança matemática e sem bloqueio nos filtros da Microsoft:

### O Cronograma da Rampa:

```
Dias 1 a 7:   [ Warm-up Puro: 2 -> 8 emails/dia ] (Cold: 0)
Dias 8 a 14:  [ Warm-up Intermediário: 10 -> 18 emails/dia ] (Cold: 0)
Dias 15 a 21: [ Warm-up Maduro: 20 -> 28 emails/dia ] (Cold: 0)
───────────────────────────────────────────────────────────────────
Dia 22:       [ Liberação Cold: 10 cold/dia ] + 25 warmup/dia
Dia 25:       [ Aceleração: 20 cold/dia ] + 25 warmup/dia
Dia 28:       [ Aceleração: 35 cold/dia ] + 25 warmup/dia
Dia 32:       [ Aceleração: 50 cold/dia ] + 20 warmup/dia
Dia 36:       [ Meta Base: 70 cold/dia por caixa ] (630 cold/dia total)
Dia 40:       [ Escala Máxima: 90 cold/dia por caixa ] (810 cold/dia total)
```

### O Pacing Humano em Alto Volume (70 a 90 envios/dia):
* Em uma janela útil de 10 horas comerciais (das 08:30 às 18:30 = 600 minutos):
  * **Com 70 e-mails/dia:** 1 envio a cada **8,5 minutos** por caixa.
  * **Com 90 e-mails/dia:** 1 envio a cada **6,6 minutos** por caixa.
* O motor aplica **jitter aleatório de ±75 a 90 segundos** para que nunca haja repetição mecânica de intervalo.
* Como temos **9 caixas corporativas**, o sistema estará entregando cerca de **1 e-mail a cada 45 a 60 segundos na internet**, mas do ponto de vista de cada caixa individual, a cadência é perfeitamente calma, espaçada e humana.

---

## 5. Roteiro Passo a Passo de Implementação

### Fase 1: Atualização do Banco de Dados & Schema Enriquecido
- [ ] Atualizar `src/db/schema.sql` e a tabela `leads` para comportar as colunas de `controle-prospeccao.csv`:
  - `site`, `cidade_fuso`, `funcao`, `url_origem`, `segmento`, `fato_observado`, `hipotese_necessidade`, `pontuacao`, `variante`, `classificacao_resposta`, `proximo_passo`.
- [ ] Criar migração automática no SQLite para preservar os dados existentes.

### Fase 2: Importador CSV Inteligente
- [ ] Adaptar `src/lib/csv.ts` e `src/outreach/leads.ts` para detectar automaticamente delimitador `;` ou `,`.
- [ ] Mapear diretamente os cabeçalhos de `controle-prospeccao.csv` para a tabela `leads`.
- [ ] Sanitizar e validar nomes (limpar títulos excessivos, formatar nome do escritório).

### Fase 3: Motor de Copy IA Adaptativo (OpenRouter)
- [ ] Criar módulo `src/llm/copyGenerator.ts` integrando com o OpenRouter (DeepSeek / Gemini / Llama).
- [ ] Implementar os 5 modelos de base da pesquisa (Modelos A, B, C, D, E) com injeção dinâmica de contexto:
  - Fato observado + dor levantada + restrições estritas (sem travessões, 50-80 palavras, CTA suave de vídeo).
- [ ] Atualizar o gerador de follow-ups para costurar o histórico da thread.
- [ ] Atualizar o validador antispam (`lintEmail`) para barrar qualquer link ou anomalia sintática.

### Fase 4: Classificador IMAP de Respostas & Copiloto
- [ ] Integrar chamada de LLM em `src/inbox/monitor.ts` para categorizar respostas recebidas nas 8 categorias.
- [ ] Salvar a sugestão de resposta gerada pela IA na coluna `notes` / tabela de oportunidades do lead.

### Fase 5: Dashboard Web Visual de Operação
- [ ] Construir uma interface web moderna (servida localmente em `http://localhost:3000` via Express/React ou Vite):
  - **Aba Frota:** Visualização das 11 caixas (status, volume hoje, dia de aquecimento, saúde de conexão).
  - **Aba Leads & Funil:** Gráfico de funil (Pendentes → Em Cadência → Respondidos → Reuniões).
  - **Aba Inbox de Respostas:** Caixa de entrada consolidada das respostas de advogados com a classificação da IA e o botão de resposta rápida.
  - **Aba Logs:** Feed de atividade em tempo real.

### Fase 6: Versionamento Seguro no GitHub
- [ ] Configurar `.gitignore` blindado (`.env`, `data/engine.db`, logs e diretórios temporários nunca sobem).
- [ ] Criar repositório privado no GitHub.
- [ ] Realizar commit inicial limpo e push da estrutura.

### Fase 7: Deploy e Execução na VPS Hostinger
- [ ] Preparar arquivo de configuração de processo (`ecosystem.config.cjs` para PM2 ou `docker-compose.yml`).
- [ ] Configurar script de inicialização resiliente com reinício automático em caso de reboot da VPS.
- [ ] Script de backup diário do banco `data/engine.db` na VPS.
