// SQLite readers: Cursor, OpenCode, Goose, Crush, Zed, Hermes, Kiro, Kilo.
//
// SQLite schemas are per-agent and undocumented, so this reader is heuristic:
// it discovers tables, finds message-shaped columns, and groups rows into
// sessions by a conversation/session id column when one exists.
//
// `node:sqlite` is built into Node 22.13+ / 23.4+. If the running Electron does
// not expose it, we do not fail — we report the store as detected-but-unparsed
// so the sidebar still shows it and the user knows it was found.

import { contentToParts, contentToText } from '../lib/text.js';
import { finalizeSession, makeMessage, toEpochMs } from '../lib/normalize.js';
import { SESSION_PARENT_FIELDS, SESSION_ID_FIELDS } from '../lib/grouping.js';

let DatabaseSync = null;
let sqliteError = null;
try {
  // Kept dynamic: bundlers must not hard-fail when the builtin is absent.
  ({ DatabaseSync } = await import('node:sqlite'));
} catch (err) {
  sqliteError = err.message;
}

export const sqliteAvailable = () => DatabaseSync !== null;
export const sqliteUnavailableReason = () => sqliteError;

const ROLE_COLS = ['role', 'author', 'sender', 'type', 'source', 'who'];
const TEXT_COLS = ['text', 'content', 'message', 'body', 'value', 'data', 'parts', 'payload', 'json'];
const ID_COLS = ['session_id', 'sessionId', 'conversation_id', 'conversationId', 'thread_id', 'chat_id', 'cid'];
const TS_COLS = ['timestamp', 'created_at', 'createdAt', 'created', 'ts', 'time', 'updated_at'];

function openDb(file) {
  try {
    return new DatabaseSync(file, { readOnly: true });
  } catch {
    return null;
  }
}

function listTables(db) {
  try {
    return db
      .prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%'")
      .all()
      .map((r) => r.name);
  } catch {
    return [];
  }
}

function columnsOf(db, table) {
  try {
    return db.prepare(`PRAGMA table_info(${JSON.stringify(table)})`).all().map((c) => c.name);
  } catch {
    return [];
  }
}

/** Pull the string payload out of a row given candidate columns, decoding JSON when possible. */
function rowPayload(row, cols) {
  for (const c of TEXT_COLS) {
    if (!cols.includes(c)) continue;
    const v = row[c];
    if (typeof v === 'string') return v;
    if (v && typeof v === 'object') return v;
    if (v instanceof Uint8Array) {
      try {
        return new TextDecoder().decode(v);
      } catch {
        /* ignore */
      }
    }
  }
  return null;
}

function parseMaybeJson(value) {
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string') return null;
  const s = value.trim();
  if (!s || (s[0] !== '{' && s[0] !== '[')) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/**
 * Cursor stores everything as key/value blobs in `cursorDiskKV` / `ItemTable`.
 * Bubble ids look like `bubbleId:<composerId>:<bubbleId>`.
 */
function readCursorKeyValue(db) {
  const tables = listTables(db).filter((t) => /kv|itemtable|cursorDiskKV/i.test(t));
  const bySession = new Map();

  for (const table of tables) {
    const cols = columnsOf(db, table);
    if (!cols.includes('value')) continue;
    const keyCol = cols.includes('key') ? 'key' : cols.find((c) => /key/i.test(c));
    if (!keyCol) continue;

    let rows = [];
    try {
      rows = db.prepare(`SELECT ${keyCol} AS k, value AS v FROM ${table} WHERE ${keyCol} LIKE 'bubbleId:%'`).all();
    } catch {
      continue;
    }
    for (const row of rows) {
      const bubble = parseMaybeJson(rowPayload({ v: row.v }, ['v']));
      if (!bubble) continue;
      const parts = [];
      if (typeof bubble.text === 'string') parts.push(bubble.text);
      if (typeof bubble.richText === 'string') parts.push(bubble.richText);
      const text = contentToText(parts.length ? parts : bubble.content ?? bubble.message);
      if (!text) continue;

      const sessionId = String(row.k).split(':')[1] || 'cursor';
      if (!bySession.has(sessionId)) bySession.set(sessionId, []);
      bySession.get(sessionId).push(
        makeMessage({
          // type 1 = user, type 2 = assistant in Cursor's bubble encoding.
          role: bubble.type === 1 ? 'user' : bubble.type === 2 ? 'assistant' : bubble.role,
          text, thinkingChars,
          ts: toEpochMs(bubble.createdAt || bubble.timestamp),
        }),
      );
    }
  }
  return bySession;
}

/** Generic: find the most message-like table and group by a session column. */
function readGenericTable(db) {
  const bySession = new Map();
  let best = null;

  for (const table of listTables(db)) {
    const cols = columnsOf(db, table);
    if (cols.length === 0) continue;
    const hasText = TEXT_COLS.some((c) => cols.includes(c));
    const hasRole = ROLE_COLS.some((c) => cols.includes(c));
    if (!hasText) continue;
    const score = (hasRole ? 2 : 0) + (cols.some((c) => ID_COLS.includes(c)) ? 1 : 0) + (/message/i.test(table) ? 3 : 0);
    if (!best || score > best.score) best = { table, cols, score, hasRole };
  }
  if (!best || best.score < 2) return bySession;

  let rows = [];
  try {
    rows = db.prepare(`SELECT * FROM ${best.table} LIMIT 50000`).all();
  } catch {
    return bySession;
  }

  const idCol = ID_COLS.find((c) => best.cols.includes(c));
  const roleCol = ROLE_COLS.find((c) => best.cols.includes(c));
  const tsCol = TS_COLS.find((c) => best.cols.includes(c));

  for (const row of rows) {
    const rawPayload = rowPayload(row, best.cols);
    const decoded = parseMaybeJson(rawPayload) ?? rawPayload;
    if (typeof decoded !== 'string' && !decoded) continue;

    const content = typeof decoded === 'object'
      ? decoded.content ?? decoded.text ?? decoded.message ?? decoded
      : decoded;
    const { text, thinkingChars } = contentToParts(content);
    if (!text) continue;

    const role = roleCol ? row[roleCol] : decoded?.role;
    const sessionId = idCol ? String(row[idCol]) : 'default';
    if (!bySession.has(sessionId)) bySession.set(sessionId, []);
    bySession.get(sessionId).push(
      makeMessage({ role, text, thinkingChars, ts: toEpochMs(tsCol ? row[tsCol] : undefined) }),
    );
  }
  return bySession;
}

function sessionsFromDb(db, ctx, file) {
  let bySession = readCursorKeyValue(db);
  if (bySession.size === 0) bySession = readGenericTable(db);

  // Several agents keep a session index beside the messages, and that index is where
  // a session-level parent lives. Crush has sessions.parent_session_id, Zed has
  // threads.parent_id, OpenClaw has session_windows.previous_session_id (plus
  // parent_session_key and spawned_by). None of them put it on a message row, so this
  // has to be a separate read of the index table rather than a field on the messages.
  const parents = readSessionParents(db);

  const out = [];
  for (const [sessionId, messages] of bySession) {
    if (messages.length === 0) continue;
    const session = finalizeSession({
      ...ctx,
      nativeId: sessionId,
      messages,
      source: 'sqlite',
      parentSessionId: parents.get(sessionId) ?? null,
    });
    if (session) out.push(session);
  }
  return out;
}

/**
 * child session id -> parent session id, read from whichever table holds both columns.
 *
 * A child whose parent is not in this store still gets a link: `parentId` is a real
 * value from the file, and the sidebar can decide what to do with a parent it cannot
 * open. What it does not do is guess.
 */
function readSessionParents(db) {
  const parents = new Map();

  for (const table of listTables(db)) {
    const cols = columnsOf(db, table);
    if (cols.length === 0) continue;
    const parentCol = SESSION_PARENT_FIELDS.find((c) => cols.includes(c));
    if (!parentCol) continue;
    const idCol = SESSION_ID_FIELDS.find((c) => cols.includes(c));
    if (!idCol) continue;

    let rows = [];
    try {
      rows = db.prepare(`SELECT ${JSON.stringify(idCol)} AS child, ${JSON.stringify(parentCol)} AS parent FROM ${JSON.stringify(table)}`).all();
    } catch {
      continue;
    }
    for (const row of rows) {
      const child = row.child == null ? '' : String(row.child).trim();
      if (!child) continue;
      const parent = row.parent == null ? '' : String(row.parent).trim();
      // First writer wins, so a store with two index tables reports the one whose
      // parent column holds a session ID rather than a session key.
      if (!parent || parents.has(child)) continue;
      parents.set(child, parent);
    }
  }
  return parents;
}

function placeholderFor(ctx, file, why) {
  return finalizeSession({
    ...ctx,
    source: 'sqlite',
    partial: true,
    nativeId: ctx.nativeId || file,
    messages: [makeMessage({ role: 'system', text: why })],
  });
}

/**
 * Parse a SQLite store. Always returns at least a placeholder session when the
 * database is readable, so "detected" and "parsed" stay distinguishable.
 */
export function readSqlite(file, ctx) {
  if (!DatabaseSync) {
    const p = placeholderFor(
      ctx,
      file,
      `[Detected ${ctx.harnessName} store at ${file}. SQLite decoding unavailable in this runtime: ${sqliteError}]`,
    );
    return p ? [p] : null;
  }

  const db = openDb(file);
  if (!db) return null;

  try {
    const out = sessionsFromDb(db, ctx, file);
    if (out.length === 0) {
      // Readable, but we could not recognise the schema. Surface it, don't drop it.
      const p = placeholderFor(ctx, file, `[Detected ${ctx.harnessName} SQLite store at ${file}, but no message table was recognised.]`);
      if (p) out.push(p);
    }
    return out;
  } finally {
    try {
      db.close();
    } catch {
      /* ignore */
    }
  }
}

/**
 * Some projects ship their schema as a `.sql` dump rather than a `.db`. Run it
 * into an in-memory database and read the result with the same code path, so
 * a fixture is as good as a live store for testing parsers.
 */
export function readSqliteScript(sqlText, ctx) {
  if (!DatabaseSync) return [];
  let db;
  try {
    db = new DatabaseSync(':memory:');
    db.exec(sqlText);
  } catch {
    try {
      db?.close();
    } catch {
      /* ignore */
    }
    return [];
  }
  try {
    const sessions = sessionsFromDb(db, ctx, ctx.path);
    if (sessions.length === 0) {
      // Same honesty as readSqlite: a store we can open but cannot decode is
      // reported as detected, not silently dropped. Several agents keep message
      // text in a sibling table (`part`, `blocks`) that the generic reader does not
      // join, so this path is reached in practice.
      const p = placeholderFor(
        ctx,
        ctx.path,
        `[Detected ${ctx.harnessName} store at ${ctx.path}, but no message table was recognised.]`,
      );
      if (p) sessions.push(p);
    }
    return sessions;
  } finally {
    try {
      db.close();
    } catch {
      /* ignore */
    }
  }
}

