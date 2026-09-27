// FUNCTIONAL LAYER — turns what the backend returns into what a view needs.
//
// A quiz from the backend mixes three question types plus flashcards, each with its own
// fields. If the visual layer read that shape directly, every visual change would have to
// re-learn it and every backend change would break rendering.
//
// So this file produces a flat list of STEPS with one shape:
//
//   { index, id, kind, topicId, topicLabel, prompt, choices?, correctId?, answer?, ... }
//
// The visual layer renders a step. It never sees `correctOptionKey`, `codeWithGaps` or
// `blanks` — only `choices` and what a correct response looks like.

/** @typedef {'flashcard'|'mcq'|'cloze'|'open'} StepKind */

const LETTERS = 'ABCDEFGH';

/**
 * Build the ordered step list for a quiz: every flashcard, then every question.
 *
 * Two phases rather than interleaved per topic. The flow is learn the prerequisites,
 * then be tested, and a single phase boundary is much easier to label in the UI
 * ("Flashcard 3 of 7" then "Question 1 of 6") than a topic-by-topic alternation.
 *
 * Within each phase the order is shuffled, so the deck does not arrive in the order the
 * topics happened to be selected. `seed` makes that reproducible: the same seed always
 * yields the same order, which is what a test or a screenshot needs. Omitted, the seed
 * is random and so is the order. A retake re-shuffles, which is the point of retrying.
 *
 * Steps are ordered for presentation only. Grading is by question id, so nothing here
 * affects a stored attempt.
 *
 * @param {object} quiz       A quiz as the backend returned it.
 * @param {string|number} [seed]  Omit for a random order.
 */
export function toSteps(quiz, seed) {
  if (!quiz) return [];
  const random = seededRandom(seed);

  // Built in the backend's order first and shuffled afterwards, so a card's id identifies
  // the card rather than the slot it happened to be drawn in. The counter runs over the
  // whole deck, not per topic: flashcards per topic is a user setting, and an extended
  // quiz concatenates two runs over the same topics, so a per-topic counter would mint
  // the same id twice.
  const cards = (quiz.flashcards || []).map((card, n) => ({
    kind: 'flashcard',
    id: `card-${card.topicId}-${n}`,
    topicId: card.topicId,
    topicLabel: card.topicLabel || card.topicId,
    front: card.front,
    back: card.back,
  }));

  const questions = [];
  const placedIds = new Set();
  for (const question of quiz.questions || []) {
    const step = questionToStep(question);
    if (placedIds.has(step.id)) continue;
    placedIds.add(step.id);
    questions.push(step);
  }

  const steps = [...shuffled(cards, random), ...shuffled(questions, random)];
  return steps.map((step, index) => ({ ...step, index, isLast: index === steps.length - 1 }));
}

/**
 * A seeded generator in [0, 1), so presentation order is reproducible.
 *
 * mulberry32 over an FNV-1a of the seed. Small, dependency free, and stable across
 * runs, which matters because the order is visible in a screenshot.
 */
export function seededRandom(seed) {
  const key = String(seed ?? Math.random().toString(36).slice(2));
  let state = 0x811c9dc5;
  for (let i = 0; i < key.length; i += 1) {
    state = Math.imul(state ^ key.charCodeAt(i), 0x01000193) >>> 0;
  }
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher-Yates on a copy, so the caller's list is untouched. */
function shuffled(items, random) {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function questionToStep(question) {
  const base = {
    id: question.id,
    kind: question.type,
    topicId: question.topicId,
    topicLabel: question.topicLabel || question.topicId,
    prompt: question.prompt,
    explanation: question.explanation,
    sourceTurns: question.sourceTurns || [],
    /** True when this kind is graded by the model rather than locally. */
    needsApi: question.type === 'open',
  };

  if (question.type === 'mcq') {
    return {
      ...base,
      choices: (question.options || []).map((option, i) => ({
        id: option.key || LETTERS[i],
        label: option.text,
        letter: option.key || LETTERS[i],
      })),
      correctId: question.correctOptionKey,
    };
  }

  if (question.type === 'cloze') {
    return {
      ...base,
      language: question.language || '',
      code: question.codeWithGaps,
      blanks: (question.blanks || []).map((blank) => ({
        key: blank.key,
        /** Present only after grading, or when the answer is revealed. */
        answer: blank.answer,
        alternatives: blank.alternatives || [],
      })),
    };
  }

  return {
    ...base,
    rubric: (question.rubric || []).map((criterion) => ({
      criterion: criterion.criterion,
      weight: criterion.weight,
      mustMention: criterion.mustMention || [],
    })),
    referenceAnswer: question.referenceAnswer || '',
  };
}

/**
 * Can this step be answered without a model?
 *
 * Read from the step rather than hardcoded so a future type declares itself.
 */
export function isLocalStep(step) {
  return step.kind === 'mcq' || step.kind === 'cloze';
}

/**
 * What the UI should show for a graded step, independent of how it is drawn.
 *
 * `status` is the only thing the visual layer needs to branch on.
 */
export function describeResult(step, result) {
  if (!result) return { status: 'unanswered', headline: 'Not answered' };
  if (result.error) {
    return { status: 'error', headline: 'Could not be graded', detail: result.error };
  }
  if (step.kind === 'open') {
    return {
      status: result.awarded >= 0.85 ? 'correct' : result.awarded > 0 ? 'partial' : 'wrong',
      headline: result.verdict === 'correct' ? 'Correct' : result.verdict === 'partial' ? 'Partly right' : 'Not quite',
      detail: result.feedback,
      criteria: (result.perCriterion || []).map((c) => ({
        criterion: c.criterion,
        awarded: c.awarded,
        weight: c.weight,
        comment: c.comment,
      })),
      missing: result.missing || [],
    };
  }
  if (step.kind === 'cloze') {
    const blanks = result.perBlank || [];
    return {
      status: result.correct ? 'correct' : result.awarded > 0 ? 'partial' : 'wrong',
      headline: result.correct ? 'Correct' : result.awarded > 0 ? 'Partly right' : 'Not quite',
      detail: step.explanation,
      blanks: blanks.map((b) => ({ key: b.key, correct: b.correct, expected: b.expected, given: b.given })),
    };
  }
  return {
    status: result.correct ? 'correct' : 'wrong',
    headline: result.correct ? 'Correct' : 'Not quite',
    detail: step.explanation,
    expected: result.expected,
    given: result.given,
  };
}

/** How many steps of each phase, for labelling without walking the list twice. */
export function phaseCounts(steps) {
  const list = Array.isArray(steps) ? steps : [];
  return {
    flashcards: list.filter((s) => s.kind === 'flashcard').length,
    questions: list.filter((s) => s.kind !== 'flashcard').length,
  };
}

/**
 * The kicker above the title: "FLASHCARD 3 OF 7" or "QUESTION 2 OF 6".
 *
 * Both numbers are counted off the list rather than assumed, so a deck with one card per
 * topic and a deck with five both label correctly. A flashcard is counted among
 * flashcards and a question among questions: the two phases are numbered separately,
 * which is what makes the single phase boundary legible.
 */
export function stepLabel(step, steps) {
  const list = Array.isArray(steps) ? steps : [];
  const { flashcards, questions } = phaseCounts(list);

  if (step?.kind === 'flashcard') {
    const at = list.indexOf(step);
    return `FLASHCARD ${at < 0 ? 1 : at + 1} OF ${flashcards}`;
  }

  const questionSteps = list.filter((s) => s.kind !== 'flashcard');
  const at = questionSteps.indexOf(step);
  return `QUESTION ${Math.min(at < 0 ? 1 : at + 1, questions)} OF ${questions}`;
}

/**
 * The results card's contents.
 *
 * The band and its copy come from the backend so the thresholds live in one place and
 * every screen that reports a score agrees. `band` is null when there is nothing to score.
 */
export function summarize(attempt, { band = null } = {}) {
  if (!attempt) {
    return { score: 0, total: 0, percentage: 0, band: null, line: 'Nothing to score yet.' };
  }
  const total = attempt.maxScore || 0;
  const percentage = attempt.percentage || 0;
  return {
    score: attempt.score ?? 0,
    total,
    percentage,
    band,
    mapped: attempt.perQuestion || [],
    line: total === 0 ? 'Nothing to score yet.' : band?.line || '',
  };
}
