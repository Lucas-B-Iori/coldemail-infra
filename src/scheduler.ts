import { tickInbox } from "./inbox/monitor.ts";
import { tickDispatch } from "./outreach/dispatcher.ts";
import { validateSequences } from "./outreach/sequences.ts";
import { tickWarmup } from "./warmup/worker.ts";
import { errMsg, log } from "./lib/util.ts";
import { q, tx, addLog } from "./db/index.ts";
import { config } from "./config.ts";

import { startDashboard } from "./dashboard/server.ts";
import { runMaintenance } from "./operations.ts";

type Job = {
  name: string;
  everyMs: number;
  fn: () => Promise<void>;
  running: boolean;
};

/** Agenda um job com proteção contra sobreposição: se o tick anterior ainda roda, pula. */
function schedule(
  jobs: Job[],
  inFlight: Set<Promise<void>>,
  stopped: () => boolean,
): NodeJS.Timeout[] {
  return jobs.map((j) => {
    const run = async () => {
      if (stopped() || j.running) return;
      j.running = true;
      try {
        await j.fn();
      } catch (e) {
        log(j.name, `ERRO no tick: ${errMsg(e)}`);
      } finally {
        j.running = false;
      }
    };
    const launch = () => {
      const task = run();
      inFlight.add(task);
      void task.finally(() => inFlight.delete(task));
    };
    launch();
    return setInterval(launch, j.everyMs);
  });
}

export async function runEngine(): Promise<void> {
  recoverUncertainDeliveries();
  const problems = validateSequences();
  if (problems.length) {
    console.error(
      "Sequências inválidas (corrija antes de iniciar):\n - " +
        problems.join("\n - "),
    );
    process.exit(1);
  }
  if (!config.llm.apiKey)
    log(
      "engine",
      "AVISO: LLM_API_KEY vazia — o warm-up não consegue gerar mensagens.",
    );
  const n = q.get<{ n: number }>(
    `SELECT COUNT(*) n FROM accounts WHERE status IN ('warming','active')`,
  )!.n;
  log(
    "engine",
    `iniciado | ${n} caixa(s) em operação | cold ${config.sendWindow.start}h-${config.sendWindow.end}h | Ctrl+C para parar`,
  );

  // Inicia painel visual na porta 3000
  let dashboard: ReturnType<typeof startDashboard> | undefined;
  try {
    dashboard = startDashboard();
  } catch (e) {
    log("dashboard", `Aviso ao iniciar dashboard: ${errMsg(e)}`);
  }

  let stopping = false;
  const inFlight = new Set<Promise<void>>();
  const timers = schedule(
    [
      {
        name: "operations",
        everyMs: 300_000,
        fn: runMaintenance,
        running: false,
      },
      { name: "warmup", everyMs: 30_000, fn: tickWarmup, running: false },
      { name: "dispatch", everyMs: 20_000, fn: tickDispatch, running: false },
      { name: "inbox", everyMs: 60_000, fn: tickInbox, running: false },
    ],
    inFlight,
    () => stopping,
  );

  await new Promise<void>((resolve) => {
    const stop = () => {
      if (stopping) return;
      stopping = true;
      log("engine", "encerrando...");
      timers.forEach(clearInterval);
      resolve();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  await Promise.allSettled([...inFlight]);
  if (dashboard)
    await new Promise<void>((resolve) => dashboard!.close(() => resolve()));
  recoverUncertainDeliveries();
}

export function recoverUncertainDeliveries(): void {
  tx(() => {
    for (const row of q.all<{
      id: number;
      lead_id: number;
      account_id: number;
      message_id: string | null;
    }>(`SELECT * FROM outreach_queue WHERE status='sending'`)) {
      q.run(
        `UPDATE outreach_queue SET status='failed',error_log='delivery_uncertain: interrupted SMTP claim' WHERE id=?`,
        row.id,
      );
      q.run(
        `UPDATE leads SET status='finished',next_due_at=NULL,notes='delivery_uncertain: reconcile persisted Message-ID before resend' WHERE id=? AND status IN ('queued','sent')`,
        row.lead_id,
      );
      addLog({
        account_id: row.account_id,
        lead_id: row.lead_id,
        queue_id: row.id,
        kind: "error",
        event: "delivery_uncertain",
        detail: row.message_id ?? "legacy claim without Message-ID",
        action: "automatic resend cancelled",
      });
    }
    for (const row of q.all<{
      message_id: string;
      account_id: number;
      thread_id: number | null;
    }>(`SELECT * FROM warmup_deliveries WHERE status='sending'`)) {
      q.run(
        `UPDATE warmup_deliveries SET status='failed',error_log='delivery_uncertain' WHERE message_id=?`,
        row.message_id,
      );
      if (row.thread_id)
        q.run(
          `UPDATE warmup_threads SET status='closed',next_actor_id=NULL,reply_due_at=NULL WHERE id=?`,
          row.thread_id,
        );
      addLog({
        account_id: row.account_id,
        kind: "error",
        event: "delivery_uncertain",
        detail: row.message_id,
        action: "warmup interrupted; manual reconciliation",
      });
    }
  });
}
