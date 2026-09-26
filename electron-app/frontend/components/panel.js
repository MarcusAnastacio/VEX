// VISUAL LAYER — the conversation panel: the empty state, the transcript, the payload
// view, and the generation settings.
//
// Expected to change. It renders view models and reports intent through callbacks; it
// never fetches and never decides what to generate.
//
// The six states a demo spends its time in are all rendered here, and none of them is
// allowed to be a blank rectangle: nothing selected, quizable, not quizable, the
// transcript folded away or open, the settings, and the notices. Where the backend has
// a reason string ("only 141 characters, need 400") this file is the only place that
// turns it into a sentence a stranger can act on, so the copy lives next to the
// thresholds it comes from rather than in app.js.

import { projectLabel } from '../lib/labels.js';

const h = (tag, props = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = value;
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

const timeAgo = (ms) => {
  if (!ms) return '';
  const days = Math.floor((Date.now() - ms) / 86400000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
};

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Topic labels come from the conversation and run to a paragraph. Chips do not. */
const clamp = (text, max) => {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
};

/** The backend caps the focus at 800 characters and redacts it like any other text. */
const FOCUS_MAX = 800;
/** A topic list longer than this is a wall, not information. */
const TOPIC_PREVIEW = 6;

/** What each role is called in the copy, rather than the raw key from the store. */
const ROLE_LABEL = { user: 'You', assistant: 'Agent', system: 'System', tool: 'Tool' };

// ── Transcript ─────────────────────────────────────────────────────────────

/**
 * Whether the transcript is open, per conversation.
 *
 * Presentational, like the step cursor in app.js: it must survive a re-render, and
 * app.js must not have to know about it. A Map rather than a boolean so switching back
 * to a conversation a demo already folded away does not spring it open again.
 */
const transcriptOpen = new Map();
const isOpen = (id) => transcriptOpen.get(id) !== false;

/** Everything the collapsed summary can say about a transcript, computed once. */
function transcriptStats(session) {
  const messages = session.messages || [];
  const chars = messages.reduce((n, m) => n + (m.text?.length || 0), 0);
  const tools = messages.reduce((n, m) => n + (m.tools?.length || 0), 0);
  const userTurns = messages.filter((m) => m.role === 'user').length;
  const bits = [plural(messages.length, 'message')];
  if (userTurns) bits.push(plural(userTurns, 'user turn'));
  if (tools) bits.push(plural(tools, 'tool call'));
  if (chars) bits.push(`${chars.toLocaleString('en-US')} characters`);
  return bits;
}

/** The transcript, one block per turn. `onTurnClick` receives the message index. */
export function renderTranscript(container, { session, onTurnClick } = {}) {
  container.replaceChildren();
  if (!session) return;

  const open = isOpen(session.id);
  const stats = transcriptStats(session);

  const toggle = h(
    'button',
    {
      class: 'btn btn--ghost transcript__toggle',
      type: 'button',
      'aria-expanded': String(open),
      onclick: () => {
        transcriptOpen.set(session.id, !open);
        renderTranscript(container, { session, onTurnClick });
      },
    },
    open ? 'Collapse' : 'Show transcript',
  );

  container.append(
    h('div', { class: 'transcript__bar' },
      h('div', { class: 'transcript__meta' },
        h('span', { class: 'transcript__title', text: 'Transcript' }),
        h('span', { class: 'transcript__stat', text: stats.join(' · ') }),
      ),
      toggle,
    ),
  );

  if (!open) {
    // Folded away is still a state with information in it: what is in here, and that it
    // is one click from being read.
    container.append(
      h('div', { class: 'transcript__summary' },
        h('span', { class: 'transcript__summarytext', text: 'The whole conversation, in the order it happened. Nothing in here is sent anywhere until you generate a quiz.' }),
        h('button', {
          class: 'transcript__reveal',
          type: 'button',
          onclick: () => {
            transcriptOpen.set(session.id, true);
            renderTranscript(container, { session, onTurnClick });
          },
        }, 'Read it'),
      ),
    );
    return;
  }

  for (const [index, message] of session.messages.entries()) {
    const tools = (message.tools || []).map((t) => t.name).filter(Boolean);
    const block = h(
      'div',
      { class: `msg msg--${message.role}` },
      h(
        'div',
        { class: 'msg__head' },
        h('span', { class: 'msg__role', text: ROLE_LABEL[message.role] || message.role }),
        tools.length > 0 && h('span', { class: 'msg__tools', text: tools.join(' · ') }),
        h('span', { class: 'msg__index', text: `#${index}` }),
      ),
      // textContent, never innerHTML: this text came out of another tool's store.
      // An empty turn gets a line of its own rather than an empty grey box, because a
      // blank rectangle reads as a rendering failure.
      h('div', {
        class: 'msg__body',
        text: (message.text || '').trim() || 'This turn has no text in the store.',
      }),
    );
    if (onTurnClick) {
      block.addEventListener('click', () => onTurnClick(index));
    }
    container.append(block);
  }
}

/** The subtitle line for a selected conversation. */
export function sessionSubtitle(session, { readiness } = {}) {
  if (!session) return '';
  const bits = [
    session.harnessName,
    // One readable project name, not the raw store path. `project` is frequently the
    // transcript filename ("codex/rollout-2026-07-17T...jsonl") and `cwd` repeats what the
    // label already says, which is how this header ended up printing a path nobody reads.
    // The fallback is dropped rather than printed: "Unknown project" is worse than silence.
    projectLabel(session) === 'Unknown project' ? null : projectLabel(session),
    plural(session.messages.length, 'message'),
    plural(session.userTurns, 'user turn'),
    timeAgo(session.updated),
  ].filter(Boolean);
  if (readiness && !readiness.ready) {
    // Not the reasons: the blocked card under this header says them in sentences, and
    // "only 26 characters, need 400; all 1 topic(s) are below 750 characters" printed
    // twice on one screen is noise, not information.
    bits.push('too short to quiz');
  }
  return bits.join(' · ');
}

// ── Settings ───────────────────────────────────────────────────────────────

/**
 * The generation settings, built from `capabilities` so no bound or label is duplicated
 * in the UI. `onChange({ questionCount, types, focus })` fires on every change.
 */
export function renderSettings(
  container, {
    capabilities, options, plan, readiness, busy,
    hasStoredQuiz = false, onChange = () => {}, onGenerate = null,
  } = {},
) {
  // Every keystroke in the focus box re-renders this whole panel, because app.js
  // re-plans on every change. Without this the textarea would be torn out from under
  // the caret on each character.
  const keep = captureFocus(container);
  container.replaceChildren();
  if (!capabilities) return;

  const types = capabilities.types || [];
  const enabled = new Set(options?.types || []);
  const ceiling =
    (capabilities.topics?.maxQuestionsPerType ?? capabilities.questionCount.max) * Math.max(1, enabled.size || 1);
  const max = Math.min(capabilities.questionCount.max, Math.max(1, ceiling));
  const value = Math.min(options?.questionCount ?? capabilities.questionCount.default, max);

  const setCount = (next) => {
    const clamped = Math.max(
      capabilities.questionCount.min,
      Math.min(max, Number(next) || capabilities.questionCount.default),
    );
    if (countInput) countInput.value = String(clamped);
    onChange({ ...options, questionCount: clamped });
  };

  const countInput = h('input', {
    class: 'settings__count',
    id: 'panel-count',
    type: 'number',
    min: String(capabilities.questionCount.min),
    max: String(max),
    step: String(capabilities.questionCount.step || 1),
    value: String(value),
    disabled: busy || undefined,
    onchange: (e) => setCount(e.target.value),
  });

  const toggles = types.map((type) =>
    h(
      'label',
      { class: 'settings__type', title: type.description },
      h('input', {
        type: 'checkbox',
        checked: enabled.has(type.id),
        disabled: busy || undefined,
        onchange: (e) => {
          const next = new Set(enabled);
          if (e.target.checked) next.add(type.id);
          else next.delete(type.id);
          onChange({ ...options, types: [...next] });
        },
      }),
      h('span', { class: 'settings__chip' },
        h('span', { class: 'settings__tick', text: '✓' }),
        h('span', { class: 'settings__chiplabel', text: type.label }),
        type.needsGrading && h('span', { class: 'settings__flag', text: 'graded' }),
      ),
    ),
  );

  const graded = types.filter((t) => enabled.has(t.id) && t.needsGrading);

  container.append(
    h('div', { class: `settings${busy ? ' settings--busy' : ''}` },
      // The dead end, and what to do instead of sitting in it.
      readiness && readiness.ready === false ? blockedCard({ readiness, capabilities }) : null,

      h('div', { class: 'settings__block' },
        h('div', { class: 'settings__labelrow' },
          h('span', { class: 'settings__label', text: 'Questions' }),
          h('span', { class: 'settings__labelhint', text: 'How many questions to ask' }),
        ),
        h('div', { class: 'settings__row' },
          h('div', { class: 'stepper' },
            h('button', {
              class: 'stepper__btn', type: 'button', 'aria-label': 'One question fewer',
              disabled: busy || value <= capabilities.questionCount.min || undefined,
              onclick: () => setCount(value - (capabilities.questionCount.step || 1)),
            }, '−'),
            countInput,
            h('button', {
              class: 'stepper__btn', type: 'button', 'aria-label': 'One question more',
              disabled: busy || value >= max || undefined,
              onclick: () => setCount(value + (capabilities.questionCount.step || 1)),
            }, '+'),
          ),
          h('span', {
            class: 'settings__hint',
            text: `${capabilities.flashcards.perTopic} flashcards per topic come first, then these.`,
          }),
        ),
      ),

      h('div', { class: 'settings__block' },
        h('div', { class: 'settings__labelrow' },
          h('span', { class: 'settings__label', text: 'Question types' }),
          h('span', { class: 'settings__labelhint', text: 'Turn one off to focus the quiz' }),
        ),
        h('div', { class: 'settings__row settings__row--types' }, ...toggles),
        h('p', {
          class: 'settings__hint',
          text: graded.length
            ? `${graded.map((t) => t.label).join(' and ')} answers are scored by the model against a rubric, so those take a moment longer.`
            : 'Flashcards only. Nothing here needs the model to grade an answer.',
        }),
      ),

      focusBlock({ options, busy, onChange }),

      busy ? busyBlock(plan) : planBlock({ plan, readiness, capabilities }),

      onGenerate
        ? h('div', { class: 'settings__actions' },
            h('button', {
              class: 'btn btn--primary settings__go',
              type: 'button',
              text: hasStoredQuiz ? 'Start generation' : 'Generate quiz',
              disabled: busy || readiness?.ready === false || undefined,
              onclick: onGenerate,
            }),
            h('span', {
              class: 'settings__hint',
              text: hasStoredQuiz
                ? 'Replaces the stored quiz, and the answers you have given it.'
                : 'One model call per topic. Usually under a minute.',
            }),
          )
        : null,
    ),
  );

  restoreFocus(container, keep);
}

/**
 * The optional focus, the one setting the backend supports and the UI never showed.
 * It goes to the model as an emphasis instruction, so it is the difference between
 * "a quiz about this conversation" and "a quiz about the part I have forgotten".
 */
function focusBlock({ options, busy, onChange }) {
  const initial = String(options?.focus || '');
  const counter = h('span', { class: 'settings__counter', id: 'panel-focus-count', text: `${initial.length} / ${FOCUS_MAX}` });
  const textarea = h('textarea', {
    class: 'settings__focus',
    id: 'panel-focus',
    rows: '2',
    maxlength: String(FOCUS_MAX),
    placeholder: 'e.g. the retry logic, and why we ended up with one queue',
    disabled: busy || undefined,
    oninput: (e) => {
      const text = e.target.value;
      counter.textContent = `${text.length} / ${FOCUS_MAX}`;
      // Re-planning on every keystroke would fire four requests per character.
      clearTimeout(focusBlock.timer);
      focusBlock.timer = setTimeout(() => {
        if ((options?.focus || '') === text) return;
        onChange({ ...options, focus: text });
      }, 400);
    },
  });
  textarea.value = initial;

  return h('div', { class: 'settings__block' },
    h('div', { class: 'settings__labelrow' },
      h('span', { class: 'settings__label', text: 'Focus' }),
      h('span', { class: 'settings__labelhint', text: 'Optional' }),
      counter,
    ),
    textarea,
  );
}

/**
 * The working state. It has to say what is happening, because a generation that takes
 * a minute with no feedback is indistinguishable from a hung app.
 */
function busyBlock(plan) {
  const topics = plan?.selectedTopics?.length || 0;
  return h('div', { class: 'busy', role: 'status', 'aria-live': 'polite' },
    h('div', { class: 'busy__head' },
      h('span', { class: 'busy__spinner', 'aria-hidden': 'true' }),
      h('span', { class: 'busy__title', text: 'Generating your quiz' }),
    ),
    h('div', { class: 'busy__bar', 'aria-hidden': 'true' }, h('span', { class: 'busy__fill' })),
    h('p', {
      class: 'busy__body',
      text: topics
        ? `Reading the transcript and asking the model for ${plural(topics, 'topic')} of questions at a time. The transcript below stays where it is.`
        : 'Reading the transcript and asking the model for questions. The transcript below stays where it is.',
    }),
  );
}

/** What the current settings would produce, and what they cost. */
function planBlock({ plan, readiness, capabilities }) {
  if (readiness && readiness.ready === false) return null;
  if (!plan?.plan) return null;

  const topics = plan.selectedTopics || [];
  const bits = [
    `${plural(topics.length, 'topic')}`,
    `${plan.expectedFlashcards} flashcards`,
    `${plan.expectedQuestions} ${plan.expectedQuestions === 1 ? 'question' : 'questions'}`,
  ];
  const shown = topics.slice(0, TOPIC_PREVIEW);
  const rest = topics.length - shown.length;
  const floor = capabilities?.readiness?.minChars;
  const chars = readiness?.stats?.chars;

  return h('div', { class: 'settings__plan' },
    h('div', { class: 'settings__labelrow' },
      h('span', { class: 'settings__label', text: 'What you will get' }),
      h('span', { class: 'settings__hint', text: bits.join(' · ') }),
    ),
    topics.length
      ? h('div', { class: 'settings__topics' },
          ...shown.map((topic) => h('span', {
            class: 'chip',
            title: topic.label || 'Untitled topic',
            text: clamp(topic.label || 'Untitled topic', 46),
          })),
          rest > 0 && h('span', { class: 'chip chip--more', text: `+${rest} more` }),
        )
      : h('p', { class: 'settings__hint', text: 'No topics could be derived from this conversation yet.' }),
    plan.shortfall > 0
      ? h('p', { class: 'settings__notice' },
          'This conversation can carry ',
          h('strong', { text: `${plan.expectedQuestions} of the ${plan.requestedQuestions}` }),
          ' questions you asked for. Lower the count, or turn on another type.',
        )
      : floor && chars
        ? h('p', { class: 'settings__hint', text: `${chars.toLocaleString('en-US')} characters of conversation, which clears the ${floor} character floor.` })
        : null,
  );
}

/**
 * A conversation that cannot carry a quiz.
 *
 * The backend answers with reasons like "only 141 characters, need 400". Shown raw that
 * is a dead end with a number in it. This turns each reason into a sentence and adds
 * the two things that make it actionable: which floor it missed, and what to pick
 * instead.
 */
function blockedCard({ readiness, capabilities }) {
  const reasons = (readiness.reasons || []).map(plainReason).filter(Boolean);
  const stats = readiness.stats || {};
  const floors = capabilities?.readiness || {};
  const what = {
    empty: 'This entry has no conversation in it: the store was found but nothing could be read out of it.',
    thin: 'There is not enough here to ask a real question about.',
    partial: 'Only part of this conversation is thick enough to quiz.',
  }[readiness.level] || 'This conversation cannot carry a quiz.';

  return h('div', { class: 'blocked' },
    h('div', { class: 'blocked__head' },
      h('span', { class: 'blocked__mark', 'aria-hidden': 'true' }),
      h('div', { class: 'blocked__titles' },
        h('p', { class: 'blocked__title', text: what }),
        // Only when the backend gave no usable reason: otherwise the reasons below
        // already carry the numbers, and saying them twice reads as two facts.
        reasons.length
          ? null
          : h('p', {
              class: 'blocked__sub',
              text: stats.chars && floors.minChars
                ? `${stats.chars.toLocaleString('en-US')} characters of conversation, where a quiz needs ${floors.minChars}.`
                : 'The generator could not find a question worth asking here.',
            }),
      ),
    ),
    reasons.length
      ? h('ul', { class: 'blocked__reasons' }, ...reasons.map((r) => h('li', { text: r })))
      : null,
    h('p', {
      class: 'blocked__next',
      text: readiness.level === 'empty'
        ? 'What to do instead: pick another conversation. The list puts the ones that can carry a quiz at the top, and the transcript below still shows what was stored here.'
        : 'What to do instead: pick a longer conversation, ideally one with a couple of real exchanges in it. The list marks the ones that can carry a quiz, and you can still read this transcript below.',
    }),
  );
}

/** "only 141 characters, need 400" -> a sentence. Unknown shapes pass through. */
function plainReason(reason) {
  const text = String(reason || '').trim();
  let m = /^only (\d+) user turns?, need (\d+)$/.exec(text);
  if (m) return `It has ${plural(Number(m[1]), 'user turn')}. A quiz needs at least ${m[2]}.`;
  m = /^only (\d+) characters, need (\d+)$/.exec(text);
  if (m) return `It holds ${Number(m[1]).toLocaleString('en-US')} characters of conversation. A quiz needs at least ${Number(m[2]).toLocaleString('en-US')}.`;
  m = /^all (\d+) topic\(s\) are below (\d+) characters$/.exec(text);
  if (m) return `Every one of its ${m[1]} topics is under ${Number(m[2]).toLocaleString('en-US')} characters, which is too little to ask a question about.`;
  if (text === 'no topic could be derived') return 'Nothing in it reads as a task with an answer, so there is nothing to ask about.';
  if (text === 'no-session') return 'That conversation could not be read back from disk.';
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : '';
}

// ── Notices and staleness ──────────────────────────────────────────────────

/** The gap notice when a stored quiz exists but the conversation has moved on. */
export function renderStaleness(
  container,
  { staleness, sessionsAvailable = false, onExtend, onRegenerate, notice, onDismiss } = {},
) {
  container.replaceChildren();

  // Errors and warnings first: they are the reason the rest of the strip is showing.
  if (notice?.text) {
    container.append(
      h('div', { class: `notice notice--${notice.level === 'error' ? 'error' : 'warn'}`, role: 'alert' },
        h('span', { class: 'notice__mark', 'aria-hidden': 'true' }),
        h('div', { class: 'notice__body' },
          h('p', { class: 'notice__title', text: notice.title || (notice.level === 'error' ? 'That did not work' : 'Worth knowing') }),
          h('p', { class: 'notice__text', text: String(notice.text) }),
          notice.level !== 'error' && sessionsAvailable === false
            ? h('p', { class: 'notice__hint', text: 'Rescan from the sidebar to pick up conversations added since the last scan.' })
            : null,
        ),
        onDismiss
          ? h('button', { class: 'notice__close', type: 'button', 'aria-label': 'Dismiss', onclick: onDismiss }, '×')
          : null,
      ),
    );
  }

  if (!staleness || staleness.state === 'new' || staleness.state === 'fresh') return;

  const copy = {
    extended: {
      title: 'The conversation has moved on',
      body: `${plural(staleness.newMessages, 'message')} arrived after this quiz was built.`,
      action: onExtend ? h('button', { class: 'btn', type: 'button', text: 'Quiz me on the new part', onclick: onExtend }) : null,
      note: 'Adds questions for the new turns and keeps the ones you already have.',
    },
    diverged: {
      title: 'The quiz and the conversation no longer match',
      body: 'The part of this conversation the stored quiz was built from has changed.',
      action: onRegenerate ? h('button', { class: 'btn', type: 'button', text: 'Regenerate', onclick: onRegenerate }) : null,
      note: 'Regenerating replaces the stored quiz, and the answers you have given it.',
    },
    settings_changed: {
      title: 'Your settings have changed',
      body: 'The stored quiz was built with different settings from the ones selected now.',
      action: onRegenerate ? h('button', { class: 'btn', type: 'button', text: 'Regenerate', onclick: onRegenerate }) : null,
      note: 'Regenerating replaces the stored quiz, and the answers you have given it.',
    },
    generator_stale: {
      title: 'Made by an older generator',
      body: 'The stored quiz came from a version of the generator that no longer matches this one.',
      action: onRegenerate ? h('button', { class: 'btn', type: 'button', text: 'Regenerate', onclick: onRegenerate }) : null,
      note: 'Regenerating replaces the stored quiz, and the answers you have given it.',
    },
  }[staleness.state];
  if (!copy) return;

  container.append(
    h('div', { class: `stale stale--${staleness.state}` },
      h('span', { class: 'stale__mark', 'aria-hidden': 'true' }),
      h('div', { class: 'stale__text' },
        h('p', { class: 'stale__title', text: copy.title }),
        h('p', { class: 'stale__body', text: copy.body }),
      ),
      copy.action ? h('div', { class: 'stale__actions' }, copy.action) : null,
      h('p', { class: 'stale__note', text: copy.note }),
    ),
  );
}

// ── Payload ────────────────────────────────────────────────────────────────

/**
 * The raw payload view, with its redaction report.
 *
 * Everything here goes inside a <pre>, so the report is built from spans rather than
 * divs: block elements are not valid inside a pre and browsers are entitled to
 * reflow them around.
 */
export function renderPayload(container, { payload } = {}) {
  container.replaceChildren();
  if (!payload) return;

  if (payload.redaction?.total > 0) {
    const kinds = Object.entries(payload.redaction.byKind).map(([k, n]) => `${k} ×${n}`).join(', ');
    container.append(
      h('span', { class: 'redaction' },
        h('span', { class: 'redaction__mark', 'aria-hidden': 'true' }),
        h('span', { class: 'redaction__text' },
          h('strong', { text: `${plural(payload.redaction.total, 'secret')} redacted before sending` }),
          h('span', { text: `, ${kinds}. This is the only place anything leaves the machine, and nothing below has been sent yet.` }),
        ),
      ),
      h('span', { class: 'payload__divider' }, '↓ the payload as the model will see it'),
    );
  }

  container.append(document.createTextNode(JSON.stringify(payload, null, 2)));
}

export function payloadSubtitle(payload) {
  if (!payload) return '';
  const size = JSON.stringify(payload).length;
  const bits = [
    `${payload.messages?.length ?? 0} of ${payload.messageCount ?? 0} messages`,
    `${size.toLocaleString('en-US')} chars`,
    payload.truncated ? 'truncated to fit the model window' : null,
    payload.redaction?.total ? `${payload.redaction.total} redacted` : 'nothing redacted',
  ];
  return bits.filter(Boolean).join(' · ');
}

// ── Focus preservation ─────────────────────────────────────────────────────

/** app.js re-renders the whole panel on every state change, so remember the caret. */
function captureFocus(container) {
  const active = document.activeElement;
  if (!active || !container.contains(active) || !active.id) return null;
  return {
    id: active.id,
    value: typeof active.value === 'string' ? active.value : null,
    start: active.selectionStart ?? null,
    end: active.selectionEnd ?? null,
  };
}

function restoreFocus(container, keep) {
  if (!keep) return;
  const next = container.querySelector(`#${keep.id}`) || document.getElementById(keep.id);
  if (!next) return;
  // The re-render rebuilds the field from store state, which can be a beat behind what
  // has been typed since the last debounce. Put the caret's own value back so a fast
  // typist does not lose characters to a panel redraw.
  if (keep.value != null && next.value !== keep.value) {
    next.value = keep.value;
    const counter = document.getElementById('panel-focus-count');
    if (counter) counter.textContent = `${keep.value.length} / ${FOCUS_MAX}`;
  }
  next.focus();
  if (keep.start != null && typeof next.setSelectionRange === 'function') {
    try {
      next.setSelectionRange(keep.start, keep.end);
    } catch {
      // Number inputs reject setSelectionRange in some engines. The focus is what matters.
    }
  }
}
