// Quiz generation.
//
// THE WORKFLOW THIS IMPLEMENTS
//   1. the conversation is split into topics deterministically          (lib/topics.js)
//   2. a random subset of those topics is chosen for the requested size
//   3. every chosen topic yields 2 flashcards and 1 question per enabled type
//   4. one Gemini call per topic, walking a model fallback chain        (lib/gemini.js)
//
// Flashcards are not optional in the product: the user learns the prerequisite
// knowledge first, then answers. So every selected topic always produces two, even
// when no question types are enabled and the quiz is a pure flashcard deck.
//
// WHY ONE CALL PER TOPIC AND NOT ONE FOR EVERYTHING
// A single call over the whole session is the thing this design exists to avoid: it
// would be unbounded. Per topic it is bounded by topicSlice's cap, the topics are
// generated in parallel, and one malformed response costs one topic instead of the
// whole quiz.

import { deriveTopics, topicSlice } from './topics.js';
import { generateJson, hasApiKey, DEFAULT_MODEL_CHAIN } from './gemini.js';
import { redact } from './redact.js';
import { mockEnabled, mockTopicResponse, MOCK_MODEL, MOCK_USAGE } from './mock.js';

export const QUESTION_TYPES = ['mcq', 'cloze', 'open'];

/**
 * Thresholds below which a conversation cannot make a decent quiz.
 *
 * A session of "hi" is the case that forced this: it normalizes to one user turn and
 * one assistant turn, clears the old `quizReady` check on turn count alone, and then
 * produces flashcards and a question about nothing. The gate is applied at two levels
 * because a long session can still contain a throwaway topic.
 */
export const READINESS = {
  /**
   * Whole-session floors.
   *
   * `minUserTurns` is 1, not 2: measured against a real history, requiring two turns
   * refused four substantive sessions of 4k-8k characters that happened to be a single
   * long question with a long answer. Those are perfectly quizzable, and a session
   * with no user turn at all is not a conversation. What actually separates "hi" from
   * a real session is the character floor and, below, the per-topic floor.
   */
  minUserTurns: 1,
  minChars: 400,
  /** Per-topic floors: 2 flashcards and a question need something to work from. */
  minTopicChars: 700,
  minTopicExchanges: 1,
  /**
   * A topic has to carry a question of each enabled type, so the floor rises with the
   * number of types asked of it.
   */
  charsPerQuestionType: 250,
};

/**
 * Can this conversation support a quiz, and if not, why not?
 *
 * Returns reasons rather than a bare boolean so the UI can say "this conversation is
 * 2 turns long" instead of greying something out silently.
 */
export function assessReadiness(session, options = {}) {
  const { types = [], topics: precomputed } = options;
  const reasons = [];

  const userTurns = session?.userTurns || 0;
  const chars = session?.chars || 0;
  if (!session) return { ready: false, level: 'empty', reasons: ['no-session'], stats: {} };
  if (userTurns < READINESS.minUserTurns) {
    reasons.push(`only ${userTurns} user turn${userTurns === 1 ? '' : 's'}, need ${READINESS.minUserTurns}`);
  }
  if (chars < READINESS.minChars) {
    reasons.push(`only ${chars} characters, need ${READINESS.minChars}`);
  }

  const { topics } = precomputed ? { topics: precomputed } : (() => {
    try {
      return deriveTopics(session);
    } catch {
      return { topics: [] };
    }
  })();

  const typeCount = Math.max(1, types.length);
  const perTopicFloor = Math.max(
    READINESS.minTopicChars,
    typeCount * READINESS.charsPerQuestionType,
  );
  const usable = topics.filter((t) => t.chars >= perTopicFloor && t.exchanges >= READINESS.minTopicExchanges);
  const thin = topics.length - usable.length;

  if (topics.length === 0) reasons.push('no topic could be derived');
  else if (usable.length === 0) {
    reasons.push(`all ${topics.length} topic(s) are below ${perTopicFloor} characters`);
  }

  const level = userTurns === 0 || chars === 0 ? 'empty' : usable.length === 0 ? 'thin' : thin > 0 ? 'partial' : 'ready';

  return {
    ready: usable.length > 0 && userTurns >= READINESS.minUserTurns && chars >= READINESS.minChars,
    level,
    reasons,
    stats: {
      userTurns,
      chars,
      toolCalls: session.toolCalls || 0,
      messages: session.messages?.length || 0,
      topics: topics.length,
      usableTopics: usable.length,
      thinTopics: thin,
      perTopicFloor,
    },
  };
}

export const DEFAULTS = {
  /** How many questions the user asked for. Flashcards are additional. */
  questionCount: 6,
  /** Any combination of QUESTION_TYPES, including none (flashcards only). */
  types: ['mcq', 'cloze', 'open'],
  /**
   * Flashcards per topic.
   *
   * This used to be fixed at 2, and it was called "the product fixes this" in a
   * comment as though nobody would ever want more. The bounds live in
   * FLASHCARDS_PER_TOPIC so the control, the planner and the generator cannot
   * disagree, and so `quizCapabilities()` can hand the UI the exact range to render.
   */
  flashcardsPerTopic: 2,
  /**
   * Optional topic ids to quiz on, from the topic list the user picked in the panel.
   *
   * Absent or empty means today's behaviour: choose automatically. A non-empty list
   * narrows generation to those topics, and a list longer than the question count
   * needs is sampled down randomly rather than silently truncated in order, so
   * re-running does not always produce the same subset.
   */
  topicIds: [],
  /** Chars of conversation sent per topic. */
  maxCharsPerTopic: 12000,
  /** Upper bound on topics considered, independent of the question count. */
  maxTopics: 14,
  temperature: 0.75,
  /** Optional. Given, topic selection is reproducible; omitted, it is random. */
  seed: null,
  /**
   * Optional free text from the user, e.g. "focus on the architectural decisions".
   * Passed to the model as an emphasis instruction. Capped and redacted like any other
   * text on its way out, because a user may well type something secret into it.
   */
  focus: '',
};

/**
 * The flashcards-per-topic control's bounds.
 *
 * One is a floor because a topic with no card teaches nothing before the questions,
 * and the per-topic character floor in READINESS was chosen on the assumption of a
 * couple of cards. The ceiling is bounded rather than open because every extra card
 * is another model call's worth of material the user then has to read, and past a
 * handful the deck stops being a warm-up and becomes the quiz.
 */
export const FLASHCARDS_PER_TOPIC = { min: 1, max: 8, default: DEFAULTS.flashcardsPerTopic, step: 1 };

/**
 * Clamp a requested flashcard count into the range the control offers.
 *
 * Everything downstream trusts this value: the prompt tells the model to produce
 * exactly that many, `expectedFlashcards` multiplies by it, and `settingsKey` folds it
 * in so a different count is a different quiz. An out-of-range number reaching any
 * of those is a deck that does not match its own plan.
 */
export function clampFlashcardsPerTopic(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return FLASHCARDS_PER_TOPIC.default;
  return Math.max(FLASHCARDS_PER_TOPIC.min, Math.min(FLASHCARDS_PER_TOPIC.max, Math.round(n)));
}

/**
 * The end-of-quiz band, in quartiles.
 *
 * Kept here rather than in the UI so the thresholds and the copy are one thing that can
 * be tested, and so every screen that reports a score agrees. No em dashes and no
 * exclamation marks, per the house style.
 *
 * @param {number} percentage  0 to 100
 */
export function scoreBand(percentage) {
  const pct = Math.max(0, Math.min(100, Number(percentage) || 0));
  if (pct < 25) {
    return {
      id: 'unfamiliar',
      label: 'New ground',
      headline: 'This was new ground',
      line: 'Little of it stuck this time. Read the conversation again and come back. It reads differently once you know what the agent was aiming at.',
      tone: 'low',
    };
  }
  if (pct < 50) {
    return {
      id: 'partial',
      label: 'Partly there',
      headline: 'The shape of it, not the detail',
      line: 'You followed where the work went. The parts you had to guess are worth a second look, and the flashcards cover most of them.',
      tone: 'mid',
    };
  }
  if (pct < 75) {
    return {
      id: 'solid',
      label: 'Solid',
      headline: 'Solid',
      line: 'You know what happened here and why. A couple of details are still loose, which is normal after one pass.',
      tone: 'good',
    };
  }
  return {
    id: 'strong',
    label: 'Strong',
    headline: 'You know this work',
    line: 'Asked to explain this tomorrow, you would not need the transcript. That is the point of doing this.',
    tone: 'high',
  };
}

/**
 * What the one button in the top right should say and do.
 *
 * The described workflow is: a fresh conversation offers to generate, a conversation with
 * a stored quiz offers to open it, and a conversation whose transcript has grown since
 * that quiz went back to offering generation. That mapping is a product rule, so it lives
 * here rather than being re-derived in the UI from six staleness states.
 *
 * An attempt in progress takes priority over every staleness state. Losing your place is
 * worse than a quiz being a little out of date, so a part finished quiz offers to resume
 * even when new content has arrived since it was generated.
 *
 * @param {object} staleness  the result of QuizStore#staleness
 * @param {object} [progress] the result of QuizStore#getProgress
 * @returns {{action:'configure'|'open'|'resume', label:string, reason:string, staleness:string}}
 */
export function quizButtonState(staleness, progress = null) {
  const state = staleness?.state || 'new';

  if (state === 'new') {
    return {
      action: 'configure',
      label: 'Generate quiz',
      reason: 'No quiz for this conversation yet.',
      staleness: 'new',
    };
  }

  if (progress?.resumable) {
    const answered = Object.keys(progress.answers || {}).length;
    return {
      action: 'resume',
      label: 'Resume quiz',
      reason: `You are partway through this quiz, ${answered} answered.`,
      staleness: state,
    };
  }

  // A STORED QUIZ ALWAYS OFFERS ITSELF, whatever its staleness.
  //
  // This used to fall through to "Generate quiz" whenever the transcript had grown, which
  // was wrong twice over: a conversation in active use grows constantly, so the button was
  // permanently a regeneration offer, and the only way to reach a stored quiz was to
  // replace it. On this project it was self-inflicted, because the pi session recording the
  // work grows with every message, so the state was always `extended` and a finished quiz
  // could never be reopened.
  //
  // Staleness is still reported, as `reason` and `staleness`, so the UI can show it next to
  // a deliberate Regenerate action. It just does not get to be the button.
  const reason = {
    fresh: 'A quiz is ready for this conversation.',
    extended: `${staleness.newMessages} new message${staleness.newMessages === 1 ? '' : 's'} since this quiz was made.`,
    diverged: 'The part of this conversation this quiz used has changed.',
    settings_changed: 'Your current settings differ from this quiz.',
    generator_stale: 'This quiz came from an older version of the generator.',
  }[state];

  return {
    action: 'open',
    label: 'Back to quiz',
    reason: reason || 'A quiz is ready for this conversation.',
    staleness: state,
  };
}

/**
 * Everything the frontend needs to render the generation settings, so no option
 * labels, bounds or type names are hardcoded in two places.
 *
 * The UI should be able to build the whole settings panel from this and nothing else:
 * how many questions are allowed, which types exist and what they mean, and whether a
 * key is configured (as a boolean — the key itself is never returned).
 */
export function quizCapabilities() {
  const maxQuestions = DEFAULTS.maxTopics * QUESTION_TYPES.length;
  return {
    requiresApiKey: !hasApiKey(),
    questionCount: { min: 1, max: maxQuestions, default: DEFAULTS.questionCount, step: 1 },
    types: [
      {
        id: 'mcq',
        label: 'Multiple choice',
        description: 'Four options, exactly one correct.',
        needsGrading: false,
        default: true,
      },
      {
        id: 'cloze',
        label: 'Fill in the blanks',
        description: 'Real code from the conversation with one key expression removed.',
        needsGrading: false,
        default: true,
      },
      {
        id: 'open',
        label: 'Open-ended',
        description: 'Written answer, scored against a weighted rubric.',
        needsGrading: true,
        default: true,
      },
    ],
    flashcards: {
      always: true,
      perTopic: DEFAULTS.flashcardsPerTopic,
      // The range for the flashcards-per-question control, flattened onto the same
      // object the UI already reads `perTopic` from, so adding a control needs no new
      // channel and no second capabilities key.
      min: FLASHCARDS_PER_TOPIC.min,
      max: FLASHCARDS_PER_TOPIC.max,
      default: FLASHCARDS_PER_TOPIC.default,
      step: FLASHCARDS_PER_TOPIC.step,
      note: 'Shown before the questions. Every selected topic produces this many, even when no question types are enabled.',
    },
    topics: {
      maxPerQuiz: DEFAULTS.maxTopics,
      /**
       * With one question per topic per type, the ceiling is `maxPerQuiz x types`.
       * Exposed as numbers rather than a helper because this object crosses IPC, and a
       * function cannot be structured-cloned — the client does the multiplication.
       */
      maxQuestionsPerType: DEFAULTS.maxTopics,
    },
    budget: { maxCharsPerTopic: DEFAULTS.maxCharsPerTopic },
    readiness: READINESS,
    modelChain: DEFAULT_MODEL_CHAIN,
  };
}

// ── Planning (deterministic, no API) ───────────────────────────────────────

/** Small deterministic PRNG so an optional seed makes selection reproducible. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(items, seed) {
  const out = [...items];
  const rand = seed === null || seed === undefined ? Math.random : mulberry32(seed);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Decide which topics to use and what to ask each one for. Pure: no API, no disk.
 *
 * Topic count is derived from the request rather than fixed, so the user's "number
 * of questions" is what drives the work:
 *
 *   topics = ceil(questionCount / enabledTypes)      (at least 1)
 *
 * With 6 questions and all three types, that is 2 topics: two flashcards and three
 * questions each, which is 6. With 6 questions and mcq only, it is 6 topics. With no
 * types enabled the question count is 0 and a single topic still yields the deck.
 *
 * @returns {object} plan
 */
export function planQuiz(session, options = {}) {
  const opts = { ...DEFAULTS, ...options };
  const types = [...new Set((opts.types || []).filter((t) => QUESTION_TYPES.includes(t)))];
  const flashcardsPerTopic = clampFlashcardsPerTopic(opts.flashcardsPerTopic);

  const requested = types.length === 0 ? 0 : Math.max(0, Math.floor(opts.questionCount));
  const topicsNeeded = types.length === 0 ? 1 : Math.max(1, Math.ceil(requested / types.length));

  const { topics: allTopicsRaw, stats: topicStats } = deriveTopics(session, { maxTopics: opts.maxTopics });

  // Incremental generation. Topics are filtered AFTER derivation rather than by trimming
  // the session first, so message indices stay absolute — `sourceRefs.messageIndex` has to
  // name a real turn in the original conversation, and renumbering would break it.
  const fromMessage = Number.isFinite(opts.fromMessage) ? Math.max(0, opts.fromMessage) : 0;
  const allTopics = fromMessage > 0 ? allTopicsRaw.filter((t) => t.from >= fromMessage) : allTopicsRaw;

  // Which topics the user picked, if any. An absent or empty list keeps the automatic
  // selection below untouched, which is the whole contract: the panel only sends this
  // once a topic has actually been chosen.
  const wantedIds = (Array.isArray(opts.topicIds) ? opts.topicIds : [])
    .map((id) => String(id))
    .filter((id) => id);
  const wanted = new Set(wantedIds);
  const selection = wantedIds.length > 0;

  // Drop topics too thin to carry a question. Without this a session of "hi" produced
  // a flashcard and a multiple-choice question about nothing in particular.
  const typeCount = Math.max(1, types.length);
  const floor = Math.max(READINESS.minTopicChars, typeCount * READINESS.charsPerQuestionType);
  const usable = allTopics.filter((t) => t.chars >= floor && t.exchanges >= READINESS.minTopicExchanges);

  // Narrow to the picked topics only AFTER the thin filter, so an id for a topic that
  // could not carry a question is reported as unavailable rather than silently
  // answering with the next one.
  const chosen = selection ? usable.filter((t) => wanted.has(String(t.id))) : usable;
  const topics = chosen;
  const droppedThin = allTopics.length - usable.length;

  // Ids the panel sent that no usable topic carries. Surfaced rather than swallowed:
  // a stale selection should say so instead of quietly generating something else.
  const unknownTopicIds = selection ? wantedIds.filter((id) => !topics.some((t) => String(t.id) === id)) : [];

  const readiness = assessReadiness(session, { types, topics: allTopics });
  if (topics.length === 0) {
    // No topics means no questions, and `questionCount` is not in scope yet — it is
    // capped against the deck further down. Referring to it here crashed with a
    // temporal-dead-zone error on any session with no user turns, which is what a
    // sweep across every bundled fixture format turned up.
    return {
      plan: null,
      types,
      questionCount: 0,
      requestedQuestions: requested,
      shortfall: requested,
      requestedTopics: topicsNeeded,
      requestedTopicIds: wantedIds,
      unknownTopicIds,
      selectedTopics: [],
      deck: [],
      expectedQuestions: 0,
      expectedFlashcards: 0,
      topicStats,
      readiness,
      reason: readiness.level === 'empty' ? 'empty-session' : 'no-usable-topics',
      message:
        readiness.reasons.length > 0
          ? `This conversation is too thin to quiz: ${readiness.reasons.join('; ')}.`
          : 'This conversation is too short to quiz.',
    };
  }

  // Random subset, unless a seed was given. "Random" is deliberate: regenerating a
  // quiz from the same long session should give a different set of questions rather
  // than the same first three topics every time. It is also what handles a long
  // explicit selection: asking for a subset of the topics the user ticked is a
  // sample, not a truncation, so the same ten picks do not always yield the same
  // three topics.
  const ordered = shuffle(topics, opts.seed);
  const selected = ordered.slice(0, Math.min(topicsNeeded, topics.length));
  // Back to chronological order so the deck reads in the order things happened.
  selected.sort((a, b) => a.from - b.from);

  // What the pick cost, so the panel can say "6 of your 10 topics" rather than
  // implying the other four do not exist.
  const droppedTopicIds = selection
    ? chosen.filter((t) => !selected.includes(t)).map((t) => String(t.id))
    : [];

  // Assign one question per (topic, type) pair, cycling types across topics so the
  // question mix is even. A pair is never requested twice: asking a topic for two
  // multiple-choice questions contradicts "one main question per topic", and the
  // earlier loop could produce exactly that on a session with few topics.
  const deck = selected.map((topic) => ({ topicId: topic.id, label: topic.label, types: [] }));
  const maxQuestions = types.length === 0 ? 0 : deck.length * types.length;
  const questionCount = Math.min(requested, maxQuestions);

  for (let i = 0; i < questionCount; i++) {
    // Interleave by topic so the deck alternates subjects rather than blocking them.
    const topicIndex = i % deck.length;
    const typeIndex = Math.floor(i / deck.length) % types.length;
    deck[topicIndex].types.push(types[typeIndex]);
  }

  return {
    plan: {
      questionCount,
      types,
      flashcardsPerTopic,
      maxCharsPerTopic: opts.maxCharsPerTopic,
    },
    types,
    questionCount,
    requestedTopics: topicsNeeded,
    /** The ids the panel asked for. Empty means the selection was automatic. */
    requestedTopicIds: wantedIds,
    /** Ids that asked for but no usable topic carries. */
    unknownTopicIds,
    /** Picked topics left out by the sample. */
    droppedTopicIds,
    selectedTopics: selected.map((t) => ({
      id: t.id,
      label: t.label,
      messageRanges: t.messageRanges,
      files: t.files,
      score: t.score,
      chars: t.chars,
    })),
    deck,
    topicStats,
    /** How many questions the plan will actually produce, after rounding. */
    expectedQuestions: deck.reduce((n, d) => n + d.types.length, 0),
    expectedFlashcards: deck.length * flashcardsPerTopic,
    /** The user's ask before it was capped by the available topics. */
    requestedQuestions: requested,
    /**
     * Questions the session cannot support. Non-zero when the conversation has
     * fewer topics than the requested count needs: with one question per topic per
     * type, N topics over T types is a hard ceiling of N x T.
     */
    shortfall: Math.max(0, requested - questionCount),
    readiness,
    /** Topics skipped for being too thin to ask about. */
    droppedThinTopics: droppedThin,
    reason: null,
  };
}

// ── Gemini schema ──────────────────────────────────────────────────────────

/**
 * The response schema for one topic.
 *
 * EVERY TYPE-SPECIFIC FIELD IS REQUIRED, with empty sentinels for the ones that do
 * not apply. This is not tidiness — it is a correction. With `correctOptionKey`
 * nullable and non-required, the model returned multiple-choice questions with the
 * *answer missing*. Gemini's responseSchema has no way to express "required only
 * when type is mcq", so the choice is between separate calls per type and one flat
 * object where every field is present. Flat with sentinels keeps it to one call per
 * topic, and `validateQuestion` enforces what the schema cannot.
 */
export function quizSchema({ types, flashcardsPerTopic }) {
  const questionTypes = types.length ? types : QUESTION_TYPES;
  return {
    type: 'object',
    properties: {
      flashcards: {
        type: 'array',
        description: `Exactly ${flashcardsPerTopic} flashcards teaching the prerequisite knowledge needed to answer the questions.`,
        items: {
          type: 'object',
          properties: {
            front: { type: 'string', description: 'A single term, concept or question.' },
            back: { type: 'string', description: 'A concise answer, two sentences at most.' },
            sourceTurns: { type: 'array', items: { type: 'integer' }, description: 'Turn numbers this came from.' },
          },
          required: ['front', 'back', 'sourceTurns'],
        },
      },
      questions: {
        type: 'array',
        description: 'One question for each requested type, in the order requested.',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            type: { type: 'string', enum: questionTypes },
            prompt: { type: 'string', description: 'The question, self-contained and answerable from the excerpt.' },
            explanation: { type: 'string', description: 'Why the answer is correct.' },
            sourceTurns: { type: 'array', items: { type: 'integer' } },
            // mcq
            options: {
              type: 'array',
              description: 'For mcq only: exactly four options. Empty for other types.',
              items: {
                type: 'object',
                properties: { key: { type: 'string' }, text: { type: 'string' } },
                required: ['key', 'text'],
              },
            },
            correctOptionKey: { type: 'string', description: 'For mcq only: the key of the single correct option. Empty string otherwise.' },
            // open
            rubric: {
              type: 'array',
              description: 'For open only: grading criteria. Empty for other types.',
              items: {
                type: 'object',
                properties: {
                  criterion: { type: 'string' },
                  weight: { type: 'number' },
                  mustMention: { type: 'array', items: { type: 'string' } },
                },
                required: ['criterion', 'weight', 'mustMention'],
              },
            },
            referenceAnswer: { type: 'string', description: 'For open only. Empty string otherwise.' },
            // cloze
            language: { type: 'string', description: 'For cloze only: the code fence language. Empty string otherwise.' },
            codeWithGaps: { type: 'string', description: 'For cloze only: real code with each gap written as {{blank_1}}.' },
            blanks: {
              type: 'array',
              description: 'For cloze only: one entry per gap. Empty for other types.',
              items: {
                type: 'object',
                properties: {
                  key: { type: 'string' },
                  answer: { type: 'string' },
                  alternatives: { type: 'array', items: { type: 'string' } },
                },
                required: ['key', 'answer', 'alternatives'],
              },
            },
          },
          required: [
            'id', 'type', 'prompt', 'explanation', 'sourceTurns',
            'options', 'correctOptionKey', 'rubric', 'referenceAnswer',
            'language', 'codeWithGaps', 'blanks',
          ],
        },
      },
    },
    required: ['flashcards', 'questions'],
  };
}

// ── Prompt ─────────────────────────────────────────────────────────────────

function buildPrompt({ slice, topic, types, flashcardsPerTopic, session, focus = '' }) {
  const typeList = types.length ? types.join(', ') : 'none';
  const questionSpec = types.length
    ? `Produce exactly ${types.length} question${types.length === 1 ? '' : 's'}, one of each of these types: ${typeList}.`
    : 'Produce no questions this time. Flashcards only.';

  const byType = {
    mcq: '- mcq: exactly four options keyed A-D, exactly one correct. Distractors must be plausible to someone who half-remembers the conversation, not obviously wrong.',
    cloze: `- cloze: real code taken from the excerpt, with the important part replaced by {{blank_1}} (then {{blank_2}} if needed).
  Blank out something with EXACTLY ONE correct spelling: an identifier, a function or
  method name, a flag, a keyword, a config key, a type, a number. Do not blank out a
  whole expression or a block of logic, because several implementations would be correct
  and the question would then have no single answer. If the only interesting gap is a
  design choice with several valid answers, ask it as an open question instead.
  Always fill the alternatives list. An empty list is only acceptable when the answer
  truly has one spelling. Add every variant a careful person might type: with and
  without trailing parentheses, a different but equivalent API name, a short form.`,
    open: '- open: a free-text question that requires explaining a decision, a cause or a trade-off rather than recalling a fact. Provide a rubric of 2-4 weighted criteria and a reference answer.',
  };

  const focusBlock = focus
    ? `
WHAT THEY ASKED TO FOCUS ON
${focus}

Treat this as emphasis, not as a filter. Pick the questions that best serve it from the
excerpt, and ignore it if the excerpt does not support it. Never invent material to
satisfy it.
`
    : '';

  return `You are writing study material for the developer who had the conversation below.
They already did the work; this is to test whether they still understand it.

They chose the working directory: ${session.project}
Topic: ${topic.label}
${focusBlock}
WHAT TO PRODUCE
- Exactly ${flashcardsPerTopic} flashcards teaching the PREREQUISITE knowledge needed to answer the questions. They come first and must stand alone: define the concept, do not just restate what happened.
${questionSpec}
${types.map((t) => byType[t]).filter(Boolean).join('\n')}

THE EXCERPT
It has up to two labelled parts. PRECEDING CONTEXT is background from earlier in
the same session — read it to understand how the topic was reached, but do not ask
about it. Everything to ask about is under the TOPIC heading.

HOUSE STYLE
This is a hard requirement, not a preference. Everything you write must obey it.
- No em dashes. Use a full stop, a comma, or "and". If you reach for one, rewrite the
  sentence instead.
- No emojis. None, anywhere, not even as a bullet or a check mark.
- No decorative arrows, no box drawing, no stars.
- Plain ASCII punctuation: straight quotes, three dots rather than an ellipsis character.
- No exclamation marks. This is study material, not encouragement.

READABILITY
Write for someone skimming on a phone, not for a design review. The material is a
memory aid, so plain language beats precise jargon every time.
- Prefer short sentences. One idea each.
- Never stack nouns into a phrase. "a host-agnostic normalizer core" is precise and
  unreadable; write "the shared layer that reads every tool's history".
- A term you cannot avoid: define it in the same sentence, in plain words, the first
  time it appears. Then use it.
- Replace invented or specialised vocabulary with what it does. Not "the extraction
  layer performs span normalisation" but "the extractor rewrites the matched text".
- Keep real identifiers (file names, flags, function names) exactly as written, in
  backticks. They are the one place precision matters.
- Flashcards: the front is one short question, the back is one or two short sentences.
- Question prompts: under about 30 words. Put anything needed as context in an
  options list or the rubric, not in a long stem.

RULES
- Every question must be understandable on its own, by someone who has not read the
  excerpt. Do not open with "Following the updates to…", "Based on the evaluation
  of…", "As discussed…", or any other continuation phrasing, and do not refer to
  "the above", "earlier", or "the previous step". Name the subject explicitly:
  write "the regex extractor's handling of negation", not "its negation handling".
- Ground everything in the excerpt. Do not invent files, flags, APIs or numbers that do not appear in it.
- Quote real identifiers, file names and code exactly as written.
- sourceTurns must contain the turn numbers the material is drawn from. Only use turn numbers that appear in the excerpt.
- For a field that does not apply to a question's type, use an empty string or an empty array.
- Write in the register of documentation about a system, not a retelling of an event.
  Never write "the assistant", "the AI", "the model", "the conversation", "the
  transcript", "this session", or "the user". Address the reader directly: "you
  configured…", "the pool leaks because…", "why does the retry helper…".
- Ask about the system and the reasoning, not about who said what when.
- If the excerpt does not contain enough to write a question of a requested type, write the closest question it does support rather than inventing detail.

CONVERSATION EXCERPT
${slice.text}`;
}

// ── Validation ────────────────────────────────────────────────────────────

/**
 * Enforce what the response schema cannot.
 *
 * The schema guarantees the shape; it cannot guarantee that an mcq has a correct
 * answer, that a cloze has a gap, or that a citation points at a real turn. Anything
 * that fails is dropped with a reason rather than shipped as a broken question.
 */
export function validateResult(data, { topic, types, turnRange, idPrefix }) {
  const issues = [];
  const [minTurn, maxTurn] = turnRange;
  const inRange = (n) => Number.isInteger(n) && n >= minTurn && n <= maxTurn;
  // Ids are minted here, not taken from the model. The model numbers its own
  // questions per topic, so every topic produced a "q1" and the ids collided across
  // the quiz — which would make an attempt keyed by question id overwrite another
  // question's answer. Deterministic ids also keep scores comparable across
  // regenerations of the same topic.
  const perTypeCount = new Map();
  const mintId = (type) => {
    const n = (perTypeCount.get(type) || 0) + 1;
    perTypeCount.set(type, n);
    return `${idPrefix || topic.id}-${type}-${n}`;
  };

  const flashcards = (Array.isArray(data?.flashcards) ? data.flashcards : [])
    .filter((c) => c && typeof c.front === 'string' && typeof c.back === 'string' && c.front.trim() && c.back.trim())
    .map((c) => ({
      front: c.front.trim(),
      back: c.back.trim(),
      sourceTurns: (c.sourceTurns || []).filter(inRange),
      topicId: topic.id,
      topicLabel: topic.label,
    }));

  const questions = [];
  for (const raw of Array.isArray(data?.questions) ? data.questions : []) {
    const type = raw?.type;
    if (!types.includes(type)) {
      issues.push(`dropped question of type ${JSON.stringify(type)}: not requested`);
      continue;
    }
    const base = {
      id: mintId(type),
      modelId: raw.id ? String(raw.id) : undefined,
      type,
      topicId: topic.id,
      topicLabel: topic.label,
      prompt: String(raw.prompt || '').trim(),
      explanation: String(raw.explanation || '').trim(),
      sourceTurns: (raw.sourceTurns || []).filter(inRange),
    };
    if (!base.prompt) {
      issues.push(`dropped ${type}: empty prompt`);
      continue;
    }

    if (type === 'mcq') {
      const options = (raw.options || [])
        .filter((o) => o && typeof o.text === 'string' && o.text.trim())
        .map((o, i) => ({ key: String(o.key || 'ABCD'[i] || i + 1).trim(), text: o.text.trim() }));
      const correct = String(raw.correctOptionKey || '').trim();
      if (options.length < 2) {
        issues.push(`dropped mcq: only ${options.length} usable options`);
        continue;
      }
      if (!options.some((o) => o.key === correct)) {
        issues.push(`dropped mcq: correctOptionKey ${JSON.stringify(correct)} matches no option`);
        continue;
      }
      questions.push({ ...base, options, correctOptionKey: correct });
      continue;
    }

    if (type === 'cloze') {
      const code = String(raw.codeWithGaps || '');
      const blanks = (raw.blanks || [])
        .filter((b) => b && typeof b.answer === 'string' && b.answer.trim())
        .map((b, i) => ({
          key: String(b.key || `blank_${i + 1}`).trim(),
          answer: b.answer.trim(),
          alternatives: (b.alternatives || []).map(String).filter(Boolean),
        }));
      if (!/\{\{blank_\d+\}\}/.test(code)) {
        issues.push('dropped cloze: no {{blank_N}} marker in the code');
        continue;
      }
      if (blanks.length === 0) {
        issues.push('dropped cloze: no blanks');
        continue;
      }
      // A blank marker with no matching answer would render an unanswerable gap.
      const missing = [...code.matchAll(/\{\{(blank_\d+)\}\}/g)]
        .map((m) => m[1])
        .filter((k) => !blanks.some((b) => b.key === k));
      if (missing.length) {
        issues.push(`dropped cloze: no answer for ${missing.join(', ')}`);
        continue;
      }
      questions.push({ ...base, language: String(raw.language || '').trim(), codeWithGaps: code, blanks });
      continue;
    }

    if (type === 'open') {
      const rubric = (raw.rubric || [])
        .filter((r) => r && typeof r.criterion === 'string' && r.criterion.trim())
        .map((r) => ({
          criterion: r.criterion.trim(),
          weight: Number.isFinite(r.weight) && r.weight > 0 ? Number(r.weight) : 1,
          mustMention: (r.mustMention || []).map(String).filter(Boolean),
        }));
      if (rubric.length === 0) {
        issues.push('dropped open: no rubric, so it could not be graded');
        continue;
      }
      questions.push({ ...base, rubric, referenceAnswer: String(raw.referenceAnswer || '').trim() });
      continue;
    }
  }

  return { flashcards, questions, issues };
}

// ── Generation ─────────────────────────────────────────────────────────────

/**
 * Generate a full quiz.
 *
 * @param {object} session
 * @param {object} [options]  see DEFAULTS, plus apiKey/models/temperature/onProgress
 * @returns {Promise<object>} a complete quiz object
 */
export async function generateQuiz(session, options = {}) {
  const opts = { ...DEFAULTS, ...options };
  const plan = planQuiz(session, opts);

  if (!plan.plan) {
    return {
      ok: false,
      reason: plan.reason,
      message: plan.message || 'This conversation is too short to quiz.',
      readiness: plan.readiness,
      topicStats: plan.topicStats,
      flashcards: [],
      questions: [],
    };
  }
  if (plan.deck.length === 0) {
    return { ok: false, reason: 'no-types-and-no-topics', message: 'Nothing to generate.' };
  }

  const schema = quizSchema({ types: plan.types, flashcardsPerTopic: opts.flashcardsPerTopic });
  const topicsById = new Map(deriveTopics(session, { maxTopics: opts.maxTopics }).topics.map((t) => [t.id, t]));

  // ONE switch, read here, applied at the single place a model response is obtained.
  //
  // It replaces the network call and nothing else. The topic still comes from the
  // plan, the slice is still built and redacted, the response is still run through
  // validateResult, and the assembly below is untouched, so turning the mock on
  // exercises the same path the real Generate button takes rather than a shortcut
  // beside it. `AGENT_QUIZ_MOCK` is a property of the process, not a request field,
  // so nothing in the renderer can turn it on.
  const useMock = mockEnabled(opts.env ?? process.env);

  const startedAt = Date.now();
  const perTopic = await Promise.all(
    plan.deck.map(async (slot, index) => {
      const topic = topicsById.get(slot.topicId);
      if (!topic) return { slot, error: 'topic disappeared', flashcards: [], questions: [], attempts: [] };

      const rawSlice = topicSlice(session, topic, { maxChars: opts.maxCharsPerTopic });

      // REDACT BEFORE SENDING. This is the path that actually puts conversation text in
      // front of a model, and it previously bypassed the redaction that quizPayload()
      // applies — so secrets reached Gemini through the quiz generator even though the
      // "show payload" view showed them stripped. Both paths now scrub, and this one
      // reports what it removed on the quiz itself.
      const scrubbed = redact(opts.redactEntropy ? rawSlice.text : rawSlice.text, { entropy: false });
      const slice = { ...rawSlice, text: scrubbed.text };
      const redaction = { total: scrubbed.findings.length, byKind: {} };
      for (const finding of scrubbed.findings) {
        redaction.byKind[finding.kind] = (redaction.byKind[finding.kind] || 0) + 1;
      }

      // The focus text is user-authored and goes to the model, so it is redacted and
      // capped on the same terms as the transcript.
      const focusText = opts.focus
        ? redact(String(opts.focus).slice(0, 800)).text
        : '';

      const prompt = buildPrompt({
        slice,
        topic,
        types: slot.types,
        flashcardsPerTopic: opts.flashcardsPerTopic,
        session,
        focus: focusText,
      });

      opts.onProgress?.({ phase: 'topic-start', index, topicId: topic.id, label: topic.label, sliceChars: slice.chars });
      try {
        // From here to `validated` is the real path. Only the source of `data` differs.
        const produced = useMock
          ? {
              data: mockTopicResponse({ topic, types: slot.types, flashcardsPerTopic: opts.flashcardsPerTopic }),
              model: MOCK_MODEL,
              usage: MOCK_USAGE,
              attempts: [{ ok: true, model: MOCK_MODEL, mock: true }],
            }
          : await generateJson({
              prompt,
              schema,
              models: opts.models,
              apiKey: opts.apiKey,
              temperature: opts.temperature,
              signal: opts.signal,
              onAttempt: (a) => opts.onProgress?.({ phase: 'attempt', ...a, topicId: topic.id }),
            });
        const { data, model, usage, attempts } = produced;
        const validated = validateResult(data, { topic, types: slot.types, turnRange: [topic.from, topic.to] });
        opts.onProgress?.({
          phase: 'topic-done',
          index,
          topicId: topic.id,
          model,
          flashcards: validated.flashcards.length,
          questions: validated.questions.length,
          issues: validated.issues,
        });
        return { slot, topic, model, usage, attempts, redaction, ...validated };
      } catch (err) {
        opts.onProgress?.({ phase: 'topic-failed', index, topicId: topic.id, error: String(err?.message || err) });
        return { slot, topic, error: String(err?.message || err), flashcards: [], questions: [], attempts: err?.attempts || [] };
      }
    }),
  );

  // Assemble in the plan's order so the deck reads chronologically.
  const flashcards = [];
  const questions = [];
  const failures = [];
  for (const result of perTopic) {
    if (result.error) {
      failures.push({ topicId: result.slot.topicId, error: result.error });
      continue;
    }
    flashcards.push(...result.flashcards);
    questions.push(...result.questions);
    if (result.issues?.length) failures.push({ topicId: result.slot.topicId, issues: result.issues });
  }

  const attempts = perTopic.flatMap((r) => r.attempts || []);
  const modelsUsed = [...new Set(perTopic.map((r) => r.model).filter(Boolean))];

  // What was stripped on the way out, per kind, so the UI can say so.
  const redaction = { total: 0, byKind: {} };
  for (const result of perTopic) {
    if (!result.redaction) continue;
    redaction.total += result.redaction.total;
    for (const [kind, count] of Object.entries(result.redaction.byKind)) {
      redaction.byKind[kind] = (redaction.byKind[kind] || 0) + count;
    }
  }

  return {
    ok: questions.length > 0 || flashcards.length > 0,
    readiness: plan.readiness,
    droppedThinTopics: plan.droppedThinTopics,
    fromMessage: plan.fromMessage,
    sessionId: session.id,
    title: session.title,
    project: session.project,
    harness: session.harnessName,
    generatedAt: Date.now(),
    elapsedMs: Date.now() - startedAt,
    model: modelsUsed.join(', ') || null,
    settings: {
      questionCount: plan.questionCount,
      focus: opts.focus || undefined,
      expectedQuestions: plan.expectedQuestions,
      producedQuestions: questions.length,
      types: plan.types,
      flashcardsPerTopic: plan.plan.flashcardsPerTopic,
    },
    /** True when this quiz came from the mock rather than from Gemini. */
    mock: useMock,
    topicsUsed: plan.selectedTopics,
    topicStats: plan.topicStats,
    redaction,
    flashcards,
    questions,
    problems: failures,
    usage: {
      calls: attempts.filter((a) => a.ok).length,
      attempts: attempts.length,
      tokens: perTopic.reduce((n, r) => n + (r.usage?.totalTokenCount || 0), 0),
    },
    plan: plan.deck,
  };
}
