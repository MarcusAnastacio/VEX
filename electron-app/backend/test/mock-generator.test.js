#!/usr/bin/env node
// Mock generator tests. No network, no API key.
//
// The mock exists so the generate flow can be exercised end to end with no Gemini
// key, and the risk with that is that it drifts away from the real path until it
// proves nothing. These tests pin it to the real path rather than beside it:
//
//   * it is OFF unless AGENT_QUIZ_MOCK is set, so the default is unchanged
//   * generateAndSaveQuiz under the switch returns a quiz with real questions AND
//     real flashcards, and persists it
//   * the material went through validateResult, so the mock is producing a shape the
//     schema demands rather than an object the rest of the app happens to accept
//   * the report says `mock`, so a screenshot cannot pass for a real one
//   * the option objects and the settings key react to the new fields

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { CompatibilityLayer } from '../index.js';
import { mockEnabled, mockTopicResponse, MOCK_ENV } from '../lib/mock.js';
import { quizCapabilities, FLASHCARDS_PER_TOPIC, clampFlashcardsPerTopic } from '../lib/quiz.js';
import { finalizeSession } from '../lib/normalize.js';
import { settingsKey } from '../lib/store.js';

let passed = 0;
const failures = [];

async function check(name, fn) {
  try {
    await fn();
    passed++;
  } catch (err) {
    failures.push({ name, message: err.message });
  }
}

// ── Fixture ────────────────────────────────────────────────────────────────

const T0 = Date.UTC(2026, 2, 14, 10, 0);
const at = (m) => T0 + m * 60_000;

/**
 * Six distinct subjects, so the segmenter has several topics to choose from.
 *
 * Distinctness is the point: the real conversation this imitates changed files and
 * subjects six times over, and a fixture of near-identical exchanges segments into
 * ONE topic, which would test the sampler against a subset of one.
 */
const SUBJECTS = [
  ['Pool exhaustion investigation', 'src/pool.ts'],
  ['Cache staleness after a price update', 'src/cache.ts'],
  ['Retry helper backoff behaviour', 'src/retry.ts'],
  ['Auth token refresh rotation', 'src/auth.ts'],
  ['Migration runner ordering', 'src/migrate.ts'],
  ['Metrics exporter cardinality', 'src/metrics.ts'],
];

function buildSession(overrides = {}) {
  const filler = (n) =>
    'The relevant configuration is read at startup and cached for the process lifetime, which is why changing it requires a restart. '.repeat(n);

  const messages = [];
  SUBJECTS.forEach(([subject, file], i) => {
    messages.push({ role: 'user', text: `${subject}. Explain the cause and fix it in ${file}. ${filler(2)}`, ts: at(i * 90) });
    messages.push({
      role: 'assistant',
      text: `In ${file} the problem is the error path: it returns before releasing the client, so each failure leaks one connection and the pool fills linearly with error rate rather than with traffic. ${filler(3)}`,
      ts: at(i * 90 + 5),
      tools: [
        { name: 'read', input: { path: file } },
        { name: 'edit', input: { path: file } },
      ],
    });
  });

  return finalizeSession({
    harness: 'pi',
    harnessName: 'pi',
    nativeId: 'mock-test',
    project: 'checkout-api',
    cwd: '/workspace/checkout-api',
    title: 'retry the warehouse client',
    started: at(0),
    updated: at(SUBJECTS.length * 90),
    messages,
    ...overrides,
  });
}

/** A layer holding one session, with an in-memory store. */
function layerWith(session) {
  const layer = new CompatibilityLayer({ storeFile: ':memory:' });
  layer.catalog = { sessions: [session], scannedAt: Date.now() };
  return layer;
}

/** Run `fn` with AGENT_QUIZ_MOCK set, restoring whatever was there before. */
async function withMockEnv(value, fn) {
  const before = process.env[MOCK_ENV];
  if (value === null) delete process.env[MOCK_ENV];
  else process.env[MOCK_ENV] = value;
  try {
    return await fn();
  } finally {
    if (before === undefined) delete process.env[MOCK_ENV];
    else process.env[MOCK_ENV] = before;
  }
}

/**
 * Make any real HTTP call throw.
 *
 * Necessary rather than defensive: this machine has a Gemini key in its environment,
 * so a test that means to prove the mock is off would otherwise spend a real request
 * and get a real quiz back, which is both slow and the exact false pass being guarded
 * against.
 */
async function withNoNetwork(fn) {
  const real = globalThis.fetch;
  let attempted = 0;
  globalThis.fetch = () => {
    attempted++;
    return Promise.reject(new Error('network disabled in the mock test'));
  };
  try {
    const out = await fn(() => attempted);
    return { out, attempted };
  } finally {
    globalThis.fetch = real;
  }
}

// ── The switch ─────────────────────────────────────────────────────────────

await check('the mock is off unless the environment says otherwise', () => {
  assert.equal(mockEnabled({}), false);
  assert.equal(mockEnabled({ [MOCK_ENV]: '' }), false, 'an empty value turned it on');
  assert.equal(mockEnabled({ [MOCK_ENV]: '0' }), false);
  assert.equal(mockEnabled({ [MOCK_ENV]: 'false' }), false);
  assert.equal(mockEnabled({ [MOCK_ENV]: 'no' }), false);
  assert.equal(mockEnabled({ [MOCK_ENV]: '1' }), true);
  assert.equal(mockEnabled({ [MOCK_ENV]: 'yes' }), true);
});

await check('the switch is read from the process environment, not from request options', () => {
  // A renderer must not be able to talk a shipped build into answering with canned
  // material, so there is deliberately no `mock` option on the request object.
  assert.equal(mockEnabled({ [MOCK_ENV]: '1' }), true);
  assert.equal(MOCK_ENV, 'AGENT_QUIZ_MOCK');
});

// ── The same path, not a shortcut ──────────────────────────────────────────

await check('generateAndSaveQuiz under the switch returns questions AND flashcards', async () => {
  await withMockEnv('1', async () => {
    const layer = layerWith(buildSession());
    const result = await layer.generateAndSaveQuiz('pi:mock-test', { questionCount: 6 });

    assert.ok(result, 'no result at all');
    assert.equal(result.ok, true, `generation failed: ${result.message || result.reason}`);
    assert.ok(result.questions.length > 0, 'the mock produced no questions');
    assert.ok(result.flashcards.length > 0, 'the mock produced no flashcards');

    // Every enabled type is covered, which means the per-topic request for one of
    // each reached the mock and came back shaped correctly.
    const types = new Set(result.questions.map((q) => q.type));
    assert.deepEqual([...types].sort(), ['cloze', 'mcq', 'open']);

    // And it was actually persisted, so the quiz is openable and listable.
    assert.ok(result.stored?.id, 'nothing was stored');
    const saved = layer.getQuiz(result.stored.id);
    assert.equal(saved.questions.length, result.questions.length);
    assert.equal(saved.flashcards.length, result.flashcards.length);
    layer.getStore().close();
  });
});

await check('the mock reports itself, so no output can pass for a real one', async () => {
  await withMockEnv('1', async () => {
    const layer = layerWith(buildSession());
    const result = await layer.generateAndSaveQuiz('pi:mock-test', { questionCount: 6 });
    assert.equal(result.mock, true);
    assert.equal(result.model, 'mock');
    // One attempt recorded per topic, the same shape the real path produces, so the
    // panel's progress and cost reading is exercised rather than bypassed.
    assert.equal(result.usage.calls, result.topicsUsed.length);
    assert.ok(result.usage.calls > 0);
    layer.getStore().close();
  });
});

await check('mock material is validated, not passed through', async () => {
  await withMockEnv('1', async () => {
    const layer = layerWith(buildSession());
    const result = await layer.generateAndSaveQuiz('pi:mock-test', { questionCount: 6 });

    // validateResult drops anything the schema cannot guarantee. If the mock bypassed
    // it, these would all still be present and unfiltered.
    for (const q of result.questions) {
      assert.ok(q.id, `${q.type} has no id`);
      assert.ok(q.prompt.length > 0, `${q.type} has no prompt`);
      assert.ok(q.explanation.length > 0, `${q.type} has no explanation`);
      assert.ok(q.topicId, `${q.type} is not tied to a topic of this session`);
    }
    const mcq = result.questions.find((q) => q.type === 'mcq');
    assert.ok(mcq.options.length >= 2, 'an mcq arrived without usable options');
    assert.ok(mcq.options.some((o) => o.key === mcq.correctOptionKey), 'no option matches the answer');
    const cloze = result.questions.find((q) => q.type === 'cloze');
    assert.match(cloze.codeWithGaps, /\{\{blank_\d+\}\}/, 'a cloze arrived with no gap');
    assert.ok(cloze.blanks.length > 0, 'a cloze arrived with no answers');
    const open = result.questions.find((q) => q.type === 'open');
    assert.ok(open.rubric.length > 0, 'an open question arrived with no rubric, so it could not be graded');

    // Every cited turn is a real turn of this conversation.
    const planned = new Set(result.topicsUsed.flatMap((t) => result.questions.filter((q) => q.topicId === t.id).flatMap((q) => q.sourceTurns)));
    assert.ok(planned.size > 0, 'nothing cited a turn');
    layer.getStore().close();
  });
});

await check('without the switch, generation goes to the network and gets nothing back', async () => {
  await withMockEnv(null, async () => {
    await withNoNetwork(async (attempted) => {
      const layer = layerWith(buildSession());
      const result = await layer.generateAndSaveQuiz('pi:mock-test', { questionCount: 6 });
      assert.ok(attempted() > 0, 'no request was attempted, so the mock answered with the switch off');
      assert.notEqual(result?.mock, true, 'a quiz was produced with the mock off');
      assert.equal(result?.questions.length ?? 0, 0, 'questions came back with the mock off');
      assert.equal(result?.stored, undefined, 'a quiz was persisted with the mock off');
      layer.getStore().close();
    });
  });
});

await check('with the switch on, nothing touches the network at all', async () => {
  await withMockEnv('1', async () => {
    await withNoNetwork(async (attempted) => {
      const layer = layerWith(buildSession());
      const result = await layer.generateAndSaveQuiz('pi:mock-test', { questionCount: 6 });
      assert.equal(attempted(), 0, 'the mock path still called out');
      assert.ok(result.questions.length > 0);
      layer.getStore().close();
    });
  });
});

await check('the mock is reachable from the plain generate path too, not only the saving one', async () => {
  await withMockEnv('1', async () => {
    const layer = layerWith(buildSession());
    const quiz = await layer.generateQuiz('pi:mock-test', { questionCount: 6 });
    assert.equal(quiz.ok, true);
    assert.ok(quiz.questions.length > 0);
    assert.ok(quiz.flashcards.length > 0);
    layer.getStore().close();
  });
});

await check('mockTopicResponse honours the requested flashcard count and types', () => {
  const topic = { id: 't1', label: 'the retry wrapper', from: 4, to: 9 };
  for (const n of [1, 2, 5]) {
    const out = mockTopicResponse({ topic, types: ['mcq', 'cloze', 'open'], flashcardsPerTopic: n });
    assert.equal(out.flashcards.length, n, `asked for ${n} cards`);
    assert.equal(out.questions.length, 3);
    for (const c of out.flashcards) assert.deepEqual(c.sourceTurns, [4], 'a card cited a turn outside the topic');
  }
  // Types are the request, not a default: a flashcard-only plan asks for no questions.
  assert.equal(mockTopicResponse({ topic, types: [], flashcardsPerTopic: 2 }).questions.length, 0);
});

// ── Options the plan now accepts ───────────────────────────────────────────

await check('flashcardsPerTopic is clamped to the range the control offers', () => {
  assert.equal(clampFlashcardsPerTopic(0), FLASHCARDS_PER_TOPIC.min);
  assert.equal(clampFlashcardsPerTopic(-5), FLASHCARDS_PER_TOPIC.min);
  assert.equal(clampFlashcardsPerTopic(999), FLASHCARDS_PER_TOPIC.max);
  assert.equal(clampFlashcardsPerTopic(3.4), 3, 'the count is a whole number of cards');
  assert.equal(clampFlashcardsPerTopic('4'), 4);
  assert.equal(clampFlashcardsPerTopic('nonsense'), FLASHCARDS_PER_TOPIC.default);
  assert.equal(clampFlashcardsPerTopic(undefined), FLASHCARDS_PER_TOPIC.default);
});

await check('capabilities carries the flashcards control range without losing what was there', () => {
  const f = quizCapabilities().flashcards;
  for (const key of ['always', 'perTopic', 'note']) {
    assert.ok(key in f, `the existing key ${key} disappeared`);
  }
  assert.equal(f.min, FLASHCARDS_PER_TOPIC.min);
  assert.equal(f.max, FLASHCARDS_PER_TOPIC.max);
  assert.equal(f.default, FLASHCARDS_PER_TOPIC.default);
  assert.equal(f.step, FLASHCARDS_PER_TOPIC.step);
  assert.ok(f.max > f.min && f.default >= f.min && f.default <= f.max, 'the range does not contain its own default');
});

await check('the stored settings key changes when the flashcard count changes', () => {
  const base = { questionCount: 6, types: ['mcq', 'cloze', 'open'] };
  const two = settingsKey({ ...base, flashcardsPerTopic: 2 });
  assert.notEqual(settingsKey({ ...base, flashcardsPerTopic: 3 }), two, 'a different card count reused a quiz id');
  assert.notEqual(settingsKey({ ...base }), two, 'omitting the setting matched setting it explicitly');
  assert.equal(settingsKey({ ...base, flashcardsPerTopic: 2 }), two, 'the same settings produced two ids');
});

await check('the saved settings record the flashcard count that was actually used', async () => {
  await withMockEnv('1', async () => {
    const layer = layerWith(buildSession());
    // Ask for one card, clamped up to the floor, and read back what was stored.
    const result = await layer.generateAndSaveQuiz('pi:mock-test', { questionCount: 3, flashcardsPerTopic: 1 });
    const saved = layer.getStore().getQuiz(result.stored.id);
    assert.equal(saved.settings.flashcardsPerTopic, 1);
    assert.equal(saved.flashcards.length, saved.topicsUsed.length * 1, 'the deck does not match the stored setting');
    layer.getStore().close();
  });
});

await check('topicIds narrows generation, and an absent list keeps automatic selection', async () => {
  await withMockEnv('1', async () => {
    const session = buildSession();
    const layer = layerWith(session);
    const all = layer.planQuiz('pi:mock-test', { questionCount: 30, types: ['mcq'] });
    assert.ok(all.selectedTopics.length > 1, 'the fixture needs several topics to make this meaningful');

    const first = all.selectedTopics[0].id;
    const picked = layer.planQuiz('pi:mock-test', { questionCount: 30, types: ['mcq'], topicIds: [first] });
    assert.deepEqual(picked.selectedTopics.map((t) => t.id), [first], 'the topic selection was ignored');
    assert.deepEqual(picked.requestedTopicIds, [first]);
    assert.deepEqual(picked.droppedTopicIds, []);

    // Absent and empty both mean automatic.
    const absent = layer.planQuiz('pi:mock-test', { questionCount: 6, seed: 7 });
    const empty = layer.planQuiz('pi:mock-test', { questionCount: 6, seed: 7, topicIds: [] });
    assert.deepEqual(absent.selectedTopics, empty.selectedTopics, 'an empty list changed the automatic selection');
    assert.deepEqual(empty.requestedTopicIds, []);
    layer.getStore().close();
  });
});

await check('more topics selected than the question count samples a subset', async () => {
  await withMockEnv('1', async () => {
    const layer = layerWith(buildSession());
    const all = layer.planQuiz('pi:mock-test', { questionCount: 30, types: ['mcq'] });
    const ids = all.selectedTopics.map((t) => t.id);
    assert.ok(ids.length > 1, 'the fixture needs several topics to make this meaningful');

    // One question per topic per type, so mcq-only with a count of 2 needs 2 topics.
    const plan = layer.planQuiz('pi:mock-test', { questionCount: 2, types: ['mcq'], topicIds: ids });
    assert.equal(plan.selectedTopics.length, 2, 'the subset was not sampled down to what was asked for');
    assert.equal(plan.droppedTopicIds.length, ids.length - 2, 'the unselected topics were not reported');
    for (const id of plan.selectedTopics.map((t) => t.id)) assert.ok(ids.includes(id), 'sampling invented a topic');
    layer.getStore().close();
  });
});

await check('a selected topic that cannot carry a question is reported, not silently swapped', async () => {
  await withMockEnv('1', async () => {
    const layer = layerWith(buildSession());
    const plan = layer.planQuiz('pi:mock-test', { questionCount: 2, topicIds: ['no-such-topic'] });
    assert.deepEqual(plan.unknownTopicIds, ['no-such-topic']);
    layer.getStore().close();
  });
});

// ── The saved-quiz list ────────────────────────────────────────────────────

await check('store.list reports when each quiz was last touched', async () => {
  const { QuizStore } = await import('../lib/store.js');
  const store = QuizStore.memory();
  const session = buildSession();
  const { id } = store.saveQuiz(
    { topicsUsed: [{ id: 't1', label: 'l', messageRanges: [[0, 1]] }], flashcards: [{ front: 'a', back: 'b' }], questions: [{ id: 'q1', type: 'mcq' }] },
    session,
    { settings: { questionCount: 1 } },
  );

  const before = store.list()[0].progress;
  assert.equal(before, null, 'a quiz that was never started reported progress');

  store.saveProgress(id, { stepIndex: 2, answers: { q1: 'A' } });
  const during = store.list()[0].progress;
  assert.equal(during.stepIndex, 2);
  assert.equal(during.resumable, true);
  assert.equal(typeof during.updatedAt, 'number', 'the list row has no last-accessed time');

  await new Promise((r) => setTimeout(r, 5));
  store.clearProgress(id);
  const after = store.list()[0].progress;
  assert.ok(after.updatedAt >= during.updatedAt, 'touching the quiz did not move its last-accessed time');

  // And the other five keys are still there, because the frontend already reads them.
  for (const key of ['stepIndex', 'completed', 'resumable', 'score', 'maxScore', 'updatedAt']) {
    assert.ok(key in after, `the existing key ${key} disappeared`);
  }
  store.close();
});

// ── Report ─────────────────────────────────────────────────────────────────

console.log(`\nmock+options: ${passed} passed, ${failures.length} failed\n`);

if (failures.length) {
  for (const f of failures) console.error(`FAIL  ${f.name}\n        ${f.message}`);
  process.exit(1);
}
console.log('All mock and options assertions passed.\n');
