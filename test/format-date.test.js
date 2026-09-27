import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatDate } from '../public/js/api.js';

// Pretend the device is set to another time zone: timestamps must still come out in Danish time.
process.env.TZ = 'America/New_York';

const at = (iso) => Date.parse(iso);

test('today shows the time on a 24-hour clock in Danish time', () => {
  const now = at('2026-09-27T20:00:00Z'); // 22:00 in Copenhagen
  assert.equal(formatDate(at('2026-09-27T12:05:00Z'), now), '14:05');
  assert.equal(formatDate(at('2026-09-27T21:59:00Z'), now), '23:59');
  assert.equal(formatDate(at('2026-09-26T22:05:00Z'), now), '00:05'); // already 27 September in Denmark
});

test('daylight saving time is followed: UTC+1 in winter, UTC+2 in summer', () => {
  assert.equal(formatDate(at('2026-01-15T13:00:00Z'), at('2026-01-15T20:00:00Z')), '14:00');
  assert.equal(formatDate(at('2026-07-15T13:00:00Z'), at('2026-07-15T20:00:00Z')), '15:00');
  // Clocks go forward at 02:00 on 29 March 2026 and back at 03:00 on 25 October 2026.
  const spring = at('2026-03-29T12:00:00Z');
  assert.equal(formatDate(at('2026-03-29T00:59:00Z'), spring), '01:59');
  assert.equal(formatDate(at('2026-03-29T01:00:00Z'), spring), '03:00');
  const autumn = at('2026-10-25T12:00:00Z');
  assert.equal(formatDate(at('2026-10-25T00:59:00Z'), autumn), '02:59');
  assert.equal(formatDate(at('2026-10-25T01:00:00Z'), autumn), '02:00');
});

test('older timestamps show the Danish date, with the year only when it differs', () => {
  const now = at('2026-09-27T10:00:00Z');
  assert.equal(formatDate(at('2026-09-26T21:30:00Z'), now), '26 Sep');
  assert.equal(formatDate(at('2026-09-25T22:30:00Z'), now), '26 Sep'); // 00:30 on 26 September in Denmark
  assert.equal(formatDate(at('2026-03-05T09:00:00Z'), now), '5 Mar');
  assert.equal(formatDate(at('2025-12-31T22:30:00Z'), now), '31 Dec 2025');
  assert.equal(formatDate(at('2025-12-31T23:30:00Z'), now), '1 Jan'); // already 2026 in Denmark
  assert.equal(formatDate(null), '');
});
