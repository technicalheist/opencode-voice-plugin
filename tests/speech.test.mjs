import assert from 'node:assert/strict';
import test from 'node:test';
import { chunkForSpeech, cleanForSpeech, planSpeech, prepareForSpeech } from '../dist/speech.js';

test('cleans markdown, code, links, and paths', () => {
  const input = [
    '## Done',
    '',
    '- Fixed **the bug** in `src/app.ts`.',
    '- See [docs](https://example.com/x).',
    '',
    '```js',
    'const answer = 42;',
    '```',
    '',
    'Task Summary: The fix is ready.',
  ].join('\n');
  const output = cleanForSpeech(input);
  assert.equal(output, 'Done Fixed the bug in src/app.ts. See docs. Task Summary: The fix is ready.');
  assert.ok(!output.includes('const answer'));
  assert.ok(!output.includes('https://'));
});

test('removes tables, emoji, and raw html', () => {
  const output = cleanForSpeech('| a | b |\n| --- | --- |\n| 1 | 2 |\n<strong>Hello</strong> 😀');
  assert.equal(output, 'a b 1 2 Hello');
});

test('keeps short text in one chunk', () => {
  assert.deepEqual(chunkForSpeech('One short sentence.', 100), ['One short sentence.']);
});

test('splits long text at sentence boundaries', () => {
  const text = `${'A'.repeat(60)}. ${'B'.repeat(60)}. ${'C'.repeat(60)}.`;
  const chunks = chunkForSpeech(text, 70);
  assert.ok(chunks.length >= 3);
  assert.ok(chunks.every((chunk) => chunk.length <= 70));
});

test('truncates at a sentence boundary', () => {
  const text = 'First sentence. Second sentence. Third sentence.';
  assert.equal(prepareForSpeech(text, 20), 'First sentence.');
  assert.equal(prepareForSpeech(text, 40), 'First sentence. Second sentence.');
});

test('plans at most two sentences per speech chunk', () => {
  const text = 'One. Two. Three. Four. Five.';
  assert.deepEqual(planSpeech(text, 100, 2), ['One. Two.', 'Three. Four.', 'Five.']);
});

test('keeps one sentence per chunk when asked', () => {
  const text = 'First sentence. Second sentence. Third sentence.';
  assert.deepEqual(planSpeech(text, 100, 1), [
    'First sentence.',
    'Second sentence.',
    'Third sentence.',
  ]);
});

test('splits a long sentence without punctuation', () => {
  const chunks = planSpeech('word '.repeat(200), 120, 2);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => chunk.length <= 120));
});
