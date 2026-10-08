import { WARMUP_DAYS, config } from '../config.ts';
import { randInt } from '../lib/util.ts';

/** Warm-up: faixa de e-mails/dia por caixa conforme o dia (1..21). */
export function warmupRange(day: number): [number, number] {
  if (day <= 7) return [3, 5];
  if (day <= 14) return [10, 15];
  return [20, 30];
}

/** Cold: limite diário por caixa conforme o dia (22+). Antes disso = 0. */
export function outreachLimit(day: number): number {
  if (day <= WARMUP_DAYS) return 0;
  if (day <= 22) return 10;
  if (day <= 24) return randInt(15, 20);
  if (day <= 27) return randInt(25, 35);
  if (day <= 31) return randInt(40, 50);
  if (day <= 35) return randInt(55, 65);
  // Escala plena (Dia 36 em diante): 70 a 90 cold/dia por caixa (meta da mentoria)
  return randInt(70, 90);
}

export function warmupTargetFor(day: number): number {
  const [min, max] = day <= WARMUP_DAYS ? warmupRange(day) : config.maintenance;
  return randInt(min, max);
}
