import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyFixIt, statusForError } from './caseRecorder';

test('Fix-It cases are tagged by restaurant area and off-domain matches are flagged', () => {
  assert.deepEqual(classifyFixIt(['Swivel faucet aerator']), { area: 'kitchen', domain_miss: false });
  assert.deepEqual(classifyFixIt(['Planetary mixer', 'attachment hub']), { area: 'kitchen', domain_miss: false });
  assert.deepEqual(classifyFixIt(['Ceiling light fixture', 'LED bulb']), { area: 'front-of-house', domain_miss: false });
  assert.deepEqual(classifyFixIt(['Wire shelving unit']), { area: 'inventory', domain_miss: false });
  assert.deepEqual(classifyFixIt(['Electric motor armature', 'DeWalt DCD780 armature']), { area: 'other', domain_miss: true });
  assert.equal(classifyFixIt(['Boat motor armature']).domain_miss, true);
});

test('timeouts are told apart from other failures', () => {
  assert.equal(statusForError('Gemini did not respond within the configured timeout.'), 'timeout');
  assert.equal(statusForError('HTTP 500: boom'), 'failed');
});
