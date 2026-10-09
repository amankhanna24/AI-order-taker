import assert from 'node:assert/strict';
import test from 'node:test';
import { withinWindow } from './availability';

test('time windows', () => {
  assert.equal(withinWindow('08:00', '07:00', '11:00'), true);
  assert.equal(withinWindow('11:00', '07:00', '11:00'), false);
  assert.equal(withinWindow('23:30', '22:00', '02:00'), true);
  assert.equal(withinWindow('03:00', '22:00', '02:00'), false);
  assert.equal(withinWindow('03:00', null, null), true);
});
