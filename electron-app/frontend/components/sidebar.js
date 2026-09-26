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

function row(session, { selectedId, onSelect, ready }) {
  const label = projectLabel(session);
  const when = timeAgo(session.updated);
  // On a ready row the harness is the heading, because the row sits outside a group. On
  // a grouped row the group header already says it.
  const middle = ready
    ? (isSameName(label, session.harnessName) ? countLabel(session.messageCount) : label)
    : label;
  return h(
    'button',
    {
      class: ready ? 'row row--ready' : 'row',
      type: 'button',
      'aria-current': String(selectedId === session.id),
      title: `${session.title}\n${label}\n${session.messageCount} messages`
        + (ready ? '' : '\nToo short to quiz from'),
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
    ...items.map((session) => row(session, { ...options, ready: !!options.ready })),
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

  // Ready sessions lead, everything else below a labelled divider.
  //
  // Both halves were on the table: sorting ready-first inside the existing per-harness
  // groups, and de-emphasising the thin rows. Grouping won for the thin rows and lost for
  // the ready ones — with 33 harness groups, a ready session sorted to the top of *its*
  // group is still several screens down, so the list would still open on a dead row.
  // Ready-first puts the three conversations that can actually make a quiz in the first
  // screenful, and one divider replaces 37 repetitions of the word "short".
  const ready = shown.filter((s) => s.quizReady).sort(byNewest);
  const rest = shown.filter((s) => !s.quizReady).sort(byNewest);

  if (ready.length) {
    container.append(section('Ready to quiz', ready.length, ready, {
      sectionClass: 'group--ready', ready: true, selectedId, onSelect,
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
      container.append(section(name, items.length, items, { selectedId, onSelect }));
    }
  }
  // app.js writes the footer hint AFTER calling this, so the decision above is made
  // against last render's hint. Re-check on the next frame and redraw once if the scan
  // state moved; this settles the strip the moment a scan finishes.
  if (typeof requestAnimationFrame === 'function') {
    const props = { sessions, selectedId, filter, onSelect };
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
