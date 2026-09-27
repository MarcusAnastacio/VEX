// Path and name formatting shared by the sidebar and the panel.
//
// This lived in components/sidebar.js, but the panel needs the same answer - both are
// trying to name the project a conversation belongs to, and a session arrives with a
// cwd, a `project` field that is often a raw store path, and an id built from that path.
// Turning those into one readable label is string work, not drawing, so it belongs in
// lib/ rather than in either component. Neither component imported anything before this.
//
// The two view labels live here too, for the same reason: they are wording shared by
// the header and the panel, and a "which screen am I on" question has exactly one
// answer. The view switch never generates, so its label is decided by where you are
// rather than by what a quiz would cost.
//
// The rules:
//   - a real directory beats a store path, and a file named `session.jsonl` never names
//     a project, so look above it
//   - ids, hashes, timestamps and container words ("sessions", "workspace", "tmp") are
//     not names, so they never win
//   - if only opaque segments exist, return something rather than nothing
//   - no "ready" wording before a quiz exists, from either direction the backend can
//     answer that question from

const STORE_SEGMENTS = new Set([
  'sessions', 'session', 'projects', 'project', 'chats', 'chat',
  'threads', 'thread', 'tasks', 'task', 'conversations', 'conversation', 'transcripts',
  'transcript', 'history', 'rollout', 'rollouts', 'logs', 'log', 'state', 'data',
  'agents', 'agent', 'workspace', 'workspaces', 'workspacestorage', 'globalstorage',
  'storage', 'main', 'home', 'code', 'dev', 'users', 'user', 'tmp', 'var', 'opt',
]);

/** Segment names that identify nothing to a reader: ids, timestamps, generated names. */
const OPAQUE = new RegExp([
  '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$', // uuid
  '^[0-9a-f]{16,}$', // long hex digest
  '^[0-9a-f]{8}$', // short hash
  '^\\d{9,15}$', // epoch millis, or a task directory named by date
  '^(?:sess|wd|session)[_-]', // generated session folders
].join('|'), 'i');

/** Filenames every store uses for "the transcript", which say nothing about the project. */
const STORE_FILES = new RegExp(
  '^(?:session|transcript|thread|events|updates|wire|messages?|conversation|history|turns|log'
  + '|api_conversation_history|rollout-.*|.*_history)$',
  'i',
);

const FILE_EXT = /\.(jsonl|ndjson|json|sql|sqlite|db|md|log|txt|ya?ml)$/i;

const isStoreSegment = (name) => STORE_SEGMENTS.has(name.toLowerCase()) || OPAQUE.test(name);
const isStoreFile = (name) => FILE_EXT.test(name);

/**
 * The one button beside the title, for the view currently on screen.
 *
 * Deliberately not the backend's `button.label`: that string describes what generating
 * would do to a stored quiz, and the plan makes this button a pure view switch. Keeping
 * the two apart is what stops "Generate quiz" from quietly turning into "Resume quiz".
 */
export function viewSwitchLabel(view) {
  return view === 'transcript' ? 'Generate quiz' : 'View transcript';
}

/**
 * Is there a stored quiz to open, resume, or replace?
 *
 * `quizForSession` answering null and `quizButton` answering `configure` are the same
 * fact from two directions: nothing has been generated for this conversation. Either one
 * on its own must not produce "your quiz is ready" wording, because there is nothing to
 * open. Requires both, so a half-answered question fails closed into plain wording.
 */
export function hasStoredQuiz({ quiz = null, button = null } = {}) {
  return Boolean(quiz) && button?.action !== 'configure';
}

/**
 * The most human-sounding segment of a path, or '' when there isn't one.
 * Prefers a real cwd, then `project`, then the store path the id was built from.
 */
export function projectLabel(session = {}) {
  for (const source of [session.cwd, session.project, session.path]) {
    const segments = splitPath(source);
    if (!segments.length) continue;
    const label = pickSegment(segments);
    if (label) return label;
  }
  return 'Unknown project';
}

function splitPath(value) {
  let text = String(value ?? '').trim();
  if (!text) return [];
  // Harnesses percent-encode the separator inside a single directory name.
  try { text = decodeURIComponent(text); } catch { /* keep the raw text */ }
  return text
    .split(/[\\/]+/)
    .map((part) => part.trim().replace(/^['"]|['"]$/g, ''))
    // Claude Code and friends encode the project as "--workspace-app--".
    .map((part) => {
      const wrapped = /^--(.+)--$/.exec(part);
      return (wrapped ? wrapped[1] : part).replace(/^-+|-+$/g, '');
    })
    // Dotfiles are configuration, not a project name.
    .filter((part) => part && !part.startsWith('.'))
    .map((name) => ({ name: name.replace(FILE_EXT, ''), file: isStoreFile(name) }));
}

function pickSegment(segments) {
  const named = segments.filter((s) => !isStoreSegment(s.name));
  // Fall back to the raw path rather than giving up: a name like "main" is thin, but it
  // is still more use than a blank subtitle.
  const pool = named.length ? named : segments;
  // A store file never names the project, so prefer a directory that sits above it.
  const dirs = pool.filter((s) => !s.file);
  const use = dirs.length ? dirs : pool;
  const last = use[use.length - 1];
  if (!last) return '';
  if (STORE_FILES.test(last.name)) {
    const above = use[use.length - 2];
    if (above && !STORE_FILES.test(above.name)) return above.name;
  }
  return isStoreSegment(last.name) ? '' : last.name;
}
