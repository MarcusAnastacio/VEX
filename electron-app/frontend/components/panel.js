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

/** Below this the transcript has barely started, so there is nothing to go back from. */
const BACK_TO_TOP_AT = 240;

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

// ── Panel body ─────────────────────────────────────────────────────────────

/**
 * The whole conversation panel body, in one container and one pass.
 *
 * Three things live here, because they are the three things a user does with a
 * conversation before asking a model questions about it: read the settings, choose
 * which topics the quiz should be built from, and reopen a quiz that already exists.
 *
 * Props, all optional except the ones the settings form needs:
 *
 *   capabilities, options, plan, readiness, busy, hasStoredQuiz   the settings form
 *   onChange({ ...options })   onGenerate()                        the settings form
 *   view             'transcript' | 'generate' | 'quiz'. Absent means 'generate',
 *                    which is how the panel rendered before the view machine existed.
 *   topics           the topic list, as an array or as the whole api.topics() reply
 *   quizzes          the saved-quiz list for this conversation
 *   topicSelection   the topic ids currently chosen, or null to follow the plan
 *   onTopicSelectionChange(ids)   onQuizOpen(id)   onQuizResume(id)   onTopicReveal(id)
 *
 * The settings form is rendered only in the generate view. The topics area and the
 * saved-quiz list are rendered in both views that show a conversation, because both
 * are ways of deciding what to study rather than settings for the generator.
 */
export function renderSettings(container, props = {}) {
  renderPanelBody(container, props);
}

function renderPanelBody(container, props) {
  const {
    capabilities, options, plan, readiness, busy,
    hasStoredQuiz = false, onChange = () => {}, onGenerate = null,
    view = 'generate', topics = null, quizzes = null, topicSelection = null,
    onTopicSelectionChange = null, onQuizOpen = null, onQuizResume = null, onTopicReveal = null,
  } = props;

  // Every keystroke in the focus box re-renders this whole panel, because app.js
  // re-plans on every change. Without this the textarea would be torn out from under
  // the caret on each character.
  const keep = captureFocus(container);
  container.replaceChildren();
  if (view === 'quiz') return;

  const allTopics = normaliseTopics(topics, plan);
  const chosen = resolveSelection(topicSelection, plan, allTopics);
  // The selection is reported upwards, but the panel also re-renders itself with it:
  // until app.js has the new ids back, the drop zone would still show the old ones.
  const paint = (selection) => renderPanelBody(container, { ...props, topicSelection: selection });
  const commit = (selection) => {
    if (onTopicSelectionChange) onTopicSelectionChange(selection);
    paint(selection);
  };

  const picker = {
    allTopics,
    chosen,
    busy: Boolean(busy),
    onToggle: (id) => commit(chosen.includes(id) ? chosen.filter((x) => x !== id) : [...chosen, id]),
    onRandomise: () => commit(sampleTopics(allTopics, topicsNeeded({ options, plan }))),
    onReveal: onTopicReveal,
  };

  container.append(
    h('div', { class: 'panel' },
      // The settings form is the generate view and nothing else. The payload it builds
      // is only reachable from here, so a transcript that happens to have a stored
      // quiz still cannot generate a new one by accident.
      capabilities && view === 'generate'
        ? settingsForm({ capabilities, options, plan, readiness, busy, hasStoredQuiz, onChange, onGenerate })
        : null,
      topicsSection(picker),
      h('div', { class: 'panel__pair' },
        dropzoneSection({ ...picker, plan, options, capabilities }),
        savedQuizzesSection({ quizzes, onOpen: onQuizOpen, onResume: onQuizResume }),
      ),
    ),
  );

  mountBackToTop(container);
  restoreFocus(container, keep);
}

/**
 * The generation settings, built from `capabilities` so no bound or label is duplicated
 * in the UI. `onChange({ questionCount, types, focus })` fires on every change.
 */
function settingsForm({
  capabilities, options, plan, readiness, busy,
  hasStoredQuiz = false, onChange = () => {}, onGenerate = null,
}) {

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

  // Flashcards per topic. Same shape as the question stepper, because it is the same
  // decision: a number with a floor and a ceiling. The range comes from the backend
  // rather than being restated here, so the control cannot offer a count the planner
  // or the generator would then clamp behind the user's back.
  const cards = capabilities.flashcards || {};
  const cardStep = cards.step || 1;
  const cardMin = Number(cards.min ?? 1);
  const cardMax = Number(cards.max ?? cards.perTopic ?? 2);
  const cardDefault = Number(cards.default ?? cards.perTopic ?? 2);
  const cardValue = Math.max(cardMin, Math.min(cardMax, Number(options?.flashcardsPerTopic ?? cardDefault)));

  const setCards = (next) => {
    const clamped = Math.max(cardMin, Math.min(cardMax, Number(next) || cardDefault));
    if (cardInput) cardInput.value = String(clamped);
    onChange({ ...options, flashcardsPerTopic: clamped });
  };

  const cardInput = h('input', {
    class: 'settings__count',
    id: 'panel-flashcards',
    type: 'number',
    min: String(cardMin),
    max: String(cardMax),
    step: String(cardStep),
    value: String(cardValue),
    disabled: busy || undefined,
    onchange: (e) => setCards(e.target.value),
  });

  const cardStepper = h('div', { class: 'stepper' },
    h('button', {
      class: 'stepper__btn', type: 'button', 'aria-label': 'One flashcard fewer',
      disabled: busy || cardValue <= cardMin || undefined,
      onclick: () => setCards(cardValue - cardStep),
    }, '−'),
    cardInput,
    h('button', {
      class: 'stepper__btn', type: 'button', 'aria-label': 'One flashcard more',
      disabled: busy || cardValue >= cardMax || undefined,
      onclick: () => setCards(cardValue + cardStep),
    }, '+'),
  );

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

  return h('div', { class: `settings${busy ? ' settings--busy' : ''}` },
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
          // No number here any more: the count has a control of its own one block
          // down, and a number printed twice is a number that can be wrong twice.
          text: 'Flashcards come first, then these.',
        }),
      ),
    ),

    h('div', { class: 'settings__block' },
      h('div', { class: 'settings__labelrow' },
        h('span', { class: 'settings__label', text: 'Flashcards' }),
        h('span', { class: 'settings__labelhint', text: 'How many to learn from, for each topic' }),
      ),
      h('div', { class: 'settings__row' },
        cardStepper,
        h('span', { class: 'settings__hint', text: cards.note || 'Every topic you quiz gets this many, before the questions.' }),
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

    busy
      ? busyBlock(plan, { topics: plan?.selectedTopics, options, capabilities })
      : planBlock({ plan, readiness, capabilities }),

    onGenerate
      ? h('div', { class: 'settings__actions' },
          h('button', {
            class: 'btn btn--primary settings__go',
            type: 'button',
            // Never "Generate quiz": that is the header button's string, and two
            // buttons that differ by one word are the same button twice.
            text: hasStoredQuiz ? 'Regenerate' : 'Generate',
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
  );
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
 *
 * The three stages are real: the backend reads and groups the transcript, picks the
 * topics, and only then makes one model call per topic. Showing them as a list that
 * lights up in turn is more honest than one bar that fills at a rate nobody asked for,
 * and it is the difference between "waiting" and "hung".
 */
function busyBlock(plan, { topics = null, options = null, capabilities = null } = {}) {
  const selected = plan?.selectedTopics || topics || [];
  const count = selected.length;
  const perTopic = flashcardsPerTopic(plan, capabilities, options);
  const types = new Set([...(options?.types || []), ...(plan?.types || [])]);
  const questions = plan?.expectedQuestions;

  const stages = [
    ['Reading the transcript', 'Every turn is loaded and grouped into topics.'],
    ['Choosing what to ask about', count
      ? `${plural(count, 'topic')} in the deck, at ${plural(perTopic, 'flashcard')} each.`
      : 'Working out which topics can carry a question.'],
    ['Writing the questions', questions
      ? `One model call per topic, ${plural(questions, 'question')} in all.`
      : `${types.size ? `One model call per topic, for ${[...types].length} ${types.size === 1 ? 'type' : 'types'}.` : 'Flashcards only, so nothing needs grading.'}`],
  ];

  return h('div', { class: 'busy', role: 'status', 'aria-live': 'polite' },
    h('div', { class: 'busy__head' },
      h('span', { class: 'busy__spinner', 'aria-hidden': 'true' }),
      h('span', { class: 'busy__title', text: 'Generating your quiz' }),
    ),
    h('div', { class: 'busy__bar', 'aria-hidden': 'true' },
      h('span', { class: 'busy__fill' }),
      h('span', { class: 'busy__sweep' }),
    ),
    h('ol', { class: 'busy__stages' },
      ...stages.map(([label, detail], index) => h(
        'li',
        { class: `busy__stage busy__stage--${index + 1}` },
        h('span', { class: 'busy__dot', 'aria-hidden': 'true' }),
        h('span', { class: 'busy__stagetext' },
          h('span', { class: 'busy__stagelabel', text: label }),
          h('span', { class: 'busy__stagedetail', text: detail }),
        ),
      )),
    ),
    count
      ? h('ul', { class: 'busy__topics', 'aria-hidden': 'true' },
          ...selected.map((topic) => h('li', {
            class: 'busy__topic',
            text: clamp(topic.label || 'Untitled topic', 40),
          })),
        )
      : null,
    h('p', {
      class: 'busy__body',
      text: 'The transcript below stays where it is, and you can keep reading while this finishes.',
    }),
  );
}

/**
 * Flashcards per topic, in the order of authority: what the user chose, then what the
 * plan was built with, then the shipped default.
 *
 * The user\'s value has to win. A panel that said "2 flashcards" next to a control set
 * to 5 would be describing a quiz nobody is going to be given, and the drop zone rows
 * are read as a promise about what comes back.
 */
function flashcardsPerTopic(plan, capabilities, options = null) {
  return Number(options?.flashcardsPerTopic)
    || Number(plan?.plan?.flashcardsPerTopic)
    || Number(capabilities?.flashcards?.perTopic)
    || Number(capabilities?.flashcards?.default)
    || 2;
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
  const floor = capabilities?.readiness?.minChars;
  const chars = readiness?.stats?.chars;

  return h('div', { class: 'settings__plan' },
    h('div', { class: 'settings__labelrow' },
      // Not "What you will get": that heading belongs to the topic picker below, which
      // is the one the user actually operates. Two sections cannot own one name.
      h('span', { class: 'settings__label', text: 'Planned topics' }),
      h('span', { class: 'settings__hint', text: bits.join(' · ') }),
    ),
    topics.length
      ? h('div', { class: 'settings__topics' },
          // Every one of them, not a preview: the plan is already capped by the
          // backend at maxTopics, and a truncated deck reads as a shorter plan.
          ...topics.map((topic) => h('span', {
            class: 'chip',
            title: topic.label || 'Untitled topic',
            text: clamp(topic.label || 'Untitled topic', 46),
          })),
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

// ── Topics, what you will get, and saved quizzes ───────────────────────────

/**
 * One topic row, whichever shape it arrived in.
 *
 * Two producers write topics into this panel and they are not the same shape.
 * api.topics() returns a full derivation ({ id, label, chars, exchanges, files, from,
 * to, messageRanges, tools, score, ... }); planQuiz returns only what the generator
 * needs for a deck entry ({ id, label, messageRanges, files, score, chars }). The
 * length line below is the honest merge of the two: characters are always there,
 * exchanges exist only in the full derivation and are omitted rather than guessed.
 */
function normaliseTopics(topics, plan) {
  const list = Array.isArray(topics)
    ? topics
    : Array.isArray(topics?.topics)
      ? topics.topics
      : Array.isArray(topics?.selectedTopics)
        ? topics.selectedTopics
        : plan?.selectedTopics || [];

  const planned = new Set((plan?.selectedTopics || []).map((t) => t.id));
  return list
    .filter((t) => t && t.id != null)
    .map((t) => ({
      id: String(t.id),
      label: t.label || 'Untitled topic',
      chars: Number(t.chars) || 0,
      exchanges: Number.isFinite(Number(t.exchanges)) ? Number(t.exchanges) : null,
      files: t.files || [],
      messageRanges: t.messageRanges || [],
      from: Number.isFinite(Number(t.from)) ? Number(t.from) : null,
      planned: planned.has(t.id),
    }))
    // The list reads in the order the conversation happened, when the backend told us
    // where each topic starts, and in the order given otherwise.
    .sort((a, b) => (a.from ?? 0) - (b.from ?? 0) || a.id.localeCompare(b.id, 'en', { numeric: true }));
}

/** How long a topic is, in the words the backend's own fields support. */
function lengthLine(topic) {
  const bits = [`${(topic.chars || 0).toLocaleString('en-US')} ${topic.chars === 1 ? 'character' : 'characters'}`];
  if (topic.exchanges != null) bits.push(plural(topic.exchanges, 'exchange'));
  if (topic.files?.length) bits.push(plural(topic.files.length, 'file'));
  return bits.join(' · ');
}

/**
 * The chosen topic ids, in the order the topics themselves are listed.
 *
 * `topicSelection` is the truth once app.js has one: an explicit choice outranks the
 * automatic plan, and an empty array is a real answer meaning "none of them". Until
 * then the plan's own selection is shown, so the drop zone is never blank while the
 * generator is quietly using three topics.
 */
const selection = { key: null, ids: null };
function resolveSelection(topicSelection, plan, allTopics) {
  const known = new Set(allTopics.map((t) => t.id));
  const given = Array.isArray(topicSelection) ? topicSelection.map(String).filter((id) => known.has(id)) : null;
  // Empty means "the automatic selection", not "no topics": that is what an empty
  // topicIds means to the backend, so showing an empty drop zone while the plan is
  // quietly using four topics would be a lie.
  const explicit = given && given.length ? given : null;
  const key = explicit ? explicit.join('|') : null;
  // Only a change to the prop resets the local copy, so a selection the user just
  // made survives the re-render it caused, and an unrelated state change does not
  // silently drop it.
  if (selection.ids === null || key !== selection.key) {
    selection.key = key;
    selection.ids = explicit ?? (plan?.selectedTopics || []).map((t) => String(t.id)).filter((id) => known.has(id));
  }
  return allTopics.filter((t) => selection.ids.includes(t.id)).map((t) => t.id);
}

/**
 * How many topics a question count actually needs.
 *
 * The backend puts one question per topic per enabled type, so N questions over T
 * types needs N/T topics, rounded up, and never fewer than one. Getting this wrong in
 * the randomise button is visible immediately: it either drops topics the deck could
 * have used or promises more than the count can pay for.
 */
function topicsNeeded({ options, plan }) {
  // planQuiz already answers this question in `requestedTopics`, so use its number
  // when there is a plan and only derive it here when there is not (a panel mounted
  // before the first plan lands).
  const asked = Number(plan?.requestedTopics);
  if (Number.isFinite(asked) && asked > 0) return asked;
  const count = Number(options?.questionCount ?? plan?.requestedQuestions ?? plan?.questionCount ?? 0);
  const types = (options?.types ?? plan?.types ?? []).filter(Boolean);
  if (types.length === 0) return 1;
  return Math.max(1, Math.ceil(Math.max(0, count) / types.length));
}

/** N topics at random, which is the whole point of the automatic selection anyway. */
function sampleTopics(allTopics, count) {
  if (!allTopics.length) return [];
  const pool = [...allTopics];
  for (let i = pool.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, Math.max(1, Math.min(count, pool.length))).map((t) => t.id);
}

/**
 * "Conversation topics": every topic the backend found, and how long each one is.
 *
 * The complete list, not the first six. A topic that cannot be seen is a topic that
 * cannot be chosen, and the count is the information this section exists to give.
 */
function topicsSection({ allTopics, chosen, busy, onToggle, onReveal }) {
  const list = h('ul', { class: 'topics__list' },
    ...allTopics.map((topic) => {
      const selected = chosen.includes(topic.id);
      // Without onReveal there is nothing to scroll to, so the label is not a button:
      // an affordance that does nothing is worse than plain text.
      const label = onReveal
        ? h('button', {
            class: 'topic__name',
            type: 'button',
            title: 'Show this topic in the transcript',
            onclick: () => onReveal(topic.id),
          },
            h('span', { class: 'topic__label', text: clamp(topic.label, 120) }),
            h('span', { class: 'topic__meta', text: lengthLine(topic) }),
          )
        : h('span', { class: 'topic__name topic__name--plain' },
            h('span', { class: 'topic__label', text: clamp(topic.label, 120) }),
            h('span', { class: 'topic__meta', text: lengthLine(topic) }),
          );

      const item = h('li', {
        class: `topic${selected ? ' topic--on' : ''}`,
        draggable: busy ? null : 'true',
        'data-topic': topic.id,
        ondragstart: (event) => {
          event.dataTransfer.effectAllowed = 'copy';
          // text/plain as well as the custom type: Chromium refuses a custom format
          // on a drag that started outside a same-origin frame, and this is the only
          // channel the drop zone has to read.
          event.dataTransfer.setData('text/plain', topic.id);
          event.dataTransfer.setData('application/x-topic-id', topic.id);
          item.classList.add('topic--dragging');
        },
        ondragend: () => item.classList.remove('topic--dragging'),
      },
        label,
        h('button', {
          class: 'topic__toggle',
          type: 'button',
          disabled: busy || undefined,
          'aria-pressed': String(selected),
          title: selected ? 'Take this topic out of the quiz' : 'Put this topic in the quiz',
          onclick: () => onToggle(topic.id),
        }, selected ? 'Remove' : 'Add'),
      );
      return item;
    }),
  );

  return h('section', { class: 'topics' },
    h('div', { class: 'panel__head' },
      h('span', { class: 'panel__label', text: 'Conversation topics' }),
      h('span', {
        class: 'panel__hint',
        text: allTopics.length
          ? `${allTopics.length} found · ${chosen.length} chosen`
          : 'None found in this conversation yet',
      }),
    ),
    allTopics.length
      ? list
      : h('p', {
          class: 'panel__empty',
          text: 'Nothing in this conversation reads as a task with an answer, so there is nothing to ask about.',
        }),
  );
}

/**
 * "What you will get": the drop zone, and what each topic in it is worth.
 *
 * The empty state is one sentence and nothing else, because it is an instruction and
 * any second line is one more thing to read. Once topics are in, the section earns
 * its width by saying what each of them produces: the length the generator will send,
 * and the cards and questions that come back.
 */
function dropzoneSection({ allTopics, chosen, busy, onToggle, onRandomise, plan, options, capabilities }) {
  const selected = allTopics.filter((t) => chosen.includes(t.id));
  const perTopic = flashcardsPerTopic(plan, capabilities, options);
  const typeCount = Math.max(0, (options?.types ?? plan?.types ?? []).filter(Boolean).length);
  const deck = new Map((plan?.deck || []).map((d) => [String(d.topicId), d]));

  const zone = h('div', {
    class: `dropzone${selected.length ? ' dropzone--filled' : ''}`,
    'aria-label': 'Chosen topics',
    ondragover: (event) => {
      if (busy) return;
      // preventDefault is what makes this a drop target at all; without it the drop
      // event never fires and the zone is decoration.
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
      zone.classList.add('dropzone--over');
    },
    ondragleave: () => zone.classList.remove('dropzone--over'),
    ondrop: (event) => {
      event.preventDefault();
      zone.classList.remove('dropzone--over');
      if (busy) return;
      const id = (event.dataTransfer.getData('application/x-topic-id') || event.dataTransfer.getData('text/plain') || '').trim();
      const known = allTopics.find((t) => t.id === id);
      if (known && !chosen.includes(known.id)) onToggle(known.id);
    },
  });

  if (selected.length) {
    for (const topic of selected) {
      const chip = h('span', { class: 'dropchip' },
        h('span', { class: 'dropchip__label', text: clamp(topic.label, 46) }),
        h('button', {
          class: 'dropchip__remove',
          type: 'button',
          disabled: busy || undefined,
          'aria-label': `Remove ${topic.label}`,
          title: `Remove ${topic.label}`,
          onclick: () => onToggle(topic.id),
        }, '×'),
      );
      zone.append(chip);
    }
  } else {
    zone.append(h('span', { class: 'dropzone__empty', text: 'Drag preferred topics here' }));
  }

  const totals = selected.reduce(
    (acc, topic) => {
      const types = deck.get(topic.id)?.types || [];
      acc.flashcards += perTopic;
      acc.questions += types.length || (deck.size ? 0 : typeCount);
      acc.chars += topic.chars || 0;
      return acc;
    },
    { flashcards: 0, questions: 0, chars: 0 },
  );

  return h('section', { class: 'drop' },
    h('div', { class: 'panel__head' },
      h('span', { class: 'panel__label', text: 'What you will get' }),
      h('span', {
        class: 'panel__hint',
        text: selected.length
          ? `${plural(selected.length, 'topic')} · ${plural(totals.flashcards, 'flashcard')} · ${plural(totals.questions, 'question')}`
          : 'Nothing chosen, so the model chooses',
      }),
      h('button', {
        class: 'btn btn--ghost drop__roll',
        type: 'button',
        disabled: busy || !allTopics.length || undefined,
        title: `Pick ${plural(topicsNeeded({ options, plan }), 'topic')} at random, about as many as the question count needs`,
        onclick: onRandomise,
      }, 'Pick for me'),
    ),
    zone,
    selected.length
      ? h('ul', { class: 'drop__gain' },
          ...selected.map((topic) => {
            const types = deck.get(topic.id)?.types || [];
            const questions = types.length || (deck.size ? 0 : typeCount);
            return h('li', { class: 'drop__row' },
              h('span', { class: 'drop__rowlabel', text: clamp(topic.label, 80) }),
              h('span', { class: 'drop__rowout', text: `${perTopic} flashcards · ${questions} ${questions === 1 ? 'question' : 'questions'}` }),
              h('span', { class: 'drop__rowlen', text: lengthLine(topic) }),
            );
          }),
        )
      : h('p', {
          class: 'panel__empty',
          text: 'Drag a topic across, or use Add on the list, to pin the quiz to the part of the conversation you want to be asked about.',
        }),
  );
}

/**
 * Quizzes already stored for this conversation.
 *
 * Four facts per row, because a list of titles is a list of files: where the run got
 * to, the score it last finished on, when it was built, and when it was last opened.
 * Which of the two openers a row gets follows from the state, not from the click: a
 * quiz with a saved position resumes, a quiz nobody has touched starts.
 */
function savedQuizzesSection({ quizzes, onOpen, onResume }) {
  const list = Array.isArray(quizzes) ? quizzes : Array.isArray(quizzes?.quizzes) ? quizzes.quizzes : [];

  return h('section', { class: 'saved' },
    h('div', { class: 'panel__head' },
      h('span', { class: 'panel__label', text: 'Saved quizzes' }),
      h('span', { class: 'panel__hint', text: list.length ? plural(list.length, 'quiz', 'quizzes') : 'None for this conversation yet' }),
    ),
    list.length
      ? h('ul', { class: 'saved__list' }, ...list.map((quiz) => savedQuizRow(quiz, onOpen, onResume)))
      : h('p', { class: 'panel__empty', text: 'Generate one and it waits here, with the place you stopped in.' }),
  );
}

/** "not started", "in progress" or "finished", from the stored progress alone. */
function quizState(quiz) {
  const progress = quiz.progress;
  if (!progress) return { id: 'new', label: 'not started', started: false };
  if (progress.completed) return { id: 'done', label: 'finished', started: true };
  if (progress.resumable || (progress.stepIndex || 0) > 0) return { id: 'going', label: 'in progress', started: true };
  return { id: 'new', label: 'not started', started: false };
}

function savedQuizRow(quiz, onOpen, onResume) {
  const state = quizState(quiz);
  const progress = quiz.progress || {};
  const score = Number.isFinite(Number(progress.score)) && Number(progress.maxScore) > 0
    ? `${progress.score} of ${progress.maxScore}`
    : null;

  const meta = [
    h('span', { class: `saved__state saved__state--${state.id}`, text: state.label }),
    score ? h('span', { class: 'saved__score', text: `last score ${score}` }) : null,
    h('span', { class: 'saved__time', text: `generated ${timeAgo(quiz.createdAt) || 'recently'}` }),
    progress.updatedAt
      ? h('span', { class: 'saved__time', text: `last opened ${timeAgo(progress.updatedAt)}` })
      : h('span', { class: 'saved__time', text: 'not opened yet' }),
  ].filter(Boolean);

  const body = [
    h('span', { class: 'saved__title', text: quiz.title || 'Untitled quiz' }),
    h('span', {
      class: 'saved__counts',
      text: `${plural(quiz.flashcardCount || 0, 'flashcard')} · ${plural(quiz.questionCount || 0, 'question')}`,
    }),
    h('span', { class: 'saved__meta' }, ...meta),
  ];

  const handler = state.started ? onResume : onOpen;
  return h('li', { class: `saved__row saved__row--${state.id}` },
    handler
      ? h('button', {
          class: 'saved__open',
          type: 'button',
          title: state.started ? 'Pick this quiz up where it stopped' : 'Start this quiz from the first card',
          onclick: () => handler(quiz.id),
        }, ...body)
      : h('span', { class: 'saved__open saved__open--plain' }, ...body),
  );
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

// ── Chrome: back to top, and a title that notices the mouse ───────────────

/**
 * The nearest ancestor that actually scrolls. The transcript is long, so something
 * has to scroll it back, and the button has to watch the same box the user scrolled
 * rather than the window, which never moves here.
 */
function scrollParent(node) {
  for (let el = node?.parentElement; el; el = el.parentElement) {
    const overflow = getComputedStyle(el).overflowY;
    if ((overflow === 'auto' || overflow === 'scroll') && el.scrollHeight > el.clientHeight) return el;
  }
  return null;
}

const toTop = { node: null, scroller: null, onScroll: null, container: null };

/**
 * One floating button, created once and re-pointed at whichever box is scrolling.
 *
 * The panel is re-rendered on every state change, so the listener and the button are
 * both kept in module scope rather than re-created each time. The button is hidden
 * whenever its panel is not on screen, or the pane is hidden and it would float over
 * a quiz that has nothing to do with it.
 */
function mountBackToTop(container) {
  const scroller = scrollParent(container);
  if (toTop.scroller !== scroller) {
    if (toTop.scroller && toTop.onScroll) toTop.scroller.removeEventListener('scroll', toTop.onScroll);
    toTop.scroller = scroller;
    toTop.onScroll = scroller ? () => syncBackToTop() : null;
    if (scroller) scroller.addEventListener('scroll', toTop.onScroll, { passive: true });
  }
  if (!scroller) {
    toTop.node?.remove();
    toTop.node = null;
    return;
  }
  if (!toTop.node) {
    toTop.node = h('button', {
      class: 'totop',
      type: 'button',
      'aria-label': 'Back to the top',
      onclick: () => toTop.scroller?.scrollTo({ top: 0, behavior: 'smooth' }),
    }, 'Back to top');
    document.body.append(toTop.node);
  }
  toTop.container = container;
  syncBackToTop();
}

function syncBackToTop() {
  if (!toTop.node || !toTop.scroller) return;
  // A hidden pane has no boxes, so the button hides with it rather than hovering over
  // whichever view replaced it.
  const visible = Boolean(toTop.container?.getClientRects().length);
  const show = visible && toTop.scroller.scrollTop > BACK_TO_TOP_AT;
  toTop.node.hidden = !show;
  toTop.node.classList.toggle('totop--on', show);
}

/**
 * The title lights up under the mouse.
 *
 * One delegated listener, because the title is re-rendered with the rest of the header
 * and a listener bound to a node that is about to be replaced would be thrown away
 * with it. The position is written as two custom properties and everything visible is
 * done in CSS, so there is no per-move layout work here and the theme pass can restyle
 * the effect without touching this file.
 */
const titleGlow = { bound: false };
if (typeof document !== 'undefined' && !titleGlow.bound) {
  titleGlow.bound = true;
  document.addEventListener('pointermove', (event) => {
    const title = event.target instanceof Element ? event.target.closest('.session__title') : null;
    if (!title) return;
    const box = title.getBoundingClientRect();
    title.style.setProperty('--title-x', `${event.clientX - box.left}px`);
    title.style.setProperty('--title-y', `${event.clientY - box.top}px`);
  }, { passive: true });
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
