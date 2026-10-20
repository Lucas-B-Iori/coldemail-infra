# Importação de leads (CSV)

Como importar: `npm run cli -- leads import arquivo.csv [--list nome] [--sequence site_main]` ou pelo painel (Importar CSV).
Sequência padrão: `site_main`.

## Formato
- Primeira linha é o **cabeçalho** (obrigatório). Delimitador `,` ou `;` (detectado automaticamente). UTF-8 (BOM ok).
- Campos com vírgula/ponto e vírgula devem ir entre aspas (`"4,7"`).
- Cabeçalhos não diferenciam maiúsculas/acentos/espaços (`Avaliações Maps` = `avaliacoes_maps`).
- E-mail duplicado (já no banco) é ignorado; e-mail inválido conta como inválido.

## Colunas
| coluna (aliases aceitos) | obrigatória | formato | uso na copy |
|---|---|---|---|
| `email` (`e-mail`, `email_profissional`) | **sim** | e-mail válido | destinatário |
| `empresa` (`nome_empresa`, `firm_name`, `escritorio`) | recomendada | texto | `{{business}}` no assunto |
| `contato` (`nome`, `name`) | não | nome da pessoa | `{{first_name}}`/`{{greeting}}`; vazio → "Oi, tudo bem?" |
| `segmento` (`practice_area`) | recomendada | ex.: Padaria, Salão de beleza | `{{segment}}` ("pesquisando padaria em…") |
| `cidade` (`city`) | recomendada | texto | `{{city}}`/`{{place}}` |
| `uf` (`estado`) | não | SP, RJ… | compõe `city_state` |
| `cidade_uf` (`city_state`) | não | `Campinas/SP` (alternativa a cidade+uf) | — |
| `bairro` (`neighborhood`) | não | texto | `{{neighborhood}}` (fallback de `{{place}}`) |
| `telefone` (`whatsapp`, `phone`) | não | livre | só registro |
| `instagram` | não | `@perfil` ou URL | só registro (nunca vai no e-mail) |
| `nota_maps` | não | `4,7` ou `4.7` | `{{maps_phrase}}` se nota ≥ 4,3 e ≥ 20 avaliações |
| `avaliacoes_maps` | não | inteiro | idem |
| `site_status` | recomendada | `nenhum` \| `ruim` \| `ok` | `{{site_phrase}}` |
| `pontos` (`pontuacao`, `fit_score`) | não | inteiro | prioridade/registro |
| `fonte_url` (`url_origem`, `source_url`) | não | URL | registro |
| `site` | não | URL do site atual | registro |
| `fato_observado` | **sim para envio** (COPY_MODE=ai, padrão) | 1 frase concreta e verdadeira sobre o negócio | base do e-mail único; vazio → lead vai para `needs_review` e não é enviado |
| `excluir_contato` | não | `sim`/`true`/`1` → linha ignorada | — |
| `variante`, `funcao`, `hipotese_necessidade` | não | texto | legado |

## Cabeçalho recomendado
```
email,empresa,contato,segmento,cidade,uf,bairro,telefone,instagram,nota_maps,avaliacoes_maps,site_status,pontos,fonte_url,fato_observado
```
Exemplo: `examples/leads.csv`.

# Copies prontas (toque 1 escrito à mão)

CSV: `prioridade,email,empresa,cidade,assunto,corpo` (empresa/cidade só conferência). Assunto e corpo vão **exatamente** como estão
(sem spintax, sem IA). `[ASSINATURA]` é trocado por `SIGNATURE_BLOCK` (sem ele, nada é enfileirado). Se o corpo não tiver opt-out,
é inserida uma linha antes da assinatura. Lint/promessas só geram aviso. Leads com prioridade saem primeiro (1 = primeiro).
Follow-ups (toques 2 e 3) continuam pela IA e exigem `fato_observado`.

```
npm run cli -- copies check leads.csv emails.csv      # valida os 2 CSVs, não grava
npm run cli -- leads import leads.csv                 # colunas desconhecidas são ignoradas; `variante` é guardada
npm run cli -- copies import emails.csv --dry-run     # simula
npm run cli -- copies import emails.csv
npm run cli -- copies show <email>                    # como o e-mail vai sair
```
