// Grading.
//
// Two halves, and the split matters for cost:
//
//   multiple choice and fill-in-the-blank are graded HERE, deterministically. No model
//   call, no latency, no variance, and the same answer always scores the same.
//
//   open-ended needs a model, because the whole point of the type is that a correct
//   answer can be phrased a hundred ways. That is the only grading request in the app,
//   and it is one call per open question the user actually answered — not one for the
//   quiz, so an unattempted question costs nothing.
//
// `capabilities.types[].needsGrading` is the flag that says which is which, so the
// frontend can show progress accurately without knowing this split exists.

import { generateJson } from './gemini.js';

export const GRADE_MODEL_CHAIN = undefined; // reuse gemini.js's default chain

/**
 * Fold an answer for comparison.
 *
 * Deliberately generous, because the failure mode that matters is marking a correct
 * answer wrong over punctuation. Case, surrounding whitespace, backticks, quotes and a
 * trailing semicolon are not the point of a fill-in-the-blank question.
 */
export function normalizeAnswer(value) {
  let out = String(value ?? '').toLowerCase();
  const EDGE = /^[`"';,\s]+|[`"';,\s]+$/g;
  // Repeat, because one pass cannot remove mixed decoration: stripping the quotes from
  // `"release";` leaves `release"`, since the semicolon was the trailing character.
  for (let i = 0; i < 4; i++) {
    const next = out.replace(EDGE, '');
    if (next === out) break;
    out = next;
  }
  return out.replace(/\s+/g, ' ').trim();
}

/** Grade a multiple-choice answer. Returns null when there is nothing to grade. */
export function gradeMcq(question, answer) {
  const expected = String(question.correctOptionKey || '').trim();
  const given = String(typeof answer === 'string' ? answer : answer?.value ?? '').trim();
  if (!expected) return null;
  return {
    questionId: question.id,
    type: 'mcq',
    correct: given.toUpperCase() === expected.toUpperCase(),
    awarded: given.toUpperCase() === expected.toUpperCase() ? 1 : 0,
    weight: 1,
    expected,
    given,
    needsApi: false,
  };
}

/**
 * Grade a fill-in-the-blank answer.
 *
 * Each blank is worth an equal share, so a question with two blanks answered correctly
 * and one wrong scores two thirds rather than zero. `alternatives` widens the accepted
 * set, which is why the schema asks for them: `rows.Close()` and `rows.close()` are the
 * same answer.
 */
export function gradeCloze(question, answer) {
  const blanks = question.blanks || [];
  if (blanks.length === 0) return null;

  // Accept either { blank_1: 'x' } or a bare string when there is a single blank.
  const givenMap =
    answer && typeof answer === 'object' && !Array.isArray(answer)
      ? answer
      : { [blanks[0].key]: typeof answer === 'string' ? answer : '' };

  const perBlank = blanks.map((blank) => {
    const accepted = [blank.answer, ...(blank.alternatives || [])].map(normalizeAnswer).filter(Boolean);
    const given = normalizeAnswer(givenMap[blank.key]);
    return {
      key: blank.key,
      answered: given.length > 0,
      correct: given.length > 0 && accepted.includes(given),
      expected: blank.answer,
      given: givenMap[blank.key] ?? '',
    };
  });

  const correct = perBlank.filter((b) => b.correct).length;
  return {
    questionId: question.id,
    type: 'cloze',
    correct: correct === blanks.length,
    awarded: correct / blanks.length,
    weight: 1,
    perBlank,
    needsApi: false,
  };
}

/** Everything that can be graded without a model. Returns null for `open`. */
export function gradeObjective(question, answer) {
  if (question?.type === 'mcq') return gradeMcq(question, answer);
  if (question?.type === 'cloze') return gradeCloze(question, answer);
  return null;
}

/** The response schema for grading one open answer. */
export function gradeSchema() {
  return {
    type: 'object',
    properties: {
      score: { type: 'number', description: 'Overall 0..1.' },
      verdict: { type: 'string', enum: ['correct', 'partial', 'incorrect'] },
      perCriterion: {
        type: 'array',
        description: 'One entry per rubric criterion, in the order given.',
        items: {
          type: 'object',
          properties: {
            criterion: { type: 'string' },
            awarded: { type: 'number', description: 'Fraction of this criterion met, 0..1.' },
            comment: { type: 'string' },
          },
          required: ['criterion', 'awarded', 'comment'],
        },
      },
      missing: { type: 'array', items: { type: 'string' } },
      feedback: { type: 'string', description: 'Two or three sentences addressed to the learner.' },
    },
    required: ['score', 'verdict', 'perCriterion', 'missing', 'feedback'],
  };
}

function buildGradePrompt(question, answer) {
  const rubric = (question.rubric || [])
    .map((r, i) => `${i + 1}. ${r.criterion} (weight ${r.weight})${r.mustMention?.length ? `. Should mention: ${r.mustMention.join(', ')}` : ''}`)
    .join('\n');

  return `You are grading one written answer from a developer who is revising their own work.

QUESTION
${question.prompt}

WHAT A GOOD ANSWER CONTAINS
${rubric}

${question.referenceAnswer ? `REFERENCE ANSWER\n${question.referenceAnswer}\n\n` : ''}THEIR ANSWER
${String(answer ?? '').trim() || '(no answer given)'}

HOW TO GRADE
- Score each criterion independently as a fraction of what it asked for. A half-right
  answer scores half.
- Judge the substance, not the phrasing. A correct idea in plain words is correct; a
  confident sentence that misses the point is not.
- If the answer is empty, score 0 and say so plainly in the feedback.
- The reference answer is one way to answer, not the only one. Do not require its wording.
- Feedback is two or three sentences, addressed to the answerer, saying what was right and
  precisely what was missing. No praise padding, no restating the question.
- Use plain language. No "utilise", no "leverage", no noun stacks.`;
}

/**
 * Grade one open answer with a model. One request, one question.
 *
 * @returns {Promise<object>} a result shaped like gradeObjective's, plus `feedback`
 */
export async function gradeOpen(question, answer, options = {}) {
  const rubric = question.rubric || [];
  const totalWeight = rubric.reduce((n, r) => n + (Number(r.weight) || 1), 0) || 1;

  // An empty answer needs no request: the outcome is already known, and this is the case
  // a user is most likely to hit by skipping a question.
  const text = String(answer ?? '').trim();
  if (!text) {
    return {
      questionId: question.id,
      type: 'open',
      correct: false,
      awarded: 0,
      weight: 1,
      score: 0,
      verdict: 'incorrect',
      perCriterion: rubric.map((r) => ({ criterion: r.criterion, awarded: 0, comment: 'Not answered.' })),
      missing: rubric.map((r) => r.criterion),
      feedback: 'No answer was given.',
      needsApi: false,
      gradedBy: 'empty',
    };
  }

  const { data, model, usage, attempts } = await generateJson({
    prompt: buildGradePrompt(question, answer),
    schema: gradeSchema(),
    models: options.models,
    apiKey: options.apiKey,
    // Grading must be repeatable: the same answer has to score the same way twice.
    temperature: 0,
    signal: options.signal,
    onAttempt: options.onAttempt,
  });

  // The model returns a 0..1 score; the weighted total is what the caller needs, and it
  // is recomputed from the criteria so a malformed overall score cannot distort it.
  const perCriterion = rubric.map((criterion, index) => {
    const returned = data.perCriterion?.[index];
    const awarded = Number(returned?.awarded);
    return {
      criterion: criterion.criterion,
      weight: Number(criterion.weight) || 1,
      awarded: Number.isFinite(awarded) ? Math.min(1, Math.max(0, awarded)) : 0,
      comment: String(returned?.comment || ''),
    };
  });
  const weighted = perCriterion.reduce((n, c) => n + c.awarded * c.weight, 0) / totalWeight;

  return {
    questionId: question.id,
    type: 'open',
    correct: weighted >= 0.85,
    awarded: weighted,
    weight: 1,
    score: weighted,
    // Derived from the recomputed mark rather than taken from the model, so the label and
    // the number can never disagree. The model's own verdict is kept for debugging.
    verdict: weighted >= 0.85 ? 'correct' : weighted > 0 ? 'partial' : 'incorrect',
    modelVerdict: data.verdict,
    perCriterion,
    missing: (data.missing || []).map(String),
    feedback: String(data.feedback || ''),
    needsApi: true,
    gradedBy: model,
    usage: { tokens: usage?.totalTokenCount || 0, attempts: attempts?.length || 0 },
  };
}

/**
 * Grade a whole attempt.
 *
 * Objective questions are graded locally and immediately; open ones are graded in
 * parallel, one request each. Questions with no answer are still reported, so the
 * caller can show "3 of 6 answered" rather than silently scoring them zero.
 *
 * @param {object} quiz      a stored or freshly generated quiz
 * @param {object} answers   { questionId: answer }
 * @returns {Promise<object>} { perQuestion, score, maxScore, answered, skipped, needsApi }
 */
/**
 * Whether the learner gave anything at all for this question.
 *
 * This only labels the report. A question nobody answered is "skipped", and calling it
 * "missed" tells someone they got it wrong when they never tried, which is the difference
 * the skip button exists to offer.
 *
 * It deliberately does not move the score. Every question stays worth a mark and a
 * skipped one forfeits it, which is what "an unattempted attempt scores zero" pins down in
 * backend/test/store.test.js. The hint beside the skip button says so, rather than
 * promising a discount the grading does not give.
 */
function answeredNothing(answer) {
  if (answer == null) return true;
  if (typeof answer === 'string') return answer.trim().length === 0;
  if (typeof answer === 'object') {
    return Object.values(answer).every((value) => String(value ?? '').trim().length === 0);
  }
  return false;
}

export async function gradeAttempt(quiz, answers = {}, options = {}) {
  const questions = quiz?.questions || [];
  const perQuestion = [];

  for (const question of questions) {
    const answer = answers[question.id];
    const unanswered = answeredNothing(answer);

    if (question.type === 'open') {
      if (options.skipOpen) {
        perQuestion.push({ questionId: question.id, type: 'open', needsApi: true, skipped: true });
        continue;
      }
      try {
        const graded = await gradeOpen(question, answer, options);
        perQuestion.push(unanswered ? { ...graded, unanswered: true } : graded);
      } catch (err) {
        perQuestion.push({
          questionId: question.id,
          type: 'open',
          needsApi: true,
          error: String(err?.message || err),
        });
      }
      continue;
    }

    const result = gradeObjective(question, answer);
    // `unanswered` is a label, not a discount: the result keeps its awarded 0 and stays in
    // `graded` below, so the skipped question still costs its mark.
    if (result) perQuestion.push(unanswered ? { ...result, unanswered: true } : result);
  }

  const graded = perQuestion.filter((r) => typeof r.awarded === 'number');
  const score = graded.reduce((n, r) => n + r.awarded, 0);
  const maxScore = graded.length;
  const answered = graded.filter((r) => r.awarded > 0 || r.correct).length;

  return {
    perQuestion,
    score: +score.toFixed(3),
    maxScore,
    percentage: maxScore > 0 ? +((score / maxScore) * 100).toFixed(1) : 0,
    answered,
    total: questions.length,
    needsApi: perQuestion.some((r) => r.needsApi),
    tokens: perQuestion.reduce((n, r) => n + (r.usage?.tokens || 0), 0),
    gradedAt: Date.now(),
  };
}
