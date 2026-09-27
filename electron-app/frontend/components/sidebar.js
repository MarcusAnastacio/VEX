// VISUAL LAYER — the sidebar.
//
// This file is expected to change. It reads a view model and writes DOM; it does not
// fetch, does not hold state, and does not know what a "session" is beyond the fields it
// reads off the summary it is handed.
//
// If you redesign this, keep `renderSidebar(container, props)` and the `onSelect(id)`
// callback and nothing else in the app has to move.

import { projectLabel } from '../lib/labels.js';

const h = (tag, props = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = value;
    // Always textContent: titles and project names come from other tools' stores.
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    node.append(child);
  }
  return node;
};

const clamp = (text, max = 24) => {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
};

const timeAgo = (ms) => {
  if (!ms) return '';
  const days = Math.floor((Date.now() - ms) / 86400000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
};

// ── Project label ──────────────────────────────────────────────────────────
//
// `project` is whatever the harness's store path implied, which is often a filename:
// "claude-code/session.jsonl", "-workspace-gjc-demo/session.jsonl",
// "transcripts/7c9e2d2c-0000-4000-8000-000000000000.jsonl". None of that belongs in a
// row subtitle. When the backend can tell us the real working directory we use it, and
// otherwise we recover as much of a name as the path allows.

/** Path segments that describe the store layout, never the project. */

/** Everything the filter should match, in one string, lowercased by the caller. */
const haystack = (session) =>
  `${session.title} ${session.project} ${session.harnessName} ${session.cwd ?? ''} ${projectLabel(session)}`
    .toLowerCase();

// ── Scan state ─────────────────────────────────────────────────────────────
//
// app.js owns the state; this component only watches the two lines of chrome whose text
// it can already see, so the list can say what is happening instead of showing a dead
// rectangle. Nothing here is authoritative: if the answer is wrong the list still
// renders every session it was handed.
//
// One wrinkle: app.js writes the headline BEFORE calling renderSidebar() and the footer
// hint AFTER it, so the hint we read during a render is always one render stale. The
// re-check at the bottom of renderSidebar settles that on the next frame.

let scanningSince = 0;
const SCAN_TRUST_MS = 20_000;

function isScanning(doc) {
  const summary = doc.getElementById('summary')?.textContent?.trim() ?? '';
  const hint = doc.getElementById('progress')?.textContent?.trim() ?? '';
  const busy = summary === 'Scanning your disk…'
    || /^scanning/i.test(hint)
    // The per-harness progress events read "Claude Code: 12".
    || /^[^:]{1,40}:\s*\d+$/.test(hint);
  if (!busy) { scanningSince = 0; return false; }
  // A failed scan leaves "Scanning…" in the footer forever; stop believing it eventually.
  if (!scanningSince) scanningSince = Date.now();
  return Date.now() - scanningSince < SCAN_TRUST_MS;
}

// ── Rows ───────────────────────────────────────────────────────────────────

const byNewest = (a, b) => (b.updated || 0) - (a.updated || 0);

/** "codex" and "Codex CLI" are the same thing; showing both is noise, not information. */
const isSameName = (a, b) => {
  const one = String(a ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const two = String(b ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!one || !two) return false;
  if (one === two) return true;
  const [short, long] = one.length <= two.length ? [one, two] : [two, one];
  return short.length >= 3 && long.includes(short);
};

const countLabel = (n) => `${n} message${n === 1 ? '' : 's'}`;

// ── Subagents ──────────────────────────────────────────────────────────────
//
// A conversation an agent spawned while working through something is a conversation in
// its own right, but a list that puts all of them at the same level buries the ones a
// person actually started: on this machine 17 of 87 rows are subagents, and at least one
// real parent has fifteen of them. The backend proves the link and hands us two fields:
// `parentId`, already in the catalog's id space (`<harness>:<nativeId>`), and
// `parentSessionId`, the parent's native id.
//
// Two rules decide what happens here, and both fail towards SHOWING a row:
//
//  1. Only a proven subagent nests. `isSubagent` is false whenever a store did not prove
//     descent, and one real case carries a parent link anyway: Pi writes `parentSession`
//     on a session CONTINUED from an earlier one, so nine rows on this machine have a
//     `parentId` with `isSubagent: false`, all nine quiz-ready, two of them pointing at a
//     parent NEWER than themselves. Nesting those would hide a conversation a person
//     started, under a stale heading, by default. They stay at the top level.
//  2. A subagent whose parent is not in the list is an orphan and renders top level.
//     Dropping a conversation because a parent row is missing or unparsed is the one
//     outcome worth designing against.

/**
 * Which row owns each nested row, keyed by row id. Only rows whose parent is present
 * in the same list get an entry; everything else is a top-level row.
 */
function parentLinks(sessions) {
  const ids = new Set(sessions.map((s) => s.id));
  const parentOf = new Map();
  for (const session of sessions) {
    if (session.isSubagent !== true) continue;
    const parent = resolveParent(session, ids);
    if (parent) parentOf.set(session.id, parent);
  }
  // A store could claim a loop (A spawned by B, B spawned by A). Break the edge that
  // closes it, so both rows render once at the top level instead of disappearing into a
  // subtree that can never start.
  for (const start of [...parentOf.keys()]) {
    const seen = new Set();
    let id = start;
    while (id) {
      if (seen.has(id)) {
        parentOf.delete(id);
        break;
      }
      seen.add(id);
      id = parentOf.get(id);
    }
  }
  return parentOf;
}

/**
 * The id of the row that owns `session`, or null.
 *
 * `parentId` arrives normalized, so the ordinary case is one string match. The bare
 * native id is a second chance for a store that names the parent unqualified, and it is
 * only trusted inside the child's own harness: a bare uuid is not unique across stores,
 * and joining one across harnesses would invent a hierarchy out of a coincidence.
 */
function resolveParent(session, ids) {
  const own = String(session.id ?? '');
  const parentId = session.parentId;
  if (parentId && parentId !== own && ids.has(parentId)) return parentId;
  const native = session.parentSessionId;
  const cut = own.indexOf(':');
  if (typeof native === 'string' && native && cut > 0) {
    const candidate = `${own.slice(0, cut)}:${native}`;
    if (candidate !== own && ids.has(candidate)) return candidate;
  }
  return null;
}

/** parent row id -> its child rows, newest first, in list order. */
function childrenByParent(parentOf, sessions) {
  const kids = new Map();
  for (const session of sessions) {
    const parent = parentOf.get(session.id);
    if (!parent) continue;
    if (!kids.has(parent)) kids.set(parent, []);
    kids.get(parent).push(session);
  }
  for (const list of kids.values()) list.sort(byNewest);
  return kids;
}

// Expansion state. Module-local, the way panel.js keeps its topic selection: app.js does
// not need to know which rows are open, and a redraw never loses it.
/** Parents the user opened. */
const openParents = new Set();
/** Parents collapsed while a filter had forced them open. Cleared when the query moves. */
const closedParents = new Set();
let lastQuery = null;
/** The last render's inputs, so a toggle can redraw without app.js re-rendering. */
let lastRender = null;

function row(session, { selectedId, onSelect, ready, depth = 0, hasChildren = false }) {
  const label = projectLabel(session);
  const when = timeAgo(session.updated);
  // On a ready row the harness is the heading, because the row sits outside a group. On
  // a grouped row the group header already says it.
  const middle = ready
    ? (isSameName(label, session.harnessName) ? countLabel(session.messageCount) : label)
    : label;
  const classes = ['row'];
  if (ready) classes.push('row--ready');
  if (hasChildren) classes.push('row--parent');
  if (depth > 0) classes.push('row--child');
  return h(
    'button',
    {
      class: classes.join(' '),
      type: 'button',
      // The row's identity in the DOM. Nothing styles it; it makes a row addressable
      // from a test that only has the document.
      'data-session-id': session.id,
      'aria-current': String(selectedId === session.id),
      title: `${session.title}\n${label}\n${session.messageCount} messages`
        + (ready ? '' : '\nToo short to quiz from')
        + (depth > 0 ? '\nSpawned by the conversation above' : ''),
      onclick: () => onSelect(session.id),
    },
    h(
      'span',
      { class: 'row__head' },
      h('span', { class: 'row__title', text: clamp(session.title, 30) }),
      ready && h('span', { class: 'row__pill', text: 'Quiz ready' }),
    ),
    h(
      'span',
      { class: 'row__meta' },
      ready && h('span', { class: 'row__harness', text: session.harnessName }),
      middle && h('span', { class: 'row__project', text: middle }),
      middle && when && h('span', { class: 'row__dot', text: '·' }),
      h('span', { class: 'row__time', text: when }),
    ),
  );
}

/**
 * One row, plus the subagents spawned from it.
 *
 * Collapsed subagents are still in the DOM, only `hidden`: every session in the list is
 * present and addressable, and expanding is a paint rather than a fetch. A child is
 * scored by its OWN readiness, because a parent can sit in "Everything else" while one
 * of its subagents is long enough to quiz from.
 */
function node(session, options, depth = 0) {
  // A session renders exactly once, wherever its parent landed.
  if (options.rendered.has(session.id)) return null;
  options.rendered.add(session.id);

  const kids = options.byParent.get(session.id) ?? [];
  const rowEl = row(session, {
    ...options,
    ready: depth > 0 ? !!session.quizReady : !!options.ready,
    depth,
    hasChildren: kids.length > 0,
  });
  if (!kids.length) return rowEl;

  const open = options.openNow.has(session.id);
  const count = kids.length;
  const plural = count === 1 ? 'subagent' : 'subagents';
  // Unique per session, and derived from the id so a redraw keeps the same target.
  const kidsId = `subagents-${String(session.id).replace(/[^a-zA-Z0-9_-]/g, '-')}`;
  // The toggle sits UNDER the row rather than beside it. Beside it, a
  // "16 subagents" control costs the parent row about a third of its width, and the
  // parent's title is the one line a reader most needs intact.
  return h(
    'div',
    { class: 'subtree' },
    rowEl,
    h(
      'button',
      {
        class: 'row__expander',
        type: 'button',
        'aria-expanded': open ? 'true' : 'false',
        'aria-controls': kidsId,
        'aria-label': `${open ? 'Hide' : 'Show'} ${count} ${plural} of ${clamp(session.title, 40)}`,
        onclick: () => options.toggle(session.id),
      },
      h('span', { class: 'row__caret' }),
      h('span', { class: 'row__subcount', text: `${count} ${plural}` }),
    ),
    h(
      'div',
      { class: 'subtree__kids', id: kidsId, hidden: !open },
      ...kids.map((kid) => node(kid, options, depth + 1)),
    ),
  );
}

/** A group of rows under a heading. `name` is the harness, or a section label. */
function section(name, count, items, options) {
  return h(
    'div',
    { class: options.sectionClass ? `group ${options.sectionClass}` : 'group' },
    h(
      'div',
      { class: 'group__head' },
      h('span', { class: 'group__name', text: name }),
      h('span', { class: 'group__count', text: String(count) }),
    ),
    options.note && h('p', { class: 'group__note', text: options.note }),
    ...items.map((session) => node(session, options, 0)),
  );
}

/**
 * @param {HTMLElement} container
 * @param {object} props { sessions, selectedId, filter, onSelect }
 */
export function renderSidebar(container, { sessions = [], selectedId = null, filter = '', onSelect = () => {} } = {}) {
  const doc = container.ownerDocument || document;
  const query = filter.trim();
  const needle = query.toLowerCase();
  const shown = needle
    ? sessions.filter((s) => haystack(s).includes(needle))
    : sessions;

  // A toggle redraws with the same inputs app.js last handed us, so the component owns
  // its expansion state without asking app.js to hold any of it.
  const props = { sessions, selectedId, filter, onSelect };
  lastRender = { container, props };

  const scanning = isScanning(doc);

  container.replaceChildren();

  // Status strip. One place at the top of the list that always says what is happening,
  // so no state is signalled by an absence.
  if (scanning) {
    container.append(
      h(
        'div',
        { class: 'listbar listbar--busy' },
        h('span', { class: 'spinner' }),
        h('span', { text: shown.length ? 'Rescanning your disk…' : 'Scanning your disk for agent conversations…' }),
      ),
    );
  } else if (needle) {
    container.append(
      h(
        'div',
        { class: 'listbar' },
        h(
          'span',
          { class: 'listbar__count', text: `${shown.length} of ${sessions.length}` },
        ),
        h('span', { class: 'listbar__what', text: `matching “${clamp(query, 24)}”` }),
      ),
    );
  }

  if (shown.length === 0) {
    if (scanning) {
      // Skeleton rows, not a blank rectangle: the shape of the list is already known.
      for (let i = 0; i < 5; i += 1) {
        container.append(
          h(
            'div',
            { class: 'skeleton' },
            h('div', { class: 'skeleton__line skeleton__line--title' }),
            h('div', { class: 'skeleton__line skeleton__line--meta' }),
          ),
        );
      }
      return;
    }
    container.append(needle ? noMatches(doc, query) : noConversations(doc, sessions.length));
    return;
  }

  // Which rows are nests, and which of them are open.
  const parentOf = parentLinks(shown);
  const byParent = childrenByParent(parentOf, shown);
  // Top-level rows only: a child follows its parent into whichever section the parent
  // lands in, so every count below is a count of rows with nothing above them.
  const top = shown.filter((s) => !parentOf.has(s.id));

  // A filter must never match something it does not show, so while one is active every
  // parent with children in the match set opens itself. Everything in `byParent` is a
  // match by construction: `shown` is already the filtered list.
  if (needle !== lastQuery) {
    closedParents.clear();
    lastQuery = needle;
  }
  const openNow = new Set();
  for (const id of byParent.keys()) {
    if ((needle || openParents.has(id)) && !closedParents.has(id)) openNow.add(id);
  }

  const toggle = (id) => {
    if (openNow.has(id)) {
      openParents.delete(id);
      closedParents.add(id);
    } else {
      openParents.add(id);
      closedParents.delete(id);
    }
    if (lastRender && lastRender.container.isConnected) {
      renderSidebar(lastRender.container, lastRender.props);
    }
  };

  // Shared across every section so a session can only be rendered once, and so a child
  // rendered under its parent is never also drawn at the top level.
  const nesting = { byParent, openNow, toggle, rendered: new Set() };

  // Ready sessions lead, everything else below a labelled divider.
  //
  // Both halves were on the table: sorting ready-first inside the existing per-harness
  // groups, and de-emphasising the thin rows. Grouping won for the thin rows and lost for
  // the ready ones — with 33 harness groups, a ready session sorted to the top of *its*
  // group is still several screens down, so the list would still open on a dead row.
  // Ready-first puts the three conversations that can actually make a quiz in the first
  // screenful, and one divider replaces 37 repetitions of the word "short".
  const ready = top.filter((s) => s.quizReady).sort(byNewest);
  const rest = top.filter((s) => !s.quizReady).sort(byNewest);

  if (ready.length) {
    container.append(section('Ready to quiz', ready.length, ready, {
      sectionClass: 'group--ready', ready: true, selectedId, onSelect, ...nesting,
    }));
  }

  if (rest.length) {
    if (ready.length) {
      container.append(
        h(
          'div',
          { class: 'split' },
          h('span', { class: 'split__line' }),
          h(
            'span',
            { class: 'split__label' },
            h('span', { class: 'split__text', text: 'Everything else' }),
            h('span', { class: 'split__count', text: String(rest.length) }),
          ),
          h('span', { class: 'split__line' }),
        ),
        h('p', {
          class: 'split__note',
          text: `${rest.length} conversations are too short to quiz from. You can still open one and read it.`,
        }),
      );
    }

    // Group by agent so the bulk of the list reads as "what did I use", newest first.
    const groups = new Map();
    for (const session of rest) {
      const key = session.harnessName || session.harness;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(session);
    }
    for (const [name, items] of [...groups].sort((a, b) => byNewest(a[1][0], b[1][0]))) {
      container.append(section(name, items.length, items, { selectedId, onSelect, ...nesting }));
    }
  }
  // app.js writes the footer hint AFTER calling this, so the decision above is made
  // against last render's hint. Re-check on the next frame and redraw once if the scan
  // state moved; this settles the strip the moment a scan finishes.
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(() => {
      if (container.isConnected && isScanning(container.ownerDocument || document) !== scanning) {
        renderSidebar(container, props);
      }
    });
  }
}

/** The weakest state in the list, so it gets the most copy. */
function noMatches(doc, query) {
  const clear = () => {
    const input = doc.getElementById('search');
    if (!input) return;
    input.value = '';
    // app.js re-renders from the input event, exactly as if the user had cleared it.
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.focus();
  };
  return h(
    'div',
    { class: 'empty' },
    h('div', { class: 'empty__mark' }),
    h('h3', { class: 'empty__title', text: 'Nothing matches that filter' }),
    h('p', { class: 'empty__query', text: `“${clamp(query, 40)}”` }),
    h('p', {
      class: 'empty__body',
      text: 'The filter looks at the conversation title, the project it ran in, and the agent that wrote it.',
    }),
    h('button', { class: 'empty__action', type: 'button', text: 'Clear the filter', onclick: clear }),
  );
}

function noConversations(doc) {
  const rescan = () => doc.getElementById('refresh')?.click();
  return h(
    'div',
    { class: 'empty' },
    h('div', { class: 'empty__mark empty__mark--record' }),
    h('h3', { class: 'empty__title', text: 'No conversations found' }),
    h('p', {
      class: 'empty__body',
      text: 'We looked for Claude Code, Codex, Cursor, Copilot and 30-odd other agents in their usual places on this machine, and found nothing yet.',
    }),
    h('button', { class: 'empty__action', type: 'button', text: 'Rescan', onclick: rescan }),
    h('p', { class: 'empty__hint', text: 'Or load the bundled sample stores from “Demo data” to see how this looks.' }),
  );
}

/** The line under the "Conversations" heading. */
export function summaryText({ catalog, capabilities }) {
  if (!catalog) return 'Scanning your disk…';
  const bits = [
    `${catalog.detectedHarnesses} of ${catalog.totalHarnesses} tools`,
    `${catalog.totalSessions} conversations`,
  ];
  if (catalog.platform?.name) bits.push(catalog.platform.name);
  if (capabilities?.requiresApiKey) bits.push('no API key');
  if (catalog.sqlite && catalog.sqlite.available === false) bits.push('no SQLite decoding');
  return bits.join(' · ');
}
