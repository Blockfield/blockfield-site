import test from 'node:test';
import assert from 'node:assert/strict';
import { switchView } from '../src/lib/switch-status.ts';

test('idle/stable phases: no busy, no step, no cancel', () => {
  for (const phase of ['game', 'workshop', 'test']) {
    const view = switchView({ phase, desired: { profile: phase } });
    assert.equal(view.busy, false); assert.equal(view.step, null); assert.equal(view.canCancel, false);
    assert.equal(view.since, null); assert.equal(view.deadline, null); assert.equal(view.errorMessage, null); assert.equal(view.notice, null);
  }
});

test('null/undefined/missing-field status degrades to the idle view (old status.json, or none yet)', () => {
  for (const state of [null, undefined, {}, { phase: 'UNINITIALIZED' }]) {
    const view = switchView(state);
    assert.equal(view.busy, false); assert.equal(view.canCancel, false); assert.equal(view.notice, null);
  }
});

test('DRAINING/SAVING/STARTING: busy, plain-words step, cancellable only for DRAINING/STARTING', () => {
  const draining = switchView({ phase: 'DRAINING', desired: { profile: 'workshop' }, since: 1000, deadline: 9000 });
  assert.deepEqual(draining, { busy: true, step: 'Ждём конца матчей', since: 1000, deadline: 9000, canCancel: true, errorMessage: null, notice: null });

  const saving = switchView({ phase: 'SAVING', desired: { profile: 'workshop' }, since: 1000 });
  assert.equal(saving.step, 'Сохраняем мир'); assert.equal(saving.canCancel, false, 'SAVING already stopped the old backend; only DRAINING/STARTING roll back');

  const startingWorkshop = switchView({ phase: 'STARTING', desired: { profile: 'workshop' } });
  assert.equal(startingWorkshop.step, 'Запускаем мастерскую'); assert.equal(startingWorkshop.canCancel, true);

  const startingGame = switchView({ phase: 'STARTING', desired: { profile: 'game' } });
  assert.equal(startingGame.step, 'Запускаем игровой режим');
});

test('deadline/since are only surfaced while busy, and non-positive/non-numeric values count as unknown', () => {
  assert.deepEqual(switchView({ phase: 'game', since: 1000, deadline: 2000 }), switchView({ phase: 'game' }), 'stable phase ignores timing fields');
  for (const bad of [0, -1, null, undefined, '1000', NaN]) {
    const view = switchView({ phase: 'DRAINING', since: bad, deadline: bad });
    assert.equal(view.since, null); assert.equal(view.deadline, null);
  }
});

test('ERROR: errorMessage surfaces, not busy, not cancellable', () => {
  const view = switchView({ phase: 'ERROR', error: 'RuntimeError', errorMessage: 'start of workshop timed out after 300s', desired: { profile: 'workshop' } });
  assert.equal(view.busy, false); assert.equal(view.canCancel, false);
  assert.equal(view.errorMessage, 'start of workshop timed out after 300s'); assert.equal(view.step, null); assert.equal(view.notice, null);
});

test('ERROR with no errorMessage (pre-migration status.json) degrades to null, not a crash', () => {
  assert.equal(switchView({ phase: 'ERROR', error: 'RuntimeError' }).errorMessage, null);
});

test('rollback notice: a stable phase carrying errorMessage explains why the switch did not happen', () => {
  const view = switchView({ phase: 'game', errorMessage: 'drain timed out after 620s: {...}', desired: { profile: 'game' } });
  assert.equal(view.notice, 'Переключение не состоялось: drain timed out after 620s: {...}');
  assert.equal(view.busy, false);
  assert.equal(switchView({ phase: 'game', errorMessage: null }).notice, null);
});
