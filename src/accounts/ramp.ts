import { WARMUP_DAYS, config } from '../config.ts';
import { daysBetweenLocal, localDate, randInt } from '../lib/util.ts';

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

/** true se a rampa nova (COLD_START_DATE) está configurada. */
export const coldRampEnabled = (): boolean => /^\d{4}-\d{2}-\d{2}$/.test(config.coldRamp.startDate);

/** true se hoje já é dia de cold pela rampa nova. */
export function coldStarted(now: Date = new Date()): boolean {
  return coldRampEnabled() && localDate(now) >= config.coldRamp.startDate;
}

/** Limite diário de cold pela rampa nova: start + step * floor(dias/stepDays), com teto. 0 antes do início. */
export function coldRampLimit(now: Date = new Date()): number {
  if (!coldStarted(now)) return 0;
  const { startDate, startPerDay, step, stepDays, maxPerDay } = config.coldRamp;
  const d = daysBetweenLocal(`${startDate}T12:00:00Z`, now);
  const n = startPerDay + step * Math.floor(Math.max(0, d) / stepDays);
  return maxPerDay > 0 ? Math.min(n, maxPerDay) : n;
}

/** Limite de cold do dia: rampa nova se configurada; senão a legada por dia de warm-up. */
export function coldLimitFor(day: number, now: Date = new Date()): number {
  return coldRampEnabled() ? coldRampLimit(now) : outreachLimit(day);
}
