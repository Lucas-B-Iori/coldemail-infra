import { tickInbox } from './inbox/monitor.ts';
import { tickDispatch } from './outreach/dispatcher.ts';
import { validateSequences } from './outreach/sequences.ts';
import { tickWarmup } from './warmup/worker.ts';
import { errMsg, log } from './lib/util.ts';
import { q } from './db/index.ts';
import { config } from './config.ts';

import { startDashboard } from './dashboard/server.ts';

type Job = { name: string; everyMs: number; fn: () => Promise<void>; running: boolean };

/** Agenda um job com proteção contra sobreposição: se o tick anterior ainda roda, pula. */
function schedule(jobs: Job[]): NodeJS.Timeout[] {
  return jobs.map((j) => {
    const run = async () => {
      if (j.running) return;
      j.running = true;
      try {
        await j.fn();
      } catch (e) {
        log(j.name, `ERRO no tick: ${errMsg(e)}`);
      } finally {
        j.running = false;
      }
    };
    void run();
    return setInterval(run, j.everyMs);
  });
}

export async function runEngine(): Promise<void> {
  const problems = validateSequences();
  if (problems.length) {
    console.error('Sequências inválidas (corrija antes de iniciar):\n - ' + problems.join('\n - '));
    process.exit(1);
  }
  if (!config.llm.apiKey) log('engine', 'AVISO: LLM_API_KEY vazia — o warm-up não consegue gerar mensagens.');
  const n = q.get<{ n: number }>(`SELECT COUNT(*) n FROM accounts WHERE status IN ('warming','active')`)!.n;
  log('engine', `iniciado | ${n} caixa(s) em operação | cold ${config.sendWindow.start}h-${config.sendWindow.end}h | Ctrl+C para parar`);

  // Inicia painel visual na porta 3000
  try {
    startDashboard();
  } catch (e) {
    log('dashboard', `Aviso ao iniciar dashboard: ${errMsg(e)}`);
  }

  const timers = schedule([
    { name: 'warmup', everyMs: 30_000, fn: tickWarmup, running: false },
    { name: 'dispatch', everyMs: 20_000, fn: tickDispatch, running: false },
    { name: 'inbox', everyMs: 60_000, fn: tickInbox, running: false },
  ]);

  await new Promise<void>((resolve) => {
    const stop = () => {
      log('engine', 'encerrando...');
      timers.forEach(clearInterval);
      resolve();
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
  // itens 'sending' órfãos voltam para a fila na próxima execução
  q.run(`UPDATE outreach_queue SET status='queued' WHERE status='sending'`);
}
