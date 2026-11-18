import { expect, test } from 'bun:test';
import { StateSchema } from '../src/domain';
import { decodeState, encodeState, SUMMARY_MARKER } from '../src/state';

const state = StateSchema.parse({ version: 1, repo: 'a/b', number: 1, headSha: 'b'.repeat(40), baseSha: 'a'.repeat(40), paused: true, fingerprints: [], events: [] });
test('state roundtrips and binds repository and PR', () => {
  const body = `${SUMMARY_MARKER}\n${encodeState(state)}`;
  expect(decodeState(body, state)).toEqual(state);
  expect(decodeState(body, { repo: 'other/repo', number: 1 })).toBeNull();
  expect(decodeState(body, { repo: 'a/b', number: 2 })).toBeNull();
});
test('rejects malformed, oversized, ambiguous and unmarked state', () => {
  expect(decodeState(encodeState(state), state)).toBeNull();
  expect(decodeState(`${SUMMARY_MARKER}\n${encodeState(state)}\n${encodeState(state)}`, state)).toBeNull();
  expect(decodeState(`${SUMMARY_MARKER}\n<!-- opencode-reviewer:state:v1:AAAA -->`, state)).toBeNull();
  expect(decodeState('x'.repeat(200001), state)).toBeNull();
  expect(() => encodeState({ ...state, events: Array.from({ length: 101 }, () => 'x') })).toThrow();
});
