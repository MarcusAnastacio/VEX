// Reader dispatch: format kind + file extension -> normalized sessions.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

import { readJsonl } from './jsonl.js';
import { readJson, INDEX_FILES } from './json.js';
import { readMarkdown } from './markdown.js';
import { readSqlite, readSqliteScript } from './sqlite.js';
import { readChatgptExport, readClaudeWebExport } from './exports.js';
import { projectFromEncodedDir, projectFromPath } from '../lib/normalize.js';
import { groupKeyFor, subagentParentFromPath } from '../lib/grouping.js';

const MAX_BYTES = 64 * 1024 * 1024;
const ZSTD = /\.zst$|\.zstd$/;

function decode(file) {
  const stat = fs.statSync(file);
  if (stat.size > MAX_BYTES) return { skipped: 'too large' };
  const buf = fs.readFileSync(file);

  if (ZSTD.test(file)) {
    if (typeof zlib.zstdDecompressSync !== 'function') {
      return { skipped: 'zstd unsupported in this runtime' };
    }
    try {
      return { raw: zlib.zstdDecompressSync(buf).toString('utf8') };
    } catch (err) {
      return { skipped: `zstd decode failed: ${err.message}` };
    }
  }
  return { raw: buf.toString('utf8') };
}

/**
 * VS Code stores the workspace identity next to the session, not inside it:
 *   workspaceStorage/<hash>/workspace.json  ->  { "folder": "file:///home/me/proj" }
 * Without this a Copilot Chat session is labelled with the storage hash, which is
 * meaningless in the sidebar.
 */
function vscodeWorkspaceMeta(file) {
  const sessionDir = path.dirname(file);
  if (path.basename(sessionDir) !== 'chatSessions') return null;
  const metaPath = path.join(path.dirname(sessionDir), 'workspace.json');
  try {
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    const loc = meta.folder || meta.workspace;
    if (!loc) return null;
    const decoded = decodeURIComponent(String(loc).replace(/^file:\/\//, ''));
    return { cwd: decoded, project: path.basename(decoded) || null };
  } catch {
    return null;
  }
}

/** An ENCODED-WORKING-DIRECTORY segment: Claude-style `--home-dev-code-myapp--`. */
const ENCODED_DIR = /^--.*--$/;

/**
 * How far up the tree to look for one.
 *
 * A nested subagent transcript is four levels below it
 * (`<project>/<parent>/<runId>/run-N/session.jsonl`), and a store path is
 * registry-supplied data, so the walk is bounded rather than run to the filesystem
 * root. Six is comfortably past any layout the registry describes.
 */
const MAX_ANCESTOR_HOPS = 6;

/** Best-effort project label and working directory when the transcript did not carry them. */
function inferWorkspace(file) {
  const vs = vscodeWorkspaceMeta(file);
  if (vs?.project) return vs;

  // Walk up until an ENCODED-WORKING-DIRECTORY segment turns up.
  //
  // This used to test exactly two levels: the transcript's own directory, then its
  // parent. That is enough for a flat store and silently wrong for a nested one,
  // where those two levels are a bare run UUID and a run directory, so nothing
  // matched and the session fell through to projectFromPath. Every subagent
  // transcript was then attributed to whatever the last two segments of its path
  // happened to be, which is how spawned conversations pile up as loose top-level
  // rows with the wrong project.
  let dir = path.dirname(file);
  for (let hop = 0; hop < MAX_ANCESTOR_HOPS; hop++) {
    const base = path.basename(dir);
    if (ENCODED_DIR.test(base)) return { project: projectFromEncodedDir(base) };
    const parent = path.dirname(dir);
    if (!parent || parent === dir) break;
    dir = parent;
  }
  return { project: projectFromPath(file) };
}

/**
 * Read one store file into zero or more normalized sessions.
 * @param {string} file
 * @param {{harness:string,harnessName:string,formatKind?:string,project?:string}} ctx
 * @returns {{sessions: object[], skipped?: string}}
 */
export function readStoreFile(file, ctx) {
  const basename = path.basename(file);
  const ext = path.extname(file).toLowerCase();
  const kind = ctx.formatKind || '';

  // Extensions that are always read as text, whatever the registry says the store's
  // format is. Cursor declares "sqlite-kv-or-jsonl" because the IDE keeps a SQLite
  // KV store AND writes agent transcripts as JSONL, so the declared kind alone sent
  // `.jsonl` files to the SQLite reader — which cannot open them and emitted a
  // placeholder instead of the conversation.
  const TEXT_EXTS = new Set(['.jsonl', '.ndjson', '.json', '.md', '.markdown', '.txt', '.sql']);
  const SQLITE_EXT = /\.(db|sqlite|sqlite3|vscdb)$/i;
  const isSqliteStore = SQLITE_EXT.test(basename) || (kind.startsWith('sqlite') && !TEXT_EXTS.has(ext));

  const inferred = inferWorkspace(file);
  // Structural, not editorial: a transcript at `<project>/<parentId>/<runId>/run-N/…`
  // is a subagent of `<parentId>` because Pi named the directory after that parent's
  // transcript file. No transcript content is consulted, so a child whose header is
  // missing or truncated is still attributed correctly.
  const nestedParent = subagentParentFromPath(file);

  /**
   * A reader that returns `cwd: undefined` (because the transcript did not carry
   * one) would clobber the value we inferred from the surrounding folder or the
   * sibling workspace.json, because `{...ctx, ...extracted}` keeps the key. Fill
   * it back in so the sidebar always has somewhere to point.
   */
  const backfill = (sessions) => {
    for (const s of sessions) {
      if (!s.cwd && inferred.cwd) s.cwd = inferred.cwd;
      if (!s.project && inferred.project) s.project = inferred.project;
      if (nestedParent) {
        // A parent proved by the path outranks anything a record claimed, and the
        // harness prefix goes on here so the two agree on one representation.
        s.parentSessionId = nestedParent;
        s.parentId = `${s.harness}:${nestedParent}`;
        s.isSubagent = true;
      }
      // finalizeSession() computed groupKey before it knew a cwd, because a VS Code
      // workspace folder and a Claude-style encoded directory both supply one only
      // here. Recompute, or every backfilled session groups by its fallback instead.
      if (s.groupKey) s.groupKey = groupKeyFor({ cwd: s.cwd, project: s.project, harness: s.harness });
    }
    return sessions;
  };

  /** Every return path goes through here so backfill cannot be forgotten. */
  const done = (result) => {
    if (result?.sessions?.length) backfill(result.sessions);
    return result;
  };

  if (INDEX_FILES.has(basename)) return { sessions: [], skipped: 'index file' };

  if (kind === 'detect-only') {
    // We can prove the store exists; we cannot decode it. Report, do not pretend.
    return { sessions: [], detectedOnly: true };
  }

  if (isSqliteStore) {
    const sessions = readSqlite(file, {
      ...ctx,
      path: file,
      project: ctx.project || inferred.project || ctx.harnessName,
      cwd: ctx.cwd || inferred.cwd,
    }) || [];
    return { sessions: backfill(sessions) };
  }

  // A `.sql` dump is a fixture, not a live store; run it in memory and read it.
  if (ext === '.sql') {
    const { raw, skipped } = decode(file);
    if (skipped) return { sessions: [], skipped };
    const sessions = readSqliteScript(raw, {
      ...ctx,
      path: file,
      project: ctx.project || inferred.project || ctx.harnessName,
    });
    return { sessions: backfill(sessions) };
  }

  const { raw, skipped } = decode(file);
  if (skipped) return { sessions: [], skipped };

  const full = {
    ...ctx,
    path: file,
    project: ctx.project || inferred.project || ctx.harnessName,
    ...(inferred.cwd ? { cwd: inferred.cwd } : {}),
  };

  if (kind === 'chatgpt-export') {
    return { sessions: backfill(readChatgptExport(raw, full)) };
  }
  if (kind === 'claude-web-export') {
    return { sessions: backfill(readClaudeWebExport(raw, full)) };
  }

  // Extension wins for text formats; the registry kind is the tie-breaker.
  const isJsonl = /\.jsonl$/i.test(basename) || /\.ndjson$/i.test(basename);
  const isMarkdown = ext === '.md' || kind === 'markdown-log';
  const isJson = ext === '.json' || /json/i.test(kind);

/** Normalize a reader result that may be a session, {empty:true}, or null. */
function one(result) {
  if (!result) return { sessions: [] };
  if (result.empty) return { sessions: [], empty: true };
  return { sessions: [result] };
}

  try {
    if (isMarkdown) {
      return done(one(readMarkdown(raw, full)));
    }
    if (isJsonl) {
      return done(one(readJsonl(raw, full)));
    }
    if (isJson) {
      const s = readJson(raw, full);
      if (s) return done({ sessions: [s] });
      // Some agents write JSONL into a .json file.
      return done(one(readJsonl(raw, full)));
    }
    // Unknown extension: try JSONL, then JSON, then markdown.
    const a = done(one(readJsonl(raw, full)));
    if (a.sessions.length || a.empty) return a;
    const s2 = readJson(raw, full);
    if (s2) return done({ sessions: [s2] });
    return done(one(readMarkdown(raw, full)));
  } catch (err) {
    return { sessions: [], skipped: `parse error: ${err.message}` };
  }
}
