import test from 'node:test';
import assert from 'node:assert/strict';
import { update, inflate, composite, initial } from '../src/lib/glicko2.ts';

test('matches the worked example from Glickman (2012)', () => {
  const next = update({ rating: 1500, rd: 200, volatility: 0.06 }, [
    { opponent: { rating: 1400, rd: 30 }, score: 1 },
    { opponent: { rating: 1550, rd: 100 }, score: 0 },
    { opponent: { rating: 1700, rd: 300 }, score: 0 },
  ]);
  assert.ok(Math.abs(next.rating - 1464.06) < 0.05, `rating ${next.rating}`);
  assert.ok(Math.abs(next.rd - 151.52) < 0.05, `rd ${next.rd}`);
  assert.ok(Math.abs(next.volatility - 0.05999) < 0.0001, `volatility ${next.volatility}`);
});

test('win raises, loss lowers, draw between equals keeps rating and shrinks RD', () => {
  const opponent = { rating: 1500, rd: 350 };
  assert.ok(update(initial(), [{ opponent, score: 1 }]).rating > 1500);
  assert.ok(update(initial(), [{ opponent, score: 0 }]).rating < 1500);
  const draw = update(initial(), [{ opponent, score: 0.5 }]);
  assert.ok(Math.abs(draw.rating - 1500) < 1e-9);
  assert.ok(draw.rd < 350);
});

test('idle periods grow RD up to the initial value; composite uses mean rating and RMS RD', () => {
  const settled = { rating: 1600, rd: 60, volatility: 0.06 };
  assert.ok(inflate(settled, 10).rd > 60);
  assert.equal(inflate({ ...settled, rd: 349 }, 10_000).rd, 350);
  const opp = composite([{ rating: 1400, rd: 30, volatility: 0.06 }, { rating: 1600, rd: 40, volatility: 0.06 }]);
  assert.equal(opp.rating, 1500);
  assert.ok(Math.abs(opp.rd - Math.sqrt((900 + 1600) / 2)) < 1e-9);
  assert.throws(() => composite([]));
});
