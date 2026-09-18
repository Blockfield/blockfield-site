/**
 * Pure mapping from the controller's status.json (tools/workshop/controller.py, blockfield-modpack)
 * to what the admin panel shows about an in-progress mode switch. Kept separate from admin.astro's
 * DOM code so it is unit-testable without a browser.
 *
 * status.json fields used here (all additive; older files may lack error/errorMessage/since/deadline):
 * phase, gate, error (exception class name, ERROR only), errorMessage (human text; also set on the
 * profile a stuck switch rolled back to), since (ms, last phase change), deadline (ms, only present
 * while a DRAINING/STARTING wait is actively ticking), desired.profile.
 */

export type ControllerStatus = {
  phase?: string;
  error?: string | null;
  errorMessage?: string | null;
  since?: number | null;
  deadline?: number | null;
  desired?: { profile?: string } | null;
} | null | undefined;

export type SwitchView = {
  /** A switch is actively running (REQUESTED/DRAINING/SAVING/STARTING). */
  busy: boolean;
  /** Plain-words current step, only set while busy. */
  step: string | null;
  /** Ms timestamp the current phase started, for an "X назад" label. Null if unknown. */
  since: number | null;
  /** Ms timestamp of the automatic rollback, only while one is actively counting down. */
  deadline: number | null;
  /** Whether an unprivileged "cancel" request would be accepted right now. */
  canCancel: boolean;
  /** Human-readable failure, only set while phase is ERROR. */
  errorMessage: string | null;
  /** One-line "why the switch didn't happen", shown once a stuck switch rolled back to a stable profile. */
  notice: string | null;
};

const TARGET_LABEL: Record<string, string> = { game: 'игровой режим', workshop: 'мастерскую', test: 'тестовый режим' };
const BUSY_STEP: Record<string, string> = { REQUESTED: 'Готовим переключение', DRAINING: 'Ждём конца матчей', SAVING: 'Сохраняем мир' };
const BUSY_PHASES = new Set(['REQUESTED', 'DRAINING', 'SAVING', 'STARTING']);
const STABLE_PHASES = new Set(['game', 'workshop', 'test']);
const CANCELLABLE_PHASES = new Set(['DRAINING', 'STARTING']);

const ms = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
const text = (value: unknown): string | null => typeof value === 'string' && value ? value : null;

export function switchView(state: ControllerStatus): SwitchView {
  const phase = typeof state?.phase === 'string' ? state.phase : null;
  const busy = phase !== null && BUSY_PHASES.has(phase);
  const target = state?.desired?.profile ? TARGET_LABEL[state.desired.profile] ?? null : null;
  const errorMessage = text(state?.errorMessage);
  return {
    busy,
    step: !busy ? null : phase === 'STARTING' ? `Запускаем ${target ?? 'сервер'}` : BUSY_STEP[phase!] ?? 'Переключаемся',
    since: busy ? ms(state?.since) : null,
    deadline: busy ? ms(state?.deadline) : null,
    canCancel: phase !== null && CANCELLABLE_PHASES.has(phase),
    errorMessage: phase === 'ERROR' ? errorMessage : null,
    notice: phase !== null && STABLE_PHASES.has(phase) && errorMessage ? `Переключение не состоялось: ${errorMessage}` : null,
  };
}
