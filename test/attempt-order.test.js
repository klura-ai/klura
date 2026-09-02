import assert from 'node:assert/strict';
import test from 'node:test';
import { AttemptOrderError, AttemptOrderV1 } from '../dist/consumer/scrape/attempt-order.js';

test('attempt ordering releases durable commits in allocated order', async () => {
  const order = new AttemptOrderV1();
  const first = order.allocate();
  const second = order.allocate();
  let secondReleased = false;
  const waitingSecond = order.waitForTurn(second).then(() => {
    secondReleased = true;
  });

  await Promise.resolve();
  assert.equal(secondReleased, false);
  await order.waitForTurn(first);
  order.releaseTurn(first);
  await waitingSecond;
  assert.equal(secondReleased, true);
  order.releaseTurn(second);
});

test('attempt ordering rejects an unallocated or out-of-turn commit', () => {
  const order = new AttemptOrderV1();
  const first = order.allocate();
  const second = order.allocate();

  assert.throws(() => order.waitForTurn(2), AttemptOrderError);
  assert.throws(() => order.releaseTurn(second), AttemptOrderError);
  order.releaseTurn(first);
  order.releaseTurn(second);
});

test('attempt ordering rejects waiters when one attempt aborts', async () => {
  const order = new AttemptOrderV1();
  const first = order.allocate();
  const second = order.allocate();
  const reason = new Error('caller crashed');
  const waitingSecond = order.waitForTurn(second);

  order.abort(reason);

  await assert.rejects(waitingSecond, (error) => error === reason);
  await assert.rejects(order.waitForTurn(first), (error) => error === reason);
});
