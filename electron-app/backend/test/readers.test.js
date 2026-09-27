#!/usr/bin/env node
// Reader routing and per-format parsing tests.
//
// Every case here is a bug that the compatibility sweep (`npm run compat`) found by
// running a real sample store through the full path. They are pinned because each
// one was silent: the format appeared in the list of supported agents while its
// user turns, or its assistant turns, were being discarded.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { readStoreFile } from '../readers/index.js';
import { projectFromPath } from '../lib/normalize.js';
import { DatabaseSync } from 'node:sqlite';

let passed = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    passed++;
  } catch (err) {
    failures.push({ name, message: err.message });
  }
}

const FIXTURES = fileURLToPath(new URL('../fixtures', import.meta.url));
const read = (rel, ctx) =>
  readStoreFile(path.join(FIXTURES, rel), { harness: 'test', harnessName: 'test', ...ctx });

// ── Routing ────────────────────────────────────────────────────────────────

check('a .jsonl file is read as text even when the store declares a sqlite format', () => {
  // Cursor declares `sqlite-kv-or-jsonl` because the IDE keeps a SQLite KV store and
  // ALSO writes agent transcripts as JSONL. Keying on the declared format sent the
  // transcripts to the SQLite reader, which emitted a placeholder instead of the
  // conversation.
  const result = read('cursor/projects/registry-demo/agent-transcripts/registry-cursor.jsonl', {
    formatKind: 'sqlite-kv-or-jsonl',
  });
  const session = result.sessions[0];
  assert.ok(session, 'no session');
  assert.deepEqual(session.messages.map((m) => m.role), ['user', 'assistant']);
  assert.ok(!session.messages[0].text.startsWith('[Detected'), 'took the SQLite path');
});

check('a .db file still goes to the SQLite reader', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reader-'));
  const file = path.join(dir, 'store.db');
  fs.writeFileSync(file, 'not really a database');
  const result = readStoreFile(file, { harness: 'x', harnessName: 'x', formatKind: 'sqlite' });
  // Unreadable as SQLite, so it yields nothing or a placeholder — but it must not be
  // parsed as text and must not throw.
  assert.ok(Array.isArray(result.sessions));
  fs.rmSync(dir, { recursive: true, force: true });
});

check('a .sql dump goes to the script reader, not the SQLite file reader', () => {
  const result = read('opencode/opencode.sql', { formatKind: 'sqlite' });
  // The text lives in a sibling `part` table this reader does not join, so the honest
  // outcome is a placeholder rather than nothing at all.
  assert.ok(result.sessions.length >= 1, 'the store disappeared entirely');
  assert.ok(result.sessions[0].partial, 'expected a partial placeholder');
});

// ── aider ──────────────────────────────────────────────────────────────────

check('aider user turns come from "#### ", not from raw markdown', () => {
  // aider's own writer uses `prefix = "####"` for the user's input. Treating `#### `
  // as assistant text discarded every user turn in every aider session.
  const session = read('aider/.aider.chat.history.md', { formatKind: 'markdown-log' }).sessions[0];
  assert.deepEqual(
    session.messages.map((m) => m.role),
    ['user', 'assistant'],
  );
  assert.equal(session.messages[0].text, 'inspect the markdown history');
  assert.equal(session.messages[1].text, 'The history is readable.');
});

check('aider: a multi-line user input is one turn, and "> " output is not speech', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aider-'));
  const file = path.join(dir, '.aider.chat.history.md');
  fs.writeFileSync(
    file,
    [
      '# aider chat started at 2026-07-17 09:00:00',
      '',
      '#### first line of the question',
      '#### second line of the same question',
      '',
      '> uv run pytest',
      '> tests failed with exit code 1',
      '',
      'The answer follows the tool block.',
      '',
    ].join('\n'),
  );
  const session = readStoreFile(file, { harness: 'aider', harnessName: 'aider', formatKind: 'markdown-log' })
    .sessions[0];
  assert.deepEqual(session.messages.map((m) => m.role), ['user', 'assistant']);
  assert.equal(
    session.messages[0].text,
    'first line of the question\nsecond line of the same question',
    'consecutive "#### " lines are not one turn',
  );
  assert.ok(!session.messages[1].text.includes('pytest'), 'tool output leaked into the transcript');
  assert.ok(session.messages[1].text.startsWith('The answer follows'), 'assistant text lost');
  fs.rmSync(dir, { recursive: true, force: true });
});

check('aider: a prefix inside a fenced block is code, not structure', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aider-'));
  const file = path.join(dir, '.aider.chat.history.md');
  fs.writeFileSync(
    file,
    [
      '# aider chat started at 2026-07-17 09:00:00',
      '',
      '#### show me the format',
      '',
      'Here it is:',
      '',
      '```',
      '#### this is inside a fence and must not start a turn',
      '> nor is this tool output',
      '```',
      '',
    ].join('\n'),
  );
  const session = readStoreFile(file, { harness: 'aider', harnessName: 'aider', formatKind: 'markdown-log' })
    .sessions[0];
  assert.equal(session.messages.length, 2, `expected 2 messages, got ${session.messages.length}`);
  assert.ok(session.messages[1].text.includes('must not start a turn'), 'fence contents were dropped');
  assert.ok(session.messages[1].text.includes('nor is this tool output'), 'fence contents were split');
  fs.rmSync(dir, { recursive: true, force: true });
});

check('aider: the banner before the first turn is not speech', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aider-'));
  const file = path.join(dir, '.aider.chat.history.md');
  fs.writeFileSync(file, '# aider chat started at 2026-07-17 09:00:00\n\n#### hello\n\nhi\n');
  const session = readStoreFile(file, { harness: 'aider', harnessName: 'aider', formatKind: 'markdown-log' })
    .sessions[0];
  assert.equal(session.messages.length, 2);
  assert.ok(!session.messages.some((m) => m.text.includes('aider chat started')), 'banner became a message');
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── Antigravity ────────────────────────────────────────────────────────────

check('antigravity: the speaker is in "source", including USER_EXPLICIT', () => {
  // Only `MODEL` matched a known role, so every user turn was dropped and the
  // transcript read as the model talking to itself.
  const session = read('antigravity/brain/registry-antigravity/.system_generated/logs/transcript.jsonl', {
    formatKind: 'jsonl',
  }).sessions[0];
  assert.deepEqual(session.messages.map((m) => m.role), ['user', 'assistant']);
  assert.equal(session.userTurns, 1);
});

check('antigravity: the XML wrappers are stripped and the metadata is not speech', () => {
  const session = read('antigravity/brain/registry-antigravity/.system_generated/logs/transcript.jsonl', {
    formatKind: 'jsonl',
  }).sessions[0];
  const user = session.messages[0].text;
  assert.equal(user, 'inspect the antigravity transcript', `wrappers survived: ${JSON.stringify(user)}`);
  assert.ok(!user.includes('ADDITIONAL_METADATA'), 'metadata leaked into the text');
  // The metadata is where the working directory lives, so it is read before being dropped.
  assert.equal(session.cwd, '/workspace/registry-demo');
});

// ── Gemini CLI ─────────────────────────────────────────────────────────────

check('gemini: an assistant turn typed "gemini" is kept', () => {
  // The Gemini CLI types assistant turns as `gemini` and stores content at the top
  // level, both of which were unrecognised — so only the user's half survived.
  const session = read('gemini/session.jsonl', { formatKind: 'json-or-jsonl' }).sessions[0];
  assert.deepEqual(session.messages.map((m) => m.role), ['user', 'assistant']);
  assert.equal(session.messages[1].text, 'the session is readable');
});

// ── Kimi ───────────────────────────────────────────────────────────────────

check('kimi: the streamed answer is reassembled and think parts are not kept', () => {
  const session = read('kimi/sessions/wd_demo_0123456789ab/session_fixture01/agents/main/wire.jsonl', {
    formatKind: 'jsonl',
  }).sessions[0];
  assert.deepEqual(session.messages.map((m) => m.role), ['user', 'assistant', 'user', 'assistant']);
  assert.equal(session.userTurns, 2, 'both user turns should survive');
  const all = session.messages.map((m) => m.text).join('\n');
  assert.ok(!all.includes('reasoning to be skipped'), 'a think part was kept as answer text');
  assert.ok(all.includes('The cache keeps serving the old kid'), 'the streamed answer was lost');
  assert.ok(session.reasoningChars > 0, 'dropped reasoning was not counted');
});

// ── Subagent detection and grouping ────────────────────────────────────────
//
// A Pi subagent transcript lives at
//   <project>/<parentTranscriptStem>/<runId>/run-<n>/session.jsonl
// where the DIRECTORY is named exactly after the parent's transcript file. That is
// the only signal treated as proof of a parent, and the parent transcript has to
// exist as a sibling of the directory for the claim to be believed.
//
// The negative control matters as much as the positive case: a store may nest files
// under a run directory without any of that being true, and the sidebar hides
// subagents by default, so a wrong `true` makes a real conversation disappear.

const SUBAGENT_FIXTURES = fileURLToPath(
  new URL('./fixtures/pi-subagent/--workspace-registry-demo--', import.meta.url),
);
const PARENT_STEM = '2026-09-19T14-27-13-725Z_01a0ba10-6cbc-73c1-accf-0141842c6579';
/**
 * The parent session's own id, which is the UUID and NOT the filename stem. Pi
 * stamps the file with a timestamp while the session header carries the plain UUID,
 * and the header is where the reader takes the native id from, so this is the value
 * that actually joins against a catalog row.
 */
const PARENT_ID = '01a0ba10-6cbc-73c1-accf-0141842c6579';
const readSub = (rel) => readStoreFile(path.join(SUBAGENT_FIXTURES, rel), { harness: 'pi', harnessName: 'pi' }).sessions?.[0];

check('a nested Pi child is a subagent and names its parent', () => {
  const child = readSub(`${PARENT_STEM}/dca456b7-dcf9-4480-8c75-de83f943021b/run-0/session.jsonl`);
  assert.ok(child, 'the nested child did not parse');
  assert.equal(child.isSubagent, true);
  assert.equal(child.parentSessionId, PARENT_ID, 'the run id or the filename stem was returned instead of the parent session id');
  assert.equal(child.parentId, `pi:${PARENT_ID}`, 'the parent was not qualified into the catalog id space');
});

check('the parent of a nested child resolves to that child catalog id', () => {
  const parent = readSub(`${PARENT_STEM}.jsonl`);
  const child = readSub(`${PARENT_STEM}/dca456b7-dcf9-4480-8c75-de83f943021b/run-0/session.jsonl`);
  // This is the join the sidebar performs to nest a child under its parent.
  assert.equal(child.parentId, parent.id);
});

check('path nesting alone proves a subagent, with no session_info record', () => {
  const child = readSub(`${PARENT_STEM}/fe91e875-68f5-4211-8ea8-ac9e04cc9ea1/run-0/session.jsonl`);
  assert.ok(child, 'the child with no session_info header did not parse');
  assert.equal(child.isSubagent, true);
  assert.equal(child.parentSessionId, PARENT_ID);
});

check('a run directory with no parent transcript beside it is NOT a subagent', () => {
  const orphan = readSub(
    '2026-09-20T09-00-00-000Z_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/no-parent-file/99999999-1111-2222-3333-444444444444/run-0/session.jsonl',
  );
  assert.ok(orphan, 'the orphan transcript did not parse');
  // Nothing is proven, so nothing may be hidden.
  assert.equal(orphan.isSubagent, false, 'a conversation was hidden on a guess');
  assert.equal(orphan.parentSessionId, null, 'a parent was invented');
});

check('the parent conversation is not a subagent of anything', () => {
  const parent = readSub(`${PARENT_STEM}.jsonl`);
  assert.equal(parent.isSubagent, false);
  assert.equal(parent.parentSessionId, null);
  assert.equal(parent.parentId, null);
});

check("a pi event's parentId is never read as a session parent", () => {
  // Every pi fixture is full of per-event parentId links, and prime's session header
  // carries a real `parentSession: null`. Neither may turn into a parent link.
  const pi = read('pi/session.jsonl', { harness: 'pi' }).sessions[0];
  assert.equal(pi.isSubagent, false);
  assert.equal(pi.parentSessionId, null, 'an event DAG parent was used as a session parent');
  assert.equal(pi.parentId, null);
});

check('a pi header parentSession is read, and an explicit null stays null', () => {
  const prime = read('prime/session.jsonl', { harness: 'prime' }).sessions[0];
  assert.equal(prime.parentSessionId, null, 'an explicit null became a link');
  assert.equal(prime.parentId, null);
});

check('a nested child resolves its project from the encoded ancestor, not the path tail', () => {
  // Child 2 carries no cwd, so inferWorkspace is the only source. The old walk tested
  // exactly two levels, which here are a bare uuid and a run directory, and the
  // fallback produced the run directory as the project name.
  const file = `${PARENT_STEM}/fe91e875-68f5-4211-8ea8-ac9e04cc9ea1/run-0/session.jsonl`;
  const child = readSub(file);
  assert.equal(child.project, 'workspace/registry/demo');
  assert.equal(
    projectFromPath(path.join(SUBAGENT_FIXTURES, file)),
    'run-0/session.jsonl',
    'the fixture no longer reproduces the failure it was written for',
  );
});

check('every session carries the grouping fields with usable types', () => {
  for (const rel of ['claude-code/session.jsonl', 'codex/rollout-2026-07-17T09-00-00-registry-codex.jsonl', 'pi/session.jsonl', 'gemini/session.jsonl']) {
    const s = read(rel, { harness: 'x' }).sessions[0];
    assert.equal(typeof s.isSubagent, 'boolean', `${rel} is missing isSubagent`);
    assert.equal(typeof s.groupKey, 'string', `${rel} is missing groupKey`);
    assert.ok(s.groupKey.length > 0, `${rel} has an empty groupKey`);
    assert.ok(s.parentSessionId === null || typeof s.parentSessionId === 'string', `${rel} parentSessionId`);
    assert.ok(s.parentId === null || typeof s.parentId === 'string', `${rel} parentId`);
  }
});

check('a session index column that names a parent becomes a real link', () => {
  // Crush and Zed and OpenClaw all keep one. Built here rather than added to
  // backend/fixtures so the reader tests own it and the compat sweep is untouched.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'group-'));
  const file = path.join(dir, 'store.db');
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE sessions (id text primary key, parent_session_id text);
           CREATE TABLE messages (id text primary key, session_id text, role text, parts text);
           INSERT INTO sessions VALUES ('child-1', 'parent-1'), ('parent-1', NULL);
           INSERT INTO messages VALUES ('m1', 'child-1', 'user', '[{"type":"text","text":"child turn"}]');
           INSERT INTO messages VALUES ('m2', 'parent-1', 'user', '[{"type":"text","text":"parent turn"}]');`);
  db.close();
  const s = readStoreFile(file, { harness: 'crush', harnessName: 'Crush' }).sessions.find((x) => x.nativeId === 'child-1');
  assert.equal(s.parentSessionId, 'parent-1');
  assert.equal(s.parentId, 'crush:parent-1');
  fs.rmSync(dir, { recursive: true, force: true });
});

check('a parentSession that is a FILE PATH is reduced to a joinable session id', () => {
  // Nine real Pi transcripts on the development machine carry this shape, and passing
  // the path through unchanged yields a parentId matching no catalog row.
  const raw = '/home/freq/.pi/agent/sessions/--home-freq--/2026-06-22T13-44-23-315Z_019eef93-3813-7926-a803-40477de00d89.jsonl';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parentsess-'));
  const file = path.join(dir, 'child.jsonl');
  fs.writeFileSync(
    file,
    [
      JSON.stringify({ type: 'session', version: 3, id: 'child-1', timestamp: '2026-06-24T02:05:06.224Z', parentSession: raw }),
      JSON.stringify({ type: 'message', id: 'u1', parentId: null, timestamp: '2026-06-24T02:05:07.000Z', message: { role: 'user', content: [{ type: 'text', text: 'carry on from the other thread' }] } }),
      JSON.stringify({ type: 'message', id: 'a1', parentId: 'u1', timestamp: '2026-06-24T02:05:20.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'picking that up' }] } }),
    ].join('\n') + '\n',
  );
  const s = readStoreFile(file, { harness: 'pi', harnessName: 'pi' }).sessions[0];
  assert.equal(s.parentSessionId, '019eef93-3813-7926-a803-40477de00d89', 'the path was not reduced to the session id');
  assert.equal(s.parentId, 'pi:019eef93-3813-7926-a803-40477de00d89');
  // A continued thread is lineage, not a subagent, and must not be hidden.
  assert.equal(s.isSubagent, false);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── Report ─────────────────────────────────────────────────────────────────

console.log(`\nreaders: ${passed} passed, ${failures.length} failed\n`);

if (failures.length) {
  for (const f of failures) console.error(`FAIL  ${f.name}\n        ${f.message}`);
  process.exit(1);
}
console.log('All reader assertions passed.\n');
