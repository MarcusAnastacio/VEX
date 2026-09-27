// The mock generator.
//
// WHY IT EXISTS
// Generation is the one part of this app that cannot be demonstrated or tested
// without a Gemini key, and that made the whole generate flow unverifiable: the
// buttons, the progress events, the validation, the store round trip and the panel
// that renders the result all sat behind a network call nobody could make in CI.
//
// So: a hardcoded, realistic response, produced for the SAME topic the real code
// selected, by the SAME validation, through the SAME per-topic call site in
// `generateQuiz`. Everything downstream of the model response is the real thing.
//
// IT IS NOT A STUB
// The material below names the topic it was asked about and cites the topic's real
// turn range, so a quiz built from it looks like a quiz about that conversation
// rather than a placeholder card. It is still obviously canned, which is why the
// model is reported as `mock` on the finished quiz and in every progress event: a
// screenshot must never be mistakable for a real one.
//
// THE SWITCH
// `AGENT_QUIZ_MOCK=1` in the environment. Explicit, off by default, and read at call
// time rather than cached, so a test can flip it around a single call. There is no
// way to turn it on from the renderer: the flag is a property of the process, so a
// shipped build cannot be talked into answering with canned material.

/** The environment variable that turns the mock on. */
export const MOCK_ENV = 'AGENT_QUIZ_MOCK';

/** The model name reported for a mock response, so no output claims otherwise. */
export const MOCK_MODEL = 'mock';

/** Flashcards per topic the control allows. Kept here so the mock can never disagree with capabilities(). */
const FLASH_CARD_POOL = [
  {
    front: 'What problem was this conversation actually solving?',
    back: 'Name it in one sentence before anything else. If the sentence needs the word "and" twice, the goal has not been pinned down yet.',
  },
  {
    front: 'Which file carries most of the change, and why that one?',
    back: 'The file where the behaviour has to be true, not the file where the symptom showed up. The second is where you go to look, the first is where you go to change it.',
  },
  {
    front: 'What was rejected, and what was the reason?',
    back: 'Every abandoned approach is a decision. The reason is usually a constraint: a deadline, an interface that already exists, or a failure the first version would have had.',
  },
  {
    front: 'What would break first if this had to be rolled back?',
    back: 'Follow the writes. Whatever the code mutates before it can report success is the part a rollback has to undo, and it is rarely the part people remember writing.',
  },
];

const MCQ_POOL = [
  {
    prompt: 'Which change was made to keep the request path from failing silently?',
    options: [
      { key: 'A', text: 'The error is caught at the boundary and rethrown with the cause attached.' },
      { key: 'B', text: 'The call is retried a fixed number of times before giving up.' },
      { key: 'C', text: 'The failure is logged and the caller receives an empty result.' },
      { key: 'D', text: 'The error is swallowed so the rest of the request can complete.' },
    ],
    correctOptionKey: 'A',
    explanation: 'Swallowing the cause is the failure mode being fixed, so a catch that drops it, and a bare retry that hides the original error, are both the bug rather than the fix.',
  },
  {
    prompt: 'Why is the new logic placed in one shared helper rather than at each call site?',
    options: [
      { key: 'A', text: 'Fewer lines of code overall.' },
      { key: 'B', text: 'Call sites added later get the behaviour without remembering to add it.' },
      { key: 'C', text: 'The compiler cannot inline it at the call sites.' },
      { key: 'D', text: 'The framework requires every function to be called from exactly one place.' },
    ],
    correctOptionKey: 'B',
    explanation: 'The stated reason is drift: a call site added next quarter gets the behaviour for free, and nobody has to remember.',
  },
  {
    prompt: 'What does the change do about the input that already fails?',
    options: [
      { key: 'A', text: 'Validates it up front and reports which field was wrong.' },
      { key: 'B', text: 'Truncates it to the maximum length and continues.' },
      { key: 'C', text: 'Ignores the field and uses a default.' },
      { key: 'D', text: 'Passes it through unchanged and lets the caller handle the failure.' },
    ],
    correctOptionKey: 'D',
    explanation: 'Passing it through unchanged leaves the decision with the caller, which is the boundary the rest of the change assumes.',
  },
];

const OPEN_POOL = [
  {
    prompt: 'Explain the trade-off this change makes, and what it gives up to get it.',
    rubric: [
      { criterion: 'Names what is being traded, in terms of the system rather than the diff', weight: 2, mustMention: [] },
      { criterion: 'States at least one concrete thing lost or made harder', weight: 2, mustMention: [] },
      { criterion: 'Explains why the trade was worth it here', weight: 1, mustMention: [] },
    ],
    referenceAnswer:
      'The change moves one behaviour into a single place, which costs a little indirection at each call site and buys consistency for every call site that does not exist yet. It is worth it when the call sites are expected to grow, and it is not worth it when there is exactly one and it is not going to be joined.',
  },
  {
    prompt: 'What would you have to check to be confident this works, beyond the tests that were added?',
    rubric: [
      { criterion: 'Identifies a case the added tests do not cover', weight: 2, mustMention: [] },
      { criterion: 'Says how that case would be observed rather than assumed', weight: 1, mustMention: [] },
      { criterion: 'Distinguishes a rollback risk from a correctness risk', weight: 1, mustMention: [] },
    ],
    referenceAnswer:
      'Check the failure path under load, because a retry that is correct in a unit test can still be wrong when every request fails at once. Watch it rather than reason about it, and keep the rollback note separate from the correctness note, since the two are answered by different evidence.',
  },
];

const CLOZE_POOL = [
  {
    language: 'typescript',
    codeWithGaps: [
      'export async function withRetry<T>(',
      '  fn: (attempt: number) => Promise<T>,',
      '  opts: {{blank_1}} = {},',
      '): Promise<T> {',
      '  const attempts = opts.attempts ?? 3;',
      '  for (let i = 0; i < attempts; i++) {',
      '    try {',
      '      return await fn(i);',
      '    } catch (err) {',
      '      if (i === attempts - 1) throw err;',
      '    }',
      '  }',
      '  throw new Error("unreachable");',
      '}',
    ].join('\n'),
    blanks: [{ key: 'blank_1', answer: 'RetryOptions', alternatives: ['RetryOpts', 'RetryConfig', 'RetryOptions'] }],
  },
  {
    language: 'typescript',
    codeWithGaps: [
      'export function deriveTopics(session: Session): { topics: Topic[] } {',
      '  const turns = session.messages.filter((m) => m.role === {{blank_1}});',
      '  return { topics: segment(turns) };',
      '}',
    ].join('\n'),
    blanks: [{ key: 'blank_1', answer: 'user', alternatives: ['user', "'user'", 'User'] }],
  },
];

/** Off unless the environment says otherwise, and never a truthy-looking surprise. */
export function mockEnabled(env = process.env) {
  const raw = env?.[MOCK_ENV];
  if (raw == null) return false;
  const value = String(raw).trim().toLowerCase();
  return value !== '' && value !== '0' && value !== 'false' && value !== 'no';
}

/**
 * A response in the shape the Gemini schema returns, for one topic.
 *
 * Ids are `q1`, `q2` the way the models number their own output, because
 * `validateResult` mints the real question ids and ignores these. They are set
 * anyway: a shape the real path would never produce would fail to prove anything.
 *
 * @param {object} opts
 * @param {object} opts.topic            the real topic, for its id, label and turn range
 * @param {string[]} opts.types           the question types this topic was asked for
 * @param {number} opts.flashcardsPerTopic
 * @returns {{flashcards: object[], questions: object[]}}
 */
export function mockTopicResponse({ topic, types = [], flashcardsPerTopic = 2 }) {
  const from = Number.isFinite(topic?.from) ? topic.from : 0;
  const label = topic?.label || 'this topic';

  const flashcards = [];
  for (let i = 0; i < Math.max(0, flashcardsPerTopic); i++) {
    const card = FLASH_CARD_POOL[(i + Math.max(0, from)) % FLASH_CARD_POOL.length];
    flashcards.push({
      front: card.front,
      back: `${card.back} In this conversation it shows up around ${label}.`,
      sourceTurns: [from],
    });
  }

  const questions = [];
  types.forEach((type, i) => {
    const base = { id: `q${i + 1}`, type, sourceTurns: [from] };
    if (type === 'mcq') {
      const pool = MCQ_POOL[(i + from) % MCQ_POOL.length];
      questions.push({
        ...base,
        prompt: `${pool.prompt} Think about ${label}.`,
        explanation: `${pool.explanation} The question is scoped to ${label} because that is the topic this call was about.`,
        options: pool.options.map((o) => ({ key: o.key, text: o.text })),
        correctOptionKey: pool.correctOptionKey,
        rubric: [],
        referenceAnswer: '',
        language: '',
        codeWithGaps: '',
        blanks: [],
      });
      return;
    }
    if (type === 'cloze') {
      const pool = CLOZE_POOL[(i + from) % CLOZE_POOL.length];
      questions.push({
        ...base,
        prompt: `Fill in the blank in the real code this conversation introduced. It comes from ${label}.`,
        explanation: `The gap is an identifier with one correct spelling, taken from the ${label} discussion.`,
        options: [],
        correctOptionKey: '',
        rubric: [],
        referenceAnswer: '',
        language: pool.language,
        codeWithGaps: pool.codeWithGaps,
        blanks: pool.blanks,
      });
      return;
    }
    if (type === 'open') {
      const pool = OPEN_POOL[(i + from) % OPEN_POOL.length];
      questions.push({
        ...base,
        prompt: `${pool.prompt} Answer about ${label}.`,
        explanation: 'A written answer is scored against the rubric, which rewards naming the trade rather than restating the change.',
        options: [],
        correctOptionKey: '',
        rubric: pool.rubric.map((r) => ({ ...r, mustMention: [...r.mustMention] })),
        referenceAnswer: pool.referenceAnswer,
        language: '',
        codeWithGaps: '',
        blanks: [],
      });
    }
  });

  return { flashcards, questions };
}

/** A usage block shaped like the one the real client returns, so nothing downstream reads undefined. */
export const MOCK_USAGE = { promptTokenCount: 0, candidatesTokenCount: 0, totalTokenCount: 0 };
