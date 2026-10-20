import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { q } from '../db/index.ts';
import { config, WARMUP_DAYS } from '../config.ts';
import { daysBetweenLocal, localDate, nowIso } from '../lib/util.ts';
import { parseCsv } from '../lib/csv.ts';
import { importLeads } from '../outreach/leads.ts';
import { getAccount } from '../accounts/accounts.ts';
import type { Account } from '../accounts/accounts.ts';

const PORT = parseInt(process.env.PORT || '3000', 10);

export function startDashboard(port = PORT): http.Server {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const method = req.method || 'GET';

    // CORS headers para testes locais ou Vercel
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // Rotas da API REST
    if (url.pathname === '/api/stats') {
      const accounts = q.all<Account>('SELECT * FROM accounts ORDER BY id');
      const leadsSummary = q.all<{ status: string; count: number }>(
        'SELECT status, COUNT(*) count FROM leads GROUP BY status',
      );
      const totalLeads = q.get<{ count: number }>('SELECT COUNT(*) count FROM leads')!.count;
      const today = new Date();

      const fleet = accounts.map((a) => {
        const warmupDay = a.warmup_started_at ? daysBetweenLocal(a.warmup_started_at, today) + 1 : 1;
        return {
          id: a.id,
          email: a.email,
          displayName: a.display_name,
          provider: a.provider,
          authMode: a.auth_mode,
          status: a.status,
          warmupOnly: Boolean(a.warmup_only),
          warmupDay: Math.min(warmupDay, WARMUP_DAYS),
          warmupSentToday: a.warmup_sent_today,
          warmupTargetToday: a.warmup_target_today,
          coldSentToday: a.sent_today,
          dailyLimit: a.daily_limit,
          cooldownUntil: a.cooldown_until,
          errors: a.consecutive_errors,
        };
      });

      const stats = {
        totalAccounts: accounts.length,
        totalLeads,
        leadsByStatus: Object.fromEntries(leadsSummary.map((s) => [s.status, s.count])),
        coldSentToday: accounts.reduce((acc, a) => acc + a.sent_today, 0),
        warmupSentToday: accounts.reduce((acc, a) => acc + a.warmup_sent_today, 0),
        fleet,
      };

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(stats));
      return;
    }

    if (url.pathname === '/api/leads') {
      const status = url.searchParams.get('status');
      const limit = parseInt(url.searchParams.get('limit') || '50', 10);
      const search = url.searchParams.get('search') || '';

      let query = 'SELECT * FROM leads';
      const params: (string | number)[] = [];
      const where: string[] = [];

      if (status) {
        where.push('status = ?');
        params.push(status);
      }
      if (search) {
        where.push('(name LIKE ? OR firm_name LIKE ? OR email LIKE ?)');
        params.push(`%${search}%`, `%${search}%`, `%${search}%`);
      }

      if (where.length) query += ' WHERE ' + where.join(' AND ');
      query += ' ORDER BY id DESC LIMIT ?';
      params.push(limit);

      const rows = q.all(query, ...params);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(rows));
      return;
    }

    if (url.pathname === '/api/inbox') {
      const replied = q.all(
        `SELECT l.*, a.email as assigned_email
         FROM leads l
         LEFT JOIN accounts a ON a.id = l.assigned_account_id
         WHERE l.status IN ('replied', 'call', 'nurture')
         ORDER BY l.replied_at DESC`,
      );
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(replied));
      return;
    }

    if (url.pathname === '/api/logs') {
      const logs = q.all(
        `SELECT b.*, a.email, l.name as lead_name
         FROM bounces_and_logs b
         LEFT JOIN accounts a ON a.id = b.account_id
         LEFT JOIN leads l ON l.id = b.lead_id
         ORDER BY b.id DESC LIMIT 60`,
      );
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(logs));
      return;
    }

    if (url.pathname === '/api/import' && method === 'POST') {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        try {
          const payload = JSON.parse(body) as { csvText: string; listName?: string };
          const rows = parseCsv(payload.csvText);
          const resImport = importLeads(rows, {
            list: payload.listName || 'default',
            sequence: 'site_main',
          });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, ...resImport }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }));
        }
      });
      return;
    }

    // Servir a interface HTML SPA
    if (url.pathname === '/' || url.pathname === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(renderDashboardHtml());
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  });

  server.listen(port, () => {
    console.log(`\n========================================================`);
    console.log(`  Painel de Controle ColdMail Engine (Dendrix CRM)`);
    console.log(`  Disponível em: http://localhost:${port}`);
    console.log(`========================================================\n`);
  });

  return server;
}

function renderDashboardHtml(): string {
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>ColdMail Engine • Painel de Controle</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;600&display=swap" rel="stylesheet">
  <style>
    body { font-family: 'Plus Jakarta Sans', sans-serif; background-color: #0b0f19; color: #f1f5f9; }
    .mono { font-family: 'JetBrains Mono', monospace; }
  </style>
</head>
<body class="min-h-screen flex flex-col antialiased">
  <!-- Topbar -->
  <header class="border-b border-slate-800 bg-slate-900/60 backdrop-blur sticky top-0 z-50 px-6 py-3.5 flex items-center justify-between">
    <div class="flex items-center gap-3">
      <div class="h-9 w-9 rounded-xl bg-indigo-600 flex items-center justify-center font-bold text-white shadow-lg shadow-indigo-500/20">
        ⚡
      </div>
      <div>
        <h1 class="text-base font-bold text-white tracking-tight flex items-center gap-2">
          ColdMail Engine <span class="text-xs px-2 py-0.5 rounded-full bg-indigo-500/10 text-indigo-400 border border-indigo-500/20 font-medium">Dendrix CRM</span>
        </h1>
        <p class="text-xs text-slate-400">Motor Autônomo de Warm-up & Cold Outreach Jurídico</p>
      </div>
    </div>
    
    <div class="flex items-center gap-4">
      <div class="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-xs font-semibold">
        <span class="h-2 w-2 rounded-full bg-emerald-400 animate-pulse"></span>
        11 Caixas Operando
      </div>
      <button onclick="refreshData()" class="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs font-semibold text-slate-200 transition flex items-center gap-1.5 border border-slate-700">
        <span>↻</span> Atualizar
      </button>
    </div>
  </header>

  <!-- Navegação de Abas -->
  <div class="px-6 pt-4 border-b border-slate-800/80 bg-slate-900/30 flex gap-2">
    <button onclick="switchTab('fleet')" id="tab-fleet" class="tab-btn px-4 py-2.5 text-xs font-semibold rounded-t-lg border-b-2 border-indigo-500 text-indigo-400 bg-slate-800/40 transition">
      Frota de Contas (11)
    </button>
    <button onclick="switchTab('inbox')" id="tab-inbox" class="tab-btn px-4 py-2.5 text-xs font-semibold rounded-t-lg border-b-2 border-transparent text-slate-400 hover:text-slate-200 transition flex items-center gap-1.5">
      Inbox & Copiloto IA <span id="replied-count-badge" class="px-1.5 py-0.2 rounded-full bg-emerald-500/20 text-emerald-300 text-[10px]">0</span>
    </button>
    <button onclick="switchTab('leads')" id="tab-leads" class="tab-btn px-4 py-2.5 text-xs font-semibold rounded-t-lg border-b-2 border-transparent text-slate-400 hover:text-slate-200 transition">
      Leads & Prospecção
    </button>
    <button onclick="switchTab('logs')" id="tab-logs" class="tab-btn px-4 py-2.5 text-xs font-semibold rounded-t-lg border-b-2 border-transparent text-slate-400 hover:text-slate-200 transition">
      Logs em Tempo Real
    </button>
  </div>

  <main class="flex-1 p-6 max-w-7xl w-full mx-auto space-y-6">
    <!-- Stat Cards -->
    <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
      <div class="p-4 rounded-xl bg-slate-900/60 border border-slate-800 shadow-sm">
        <span class="text-xs font-medium text-slate-400 uppercase tracking-wider">Total de Leads</span>
        <div class="mt-2 flex items-baseline justify-between">
          <span id="stat-total-leads" class="text-2xl font-bold text-white mono">0</span>
          <span class="text-xs text-slate-500">qualificados</span>
        </div>
      </div>
      <div class="p-4 rounded-xl bg-slate-900/60 border border-slate-800 shadow-sm">
        <span class="text-xs font-medium text-slate-400 uppercase tracking-wider">Warm-up Hoje (Teia)</span>
        <div class="mt-2 flex items-baseline justify-between">
          <span id="stat-warmup-today" class="text-2xl font-bold text-indigo-400 mono">0</span>
          <span class="text-xs text-slate-500">M365 ↔ Gmail</span>
        </div>
      </div>
      <div class="p-4 rounded-xl bg-slate-900/60 border border-slate-800 shadow-sm">
        <span class="text-xs font-medium text-slate-400 uppercase tracking-wider">Cold Disparados Hoje</span>
        <div class="mt-2 flex items-baseline justify-between">
          <span id="stat-cold-today" class="text-2xl font-bold text-cyan-400 mono">0</span>
          <span class="text-xs text-slate-500">dia 1 rampa</span>
        </div>
      </div>
      <div class="p-4 rounded-xl bg-slate-900/60 border border-slate-800 shadow-sm">
        <span class="text-xs font-medium text-slate-400 uppercase tracking-wider">Respostas / Copiloto</span>
        <div class="mt-2 flex items-baseline justify-between">
          <span id="stat-replies" class="text-2xl font-bold text-emerald-400 mono">0</span>
          <span class="text-xs text-slate-500">automação pausada</span>
        </div>
      </div>
    </div>

    <!-- Conteúdo Aba 1: Frota de Contas -->
    <div id="view-fleet" class="space-y-4">
      <div class="rounded-xl border border-slate-800 bg-slate-900/40 overflow-hidden shadow-sm">
        <div class="px-5 py-3.5 border-b border-slate-800 bg-slate-900/80 flex items-center justify-between">
          <h2 class="text-sm font-bold text-white">Caixas Postais Ativas no Motor</h2>
          <span class="text-xs text-slate-400">9 M365 Corporativas + 2 Gmail Sementes</span>
        </div>
        <div class="overflow-x-auto">
          <table class="w-full text-left text-xs">
            <thead class="bg-slate-800/40 text-slate-400 font-semibold border-b border-slate-800">
              <tr>
                <th class="py-3 px-4">Conta</th>
                <th class="py-3 px-4">Provedor</th>
                <th class="py-3 px-4">Função</th>
                <th class="py-3 px-4">Dia Rampa</th>
                <th class="py-3 px-4">Warm-up Hoje</th>
                <th class="py-3 px-4">Cold Hoje</th>
                <th class="py-3 px-4">Status</th>
              </tr>
            </thead>
            <tbody id="fleet-table-body" class="divide-y divide-slate-800/60 text-slate-300">
              <tr><td colspan="7" class="py-6 text-center text-slate-500">Carregando dados da frota...</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <!-- Conteúdo Aba 2: Inbox & Copiloto IA -->
    <div id="view-inbox" class="space-y-4 hidden">
      <div class="rounded-xl border border-slate-800 bg-slate-900/40 overflow-hidden shadow-sm p-5 space-y-4">
        <div class="flex items-center justify-between border-b border-slate-800 pb-3">
          <div>
            <h2 class="text-sm font-bold text-white">Oportunidades & Respostas de Advogados</h2>
            <p class="text-xs text-slate-400">Quando o lead responde, a automação é interrompida e a IA classifica a intenção em 1 de 8 categorias.</p>
          </div>
        </div>
        <div id="inbox-cards-container" class="space-y-3">
          <p class="text-xs text-slate-500 py-6 text-center">Nenhuma resposta pendente no momento.</p>
        </div>
      </div>
    </div>

    <!-- Conteúdo Aba 3: Leads -->
    <div id="view-leads" class="space-y-4 hidden">
      <div class="rounded-xl border border-slate-800 bg-slate-900/40 overflow-hidden shadow-sm p-5 space-y-4">
        <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-slate-800 pb-4">
          <div>
            <h2 class="text-sm font-bold text-white">Base de Leads Qualificados</h2>
            <p class="text-xs text-slate-400">Importação com mapeamento automático de <span class="mono text-indigo-400">controle-prospeccao.csv</span>.</p>
          </div>
          <div class="flex gap-2">
            <input type="file" id="csv-file-input" accept=".csv" class="hidden" onchange="handleFileSelect(event)">
            <button onclick="document.getElementById('csv-file-input').click()" class="px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-xs font-semibold text-white transition shadow-sm">
              + Importar CSV de Leads
            </button>
          </div>
        </div>

        <div class="overflow-x-auto">
          <table class="w-full text-left text-xs">
            <thead class="bg-slate-800/40 text-slate-400 font-semibold border-b border-slate-800">
              <tr>
                <th class="py-3 px-3">Contato</th>
                <th class="py-3 px-3">Escritório</th>
                <th class="py-3 px-3">Cidade/UF</th>
                <th class="py-3 px-3">Segmento</th>
                <th class="py-3 px-3">Fato Observado</th>
                <th class="py-3 px-3">Status</th>
                <th class="py-3 px-3">Passo</th>
              </tr>
            </thead>
            <tbody id="leads-table-body" class="divide-y divide-slate-800/60 text-slate-300">
              <tr><td colspan="7" class="py-6 text-center text-slate-500">Nenhum lead importado ainda.</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <!-- Conteúdo Aba 4: Logs -->
    <div id="view-logs" class="space-y-4 hidden">
      <div class="rounded-xl border border-slate-800 bg-slate-900/40 overflow-hidden shadow-sm p-5 space-y-3">
        <div class="flex items-center justify-between border-b border-slate-800 pb-3">
          <h2 class="text-sm font-bold text-white">Log de Atividades do Motor</h2>
          <span class="text-xs text-slate-500 mono">Últimos 60 eventos</span>
        </div>
        <div id="logs-container" class="mono text-xs text-slate-400 space-y-1.5 max-h-[500px] overflow-y-auto">
          <p class="text-slate-500">Carregando logs...</p>
        </div>
      </div>
    </div>
  </main>

  <script>
    let currentTab = 'fleet';

    function switchTab(tab) {
      currentTab = tab;
      document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.classList.remove('border-indigo-500', 'text-indigo-400', 'bg-slate-800/40');
        btn.classList.add('border-transparent', 'text-slate-400');
      });
      document.getElementById('tab-' + tab).classList.add('border-indigo-500', 'text-indigo-400', 'bg-slate-800/40');
      document.getElementById('tab-' + tab).classList.remove('border-transparent', 'text-slate-400');

      ['fleet', 'inbox', 'leads', 'logs'].forEach(t => {
        document.getElementById('view-' + t).classList.toggle('hidden', t !== tab);
      });
      refreshData();
    }

    async function refreshData() {
      try {
        const statsRes = await fetch('/api/stats');
        const stats = await statsRes.json();
        
        document.getElementById('stat-total-leads').innerText = stats.totalLeads;
        document.getElementById('stat-warmup-today').innerText = stats.warmupSentToday;
        document.getElementById('stat-cold-today').innerText = stats.coldSentToday;
        document.getElementById('stat-replies').innerText = (stats.leadsByStatus.replied || 0) + (stats.leadsByStatus.call || 0);
        document.getElementById('replied-count-badge').innerText = (stats.leadsByStatus.replied || 0) + (stats.leadsByStatus.call || 0);

        renderFleetTable(stats.fleet);

        if (currentTab === 'inbox') loadInbox();
        if (currentTab === 'leads') loadLeads();
        if (currentTab === 'logs') loadLogs();
      } catch (e) {
        console.error('Erro ao atualizar dados:', e);
      }
    }

    function renderFleetTable(fleet) {
      const tbody = document.getElementById('fleet-table-body');
      tbody.innerHTML = fleet.map(a => \`
        <tr class="hover:bg-slate-800/30 transition">
          <td class="py-3 px-4 font-semibold text-white">
            \${a.email}
            <div class="text-[11px] text-slate-500 font-normal">\${a.displayName}</div>
          </td>
          <td class="py-3 px-4">
            <span class="px-2 py-0.5 rounded text-[11px] font-medium \${a.provider === 'm365' ? 'bg-blue-500/10 text-blue-400 border border-blue-500/20' : 'bg-red-500/10 text-red-400 border border-red-500/20'}">
              \${a.provider.toUpperCase()}
            </span>
          </td>
          <td class="py-3 px-4">
            \${a.warmupOnly 
              ? '<span class="text-amber-400 text-[11px]">Semente (Warm-up Puro)</span>' 
              : '<span class="text-emerald-400 text-[11px]">Cold + Warm-up</span>'}
          </td>
          <td class="py-3 px-4 mono text-slate-300">Dia \${a.warmupDay}/21</td>
          <td class="py-3 px-4 mono text-indigo-400 font-semibold">\${a.warmupSentToday}/\${a.warmupTargetToday}</td>
          <td class="py-3 px-4 mono text-slate-300">\${a.coldSentToday}/\${a.dailyLimit}</td>
          <td class="py-3 px-4">
            <span class="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
              ATIVA ✓
            </span>
          </td>
        </tr>
      \`).join('');
    }

    async function loadInbox() {
      const res = await fetch('/api/inbox');
      const leads = await res.json();
      const container = document.getElementById('inbox-cards-container');
      if (!leads.length) {
        container.innerHTML = '<p class="text-xs text-slate-500 py-6 text-center">Nenhuma resposta pendente no momento.</p>';
        return;
      }
      container.innerHTML = leads.map(l => \`
        <div class="p-4 rounded-xl bg-slate-800/40 border border-slate-700/80 space-y-2">
          <div class="flex items-center justify-between">
            <div class="flex items-center gap-2">
              <span class="font-bold text-white text-xs">\${l.name}</span>
              <span class="text-xs text-slate-400">(\${l.firm_name || 'Advocacia'})</span>
              <span class="text-xs text-slate-500 mono">\${l.email}</span>
            </div>
            <span class="px-2 py-0.5 rounded text-[11px] font-semibold bg-indigo-500/20 text-indigo-300 border border-indigo-500/30">
              \${(l.reply_intent || 'resposta_recebida').toUpperCase()}
            </span>
          </div>
          <div class="p-3 rounded-lg bg-slate-900/60 border border-slate-800 text-xs text-slate-300 italic">
            "\${l.last_reply_snippet || 'Resposta sem prévia'}"
          </div>
          \${l.notes ? \`
            <div class="p-3 rounded-lg bg-emerald-950/20 border border-emerald-500/30 text-xs text-emerald-300">
              <strong class="text-emerald-400 block mb-1">Sugestão do Copiloto IA:</strong>
              \${l.notes}
            </div>
          \` : ''}
        </div>
      \`).join('');
    }

    async function loadLeads() {
      const res = await fetch('/api/leads?limit=50');
      const leads = await res.json();
      const tbody = document.getElementById('leads-table-body');
      if (!leads.length) {
        tbody.innerHTML = '<tr><td colspan="7" class="py-6 text-center text-slate-500">Nenhum lead importado ainda.</td></tr>';
        return;
      }
      tbody.innerHTML = leads.map(l => \`
        <tr class="hover:bg-slate-800/20 transition">
          <td class="py-2.5 px-3 font-medium text-white">\${l.name}</td>
          <td class="py-2.5 px-3 text-slate-300">\${l.firm_name || '-'}</td>
          <td class="py-2.5 px-3 text-slate-400">\${l.city_state || '-'}</td>
          <td class="py-2.5 px-3 text-slate-400">\${l.practice_area || '-'}</td>
          <td class="py-2.5 px-3 text-slate-400 truncate max-w-xs">\${l.observed_fact || '-'}</td>
          <td class="py-2.5 px-3">
            <span class="px-1.5 py-0.5 rounded text-[10px] font-medium bg-slate-800 text-slate-300 border border-slate-700">
              \${l.status}
            </span>
          </td>
          <td class="py-2.5 px-3 mono text-slate-400">Passo \${l.current_step}</td>
        </tr>
      \`).join('');
    }

    async function loadLogs() {
      const res = await fetch('/api/logs');
      const logs = await res.json();
      const container = document.getElementById('logs-container');
      if (!logs.length) {
        container.innerHTML = '<p class="text-slate-500">Nenhum log registrado ainda.</p>';
        return;
      }
      container.innerHTML = logs.map(l => \`
        <div class="flex items-start gap-3 py-1 border-b border-slate-800/40">
          <span class="text-slate-500 shrink-0">\${l.created_at.slice(11, 19)}</span>
          <span class="px-1.5 rounded text-[10px] uppercase font-semibold \${l.kind === 'error' ? 'bg-red-500/20 text-red-400' : 'bg-slate-800 text-slate-300'}">\${l.event}</span>
          <span class="text-slate-300 truncate">\${l.detail || l.action_taken || '-'}</span>
          <span class="text-slate-500 ml-auto shrink-0">\${l.email || ''}</span>
        </div>
      \`).join('');
    }

    async function handleFileSelect(event) {
      const file = event.target.files[0];
      if (!file) return;
      const text = await file.text();
      try {
        const res = await fetch('/api/import', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ csvText: text, listName: 'prospeccao_piloto' })
        });
        const data = await res.json();
        if (data.ok) {
          alert(\`Importação concluída! Adicionados: \${data.added}, Duplicados: \${data.duplicates}, Inválidos: \${data.invalid}\`);
          refreshData();
        } else {
          alert('Erro ao importar: ' + data.error);
        }
      } catch (e) {
        alert('Erro ao enviar CSV: ' + e.message);
      }
    }

    // Inicializa carregando dados
    refreshData();
    setInterval(refreshData, 10000);
  </script>
</body>
</html>`;
}
