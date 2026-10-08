import { config } from '../config.ts';

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
export const nowIso = (): string => new Date().toISOString();
export const addMs = (ms: number, from: Date = new Date()): string =>
  new Date(from.getTime() + ms).toISOString();

export const randInt = (min: number, max: number): number =>
  Math.floor(Math.random() * (max - min + 1)) + min;
export const randFloat = (min: number, max: number): number => Math.random() * (max - min) + min;
export const chance = (p: number): boolean => Math.random() < p;
export const pick = <T>(arr: readonly T[]): T => arr[Math.floor(Math.random() * arr.length)];

/** Partes da data/hora no fuso de negócio. */
function parts(d: Date) {
  const f = new Intl.DateTimeFormat('en-GB', {
    timeZone: config.tz,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(d);
  const g = (t: string) => f.find((p) => p.type === t)!.value;
  const hour = parseInt(g('hour'), 10) % 24;
  return { date: `${g('year')}-${g('month')}-${g('day')}`, hour, minute: parseInt(g('minute'), 10) };
}

export const localDate = (d: Date = new Date()): string => parts(d).date;

export function isWeekday(d: Date = new Date()): boolean {
  const w = new Intl.DateTimeFormat('en-US', { timeZone: config.tz, weekday: 'short' }).format(d);
  return w !== 'Sat' && w !== 'Sun';
}

export function minutesOfDay(d: Date = new Date()): number {
  const p = parts(d);
  return p.hour * 60 + p.minute;
}

export interface Window {
  start: number;
  end: number;
}

export function inWindow(w: Window, d: Date = new Date()): boolean {
  const m = minutesOfDay(d);
  return m >= w.start * 60 && m < w.end * 60;
}

export function msLeftInWindow(w: Window, d: Date = new Date()): number {
  return Math.max(0, (w.end * 60 - minutesOfDay(d)) * 60_000);
}

/** ISO do próximo início de janela (hoje se ainda não começou, senão amanhã). */
export function nextWindowStart(w: Window, d: Date = new Date()): string {
  const m = minutesOfDay(d);
  const target = w.start * 60;
  const deltaMin = m < target ? target - m : 24 * 60 - m + target;
  return addMs(deltaMin * 60_000, d);
}

/** Dias inteiros (calendário local) entre duas datas ISO. */
export function daysBetweenLocal(fromIso: string, to: Date = new Date()): number {
  const a = Date.parse(localDate(new Date(fromIso)) + 'T00:00:00Z');
  const b = Date.parse(localDate(to) + 'T00:00:00Z');
  return Math.round((b - a) / 86_400_000);
}

export function pLimit(n: number) {
  let active = 0;
  const queue: Array<() => void> = [];
  const next = () => {
    active--;
    queue.shift()?.();
  };
  return <T>(fn: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const run = () => {
        active++;
        fn().then(resolve, reject).finally(next);
      };
      active < n ? run() : queue.push(run);
    });
}

const inFlight = new Set<string>();
/** Lock em memória: impede duas operações simultâneas na mesma caixa. */
export function tryLock(key: string): boolean {
  if (inFlight.has(key)) return false;
  inFlight.add(key);
  return true;
}
export const unlock = (key: string): void => void inFlight.delete(key);

export function log(scope: string, msg: string): void {
  const ts = new Date().toLocaleTimeString('pt-BR', { timeZone: config.tz });
  console.log(`${ts} [${scope}] ${msg}`);
}

export const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
