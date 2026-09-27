// Subagent detection and sidebar grouping.
//
// WHAT THIS FILE BELIEVES, AND WHY
//
// "Spawned conversations" are sessions an agent started on its own while working
// through something with a person. Telling them apart needs a session-level parent
// link, and the claim that no format has one is wrong. It is wrong for Pi, and the
// evidence is structural rather than a guess about a field name.
//
// PI: THE PARENT IS IN THE PATH
//
// A parent conversation is a file. Each subagent it spawns gets a DIRECTORY named
// exactly after that file's basename with `.jsonl` removed, and inside that a
// per-run directory holding the child's own transcript:
//
//   ~/.pi/agent/sessions/--home-freq-EmberHacks2026--/
//     2026-09-19T14-27-13-725Z_01a0ba10-6cbc-73c1-accf-0141842c6579.jsonl   <- parent
//     2026-09-19T14-27-13-725Z_01a0ba10-6cbc-73c1-accf-0141842c6579/         <- named after it
//       dca456b7-dcf9-4480-8c75-de83f943021b/run-0/session.jsonl              <- child
//
// The directory name IS the parent's native id, so the link needs no transcript
// content and no interpretation. Verified on this machine, where one parent had ten
// such children.
//
// THE TRAP THIS FILE EXISTS TO AVOID
//
// Pi puts `parentId` on every event, and on the child's own `session_info` header:
//
//   {"type":"session_info","id":"bb53b4f7","parentId":"73523a92",...,"name":"subagent-..."}
//
// That `parentId` is the per-EVENT message DAG: it points at another event id inside
// the SAME transcript, and on the first event it is null. Reading it as a session
// parent produces a confident, wrong, entirely fabricated hierarchy. The
// `subagent-` name prefix on that same line IS a real signal, and it is the only part
// of the line used here.
//
// PI: A SECOND, INDEPENDENT SIGNAL
//
// The name prefix proves a session is a subagent without any path knowledge, which
// matters for a store that is copied, synced or exported out of its directory layout.
// It carries the RUN id, not the parent session, so it can set `isSubagent` and
// nothing else.
//
// CLAUDE CODE
//
// Unverified. `~/.claude/projects` does not exist on this machine and no real
// transcript was available, so nothing here claims anything about it. `isSidechain`
// appears nowhere in the readers, and if Claude Code does write subagent turns inline
// in the parent transcript then they are already being absorbed into the parent
// conversation, which needs no grouping decision at all.
//
// OTHER FORMATS
//
// Where a store carries a session-level parent in a real column, it is read rather
// than guessed: Crush `sessions.parent_session_id`, Zed `threads.parent_id`, and
// OpenClaw `session_windows.previous_session_id` / `parent_session_key` / `spawned_by`.
// Where nothing does, `parentSessionId` is null and `groupKey` groups by working
// directory, which is a grouping and not a claim of descent.

import fs from 'node:fs';
import path from 'node:path';

/**
 * Field names that carry a session-level parent, most specific first.
 *
 * `previous_session_id` outranks `parent_session_key` deliberately: OpenClaw stores
 * both, and the key column holds a session KEY (`agent:main:main`) while the id
 * column holds the id every other row is keyed by. Preferring the id means a link
 * that resolves to a real session rather than to a string that names none.
 */
export const SESSION_PARENT_FIELDS = [
  'parentSession',
  'parent_session',
  'parent_session_id',
  'parentSessionId',
  'previous_session_id',
  'previousSessionId',
  'parent_id',
  'parentId',
  'parent_session_key',
];

/** Columns that identify the CHILD row in a session index table. */
export const SESSION_ID_FIELDS = ['session_id', 'id', 'thread_id', 'conversation_id', 'session_key'];

/** A `run-N` directory is the one part of the Pi child layout that is unmistakable. */
const RUN_DIR = /^run-\d+$/;

/** A bare UUID, which is what a Pi per-run directory is named. */
const UUID_DIR = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A Pi parent transcript basename, with or without the timestamp it is stored with:
 * `2026-09-19T14-27-13-725Z_01a0ba10-6cbc-73c1-accf-0141842c6579`.
 */
const PARENT_DIR = /^(?:\d{4}-\d{2}-\d{2}T[\d-]+Z_)?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

/** Transcript suffixes to strip when a parent reference turns out to be a file path. */
const TRANSCRIPT_SUFFIX = /\.(acp\.json|jsonl|json)$/i;

/**
 * The prefix a Pi `session_info.name` carries for a subagent, e.g.
 * `subagent-worker-3853560c-26c8-4e63-92a1-9a5c1dd41541-1`.
 */
export const SUBAGENT_NAME_PREFIX = 'subagent-';

/**
 * The parent session's native id for a nested Pi child transcript, or null.
 *
 * Structural and content-free. Four levels have to line up, and each one is checked,
 * because the tempting off-by-one here is to return the RUN id and call it a parent:
 *
 *   <parentId>            the parent's transcript basename, e.g. 2026-09-19T14-27-13-725Z_01a0ba10-...
 *     <runId>             a bare UUID, one per dispatched run
 *       run-<n>           the run's attempt
 *         session.jsonl    this file
 *
 * The parent is the directory TWO levels above `run-<n>`, not one. As a final check
 * the parent's own transcript has to exist next to that directory, because "the
 * directory is named after the parent file" is the claim being made here and the file
 * is what makes it true rather than a coincidence of naming.
 *
 * The RETURNED id is the bare UUID, not the directory name. Pi stamps the file with a
 * timestamp (`2026-09-19T14-27-13-725Z_01a0ba10-…jsonl`) while the session's own
 * header carries the plain `01a0ba10-…`, and that header is where every reader takes
 * the native id from. Returning the stem would produce a `parentId` matching no
 * catalog row, which is worse than returning none.
 *
 * @param {string} file  the transcript's path on disk
 * @returns {string|null} the parent's native id
 */
export function subagentParentFromPath(file) {
  if (typeof file !== 'string' || !file) return null;

  const runDir = path.dirname(file);
  if (!RUN_DIR.test(path.basename(runDir))) return null;

  const runIdDir = path.dirname(runDir);
  if (!UUID_DIR.test(path.basename(runIdDir))) return null;

  const parentDir = path.dirname(runIdDir);
  const dirName = path.basename(parentDir);
  const match = dirName.match(PARENT_DIR);
  if (!match) return null;

  // The claim under test: <parentDir> is named after a real parent transcript, and
  // that transcript is a SIBLING of the directory, not a file inside it.
  try {
    if (!fs.existsSync(path.join(path.dirname(parentDir), `${dirName}.jsonl`))) return null;
  } catch {
    return null;
  }
  return match[1];
}

/** True when a `session_info` name proves the session is a subagent. */
export function isSubagentName(name) {
  return typeof name === 'string' && name.trim().toLowerCase().startsWith(SUBAGENT_NAME_PREFIX);
}

/**
 * Reduce a parent reference to the parent's session id.
 *
 * Two shapes turn up, and the second is the one that bites. Path nesting gives a bare
 * id. A `parentSession` field gives the FULL PATH OF THE PARENT TRANSCRIPT FILE, which
 * on a real store reads:
 *
 *   /home/freq/.pi/agent/sessions/--home-freq--/2026-06-22T13-44-23-315Z_019eef93-….jsonl
 *
 * Passing that through unchanged produces a `parentId` matching no catalog row ever,
 * so a sidebar joining on it silently nests nothing. Nine real Pi transcripts on the
 * development machine carry exactly that value, so this is not hypothetical.
 *
 * @param {unknown} raw
 * @returns {string|null} the parent's native id, or null when there is no usable link
 */
export function parentSessionRef(raw) {
  if (typeof raw !== 'string') return null;
  let value = raw.trim();
  if (!value || value === 'null' || value === 'undefined' || value === '0') return null;
  // Already qualified as `<harness>:<id>`; leave it alone.
  if (value.includes(':') && !/[/\\]/.test(value)) return value;

  if (/[/\\]/.test(value) || TRANSCRIPT_SUFFIX.test(value)) {
    value = path.basename(value).replace(TRANSCRIPT_SUFFIX, '');
    const match = value.match(PARENT_DIR);
    if (match) return match[1];
  }
  return value || null;
}

/**
 * Put a raw parent value into the normalized id space, `<harness>:<nativeId>`.
 *
 * Returns null for anything that is not a usable link. That is the whole point: an
 * empty string, a zero, a literal "null" or a self-reference all mean "no parent" in
 * these stores, and turning any of them into a link would draw a line in the sidebar
 * that the data does not support.
 */
export function sessionParentId(raw, harness = '') {
  const value = parentSessionRef(raw);
  if (!value) return null;
  // Already qualified, or explicitly another harness's session.
  if (value.includes(':')) return value;
  return harness ? `${harness}:${value}` : value;
}

/**
 * The key sessions are grouped by in the sidebar.
 *
 * Working directory first, because that is what actually separates two pieces of work
 * on one machine: two harnesses pointed at the same checkout are one conversation
 * about one project, and the same harness pointed at two checkouts is two.
 *
 * Prefixed by its source so a working directory can never collide with a project label
 * that happens to read the same. Never empty, so every row has something to group
 * under even when nothing about the session is known.
 */
export function groupKeyFor(session = {}) {
  const cwd = typeof session.cwd === 'string' ? session.cwd.trim() : '';
  if (cwd) return `cwd:${stripTrailingSep(cwd)}`;

  const project = typeof session.project === 'string' ? session.project.trim() : '';
  if (project && project !== 'unknown project') return `project:${project}`;

  return `harness:${session.harness || 'unknown'}`;
}

/** `/a/b/` and `/a/b` are one directory. */
function stripTrailingSep(p) {
  return p.length > 1 ? p.replace(/[/\\]+$/, '') : p;
}
