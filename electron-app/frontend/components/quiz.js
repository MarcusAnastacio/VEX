// VISUAL LAYER — the quiz: flashcards, the three question types, feedback, and results.
//
// Expected to change; the CSS in styles/quiz.css was written by the frontend branch and
// this keeps its class names so that styling still applies.
//
// What it receives is a STEP from lib/quiz-view.js, never a raw question. It branches on
// `kind` and on the `status` a result was mapped to, and nothing else.

import { seededRandom } from '../lib/quiz-view.js';

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

/** How each question type is named on screen. One phrase per type, used everywhere. */
const KIND = {
  flashcard: 'Flashcard',
  mcq: 'Multiple choice',
  cloze: 'Fill in the blank',
  open: 'Open answer',
};

/**
 * The verdict words and the mark each one draws. `feedback--` in the class name and the
 * copy in the headline both come from the backend, so this only decides which mark and
 * which tint go with a status.
 */
const VERDICT = {
  correct: { mark: 'correct' },
  partial: { mark: 'partial' },
  wrong: { mark: 'wrong' },
  error: { mark: 'error' },
};

/**
 * Every step this session has drawn, keyed by id.
 *
 * The results card is handed a summary and a raw attempt, and the attempt only knows
 * question ids. Remembering the steps as they are rendered is what lets the score
 * breakdown name the questions it is scoring instead of listing six anonymous ticks.
 */
const SEEN = new Map();

/** The score, without a trailing ".0" on a whole number. */
const formatScore = (n) => {
  const value = Number(n) || 0;
  return Number.isInteger(value) ? String(value) : String(Math.round(value * 10) / 10);
};

/** "Gap 1" from "blank_1", so the code below never has to explain the keys. */
const gapName = (key, index) => `Gap ${String(key || '').match(/(\d+)/)?.[1] ?? index + 1}`;

/** Render one step into `container`, reporting the response through `onRespond`.
 *
 * `onSkip` and `onRetryStep` are optional and additive: without them the strip is not
 * drawn and the step behaves exactly as before. `onRetryStep` only appears once a
 * result exists, because there is nothing to retry before an answer.
 */
export function renderStep(container, { step, result, onRespond = () => {}, onNext, onSkip, onRetryStep, isLast } = {}) {
  container.replaceChildren();
  if (!step) return;
  if (step.id) SEEN.set(step.id, step);

  if (step.kind === 'flashcard') {
    container.append(flashcard(step, { onNext, isLast }));
  } else {
    const card = h('section', { class: 'question-card' });
    card.append(cardHead(step, step.kind === 'cloze' && step.language ? chip(step.language) : null));

    if (step.kind === 'mcq') card.append(mcq(step, { result, onRespond, onNext, isLast }));
    else if (step.kind === 'cloze') card.append(cloze(step, { result, onRespond, onNext, isLast }));
    else card.append(open(step, { result, onRespond, onNext, isLast }));

    container.append(card);
  }

  const nav = stepNav({ step, result, onSkip, onRetryStep, isLast });
  if (nav) container.append(nav);
}

/**
 * Skip and retry, the two moves that are not answering.
 *
 * Skip records nothing: the step is left unanswered, which is a different thing from
 * answering wrong and is reported as "skipped" rather than "missed". It is not free.
 * Every question is worth a mark and a skipped one forfeits it, so the hint says that
 * instead of promising a discount the grading does not give. Verified against
 * gradeAttempt, where an unanswered question still lands in `graded` with an awarded 0.
 *
 * Retry is offered only on a step that has already been graded, and clears this step's
 * response so the same question can be answered again. It is per question. The whole
 * quiz restart is a different button on the results card and stays there.
 *
 * Skip is hidden on the last step, where it would be a second route to the results card
 * that the feedback button already offers.
 */
function stepNav({ step, result, onSkip, onRetryStep, isLast }) {
  if (!onSkip && !onRetryStep) return null;

  const row = h('div', { class: 'quiz-nav' });
  if (onRetryStep && result) {
    row.append(h('button', {
      class: 'btn btn--ghost quiz-nav__retry',
      type: 'button',
      text: 'Answer again',
      onclick: onRetryStep,
    }));
  }
  if (onSkip && !isLast) {
    row.append(h('button', {
      class: 'btn btn--ghost quiz-nav__skip',
      type: 'button',
      text: step?.kind === 'flashcard' ? 'Skip card' : 'Skip question',
      onclick: onSkip,
    }));
  }
  if (!row.childElementCount) return null;
  row.append(h('span', { class: 'quiz-nav__hint', text: 'A skipped question is left unanswered and earns no mark' }));
  return row;
}

/** The strip at the top of every card: what kind of thing this is, and what it is about. */
function cardHead(step, extra = null) {
  return h(
    'div',
    { class: 'card-head' },
    h('span', { class: 'card-head__kind', text: KIND[step.kind] || 'Question' }),
    step.topicLabel ? h('span', { class: 'card-head__topic', text: step.topicLabel }) : null,
    extra,
  );
}

const chip = (text) => h('span', { class: 'card-head__lang', text });

/** The mark and its label, as one unit, so a narrow card can drop them to a new row. */
const verdict = (kind, text) =>
  h('span', { class: 'option__verdict' }, mark(kind), h('span', { class: 'option__note', text }));

/** The primary move forward, shared by the flashcard and by every verdict block. */
const nextButton = ({ onNext, isLast }) =>
  h('button', {
    class: 'btn btn--primary feedback__next',
    type: 'button',
    text: isLast ? 'See results' : 'Next question',
    onclick: onNext,
  });

// ── Flashcards ─────────────────────────────────────────────────────────────

function flashcard(step, { onNext, isLast }) {
  const card = h('section', { class: 'question-card flashcard' });
  card.append(cardHead(step, h('span', { class: 'card-head__hint', text: 'Answer it before you look' })));

  const back = h('div', { class: 'flashcard__back', hidden: true }, h('p', { text: step.back }));
  const reveal = h('button', {
    class: 'btn btn--primary flashcard__reveal',
    type: 'button',
    text: 'Show the answer',
    onclick: () => {
      back.hidden = false;
      card.classList.add('flashcard--revealed');
      reveal.remove();
      card.append(nextButton({ onNext, isLast }));
    },
  });

  card.append(h('h3', { class: 'question__prompt', text: step.front }), back, reveal);
  return card;
}

// ── Multiple choice ────────────────────────────────────────────────────────

function mcq(step, { result, onRespond, onNext, isLast }) {
  const wrap = h('div', { class: 'q' });
  wrap.append(h('h3', { class: 'question__prompt', text: step.prompt }));

  const options = h('div', { class: 'options' });
  const answered = Boolean(result);

  for (const choice of step.choices || []) {
    const button = h(
      'button',
      {
        class: 'option',
        type: 'button',
        disabled: answered || undefined,
      },
      h('span', { class: 'option__letter', text: choice.letter }),
      h('span', { class: 'option__label', text: choice.label }),
    );
    if (answered) {
      // The correct option is always marked, whether or not it was the one chosen, so
      // that a wrong answer still shows what the right one was.
      if (choice.id === step.correctId) {
        button.classList.add('option--correct');
        button.append(verdict('correct', 'Correct answer'));
      } else if (choice.id === result?.given) {
        button.classList.add('option--wrong');
        button.append(verdict('wrong', 'Your answer'));
      } else {
        button.classList.add('option--muted');
      }
    } else {
      button.addEventListener('click', () => onRespond(choice.id));
    }
    options.append(button);
  }
  wrap.append(options);

  if (result) wrap.append(feedback(result, { onNext, isLast }));
  return wrap;
}

// ── Fill in the blanks ─────────────────────────────────────────────────────

function cloze(step, { result, onRespond, onNext, isLast }) {
  const wrap = h('div', { class: 'q' });
  wrap.append(h('h3', { class: 'question__prompt', text: step.prompt }));

  const inputs = new Map();
  const answered = Boolean(result);

  // The code is rendered as text with an input in place of each {{blank_N}}, so the gap
  // sits inside the code rather than beside it.
  const code = h('pre', { class: 'cloze' });
  const source = String(step.code || '');
  const parts = source.split(/(\{\{blank_\d+\}\})/g);
  for (const part of parts) {
    const match = /^\{\{(blank_\d+)\}\}$/.exec(part);
    if (!match) {
      code.append(document.createTextNode(part));
      continue;
    }
    const key = match[1];
    const marked = result?.blanks?.find((b) => b.key === key);
    const field = h('input', {
      class: `cloze__blank ${marked ? (marked.correct ? 'cloze__blank--correct' : 'cloze__blank--wrong') : ''}`,
      type: 'text',
      'data-key': key,
      'aria-label': gapName(key, inputs.size),
      spellcheck: 'false',
      autocomplete: 'off',
      disabled: answered || undefined,
      value: marked?.given ?? '',
      placeholder: key,
    });
    inputs.set(key, field);
    code.append(field);
  }
  wrap.append(code);

  if (!answered) {
    wrap.append(
      h('div', { class: 'q__actions' },
        h('button', {
          class: 'btn btn--primary',
          type: 'button',
          text: 'Check answer',
          onclick: () => {
            const response = {};
            for (const [key, field] of inputs) response[key] = field.value;
            onRespond(response);
          },
        }),
        h('span', { class: 'q__actions-hint', text: 'Every gap has to be right' }),
      ),
    );
  } else {
    if (result?.blanks) wrap.append(blankList(result.blanks));
    wrap.append(feedback(result, { onNext, isLast }));
  }
  return wrap;
}

/** What went into each gap, and what should have gone in instead. */
function blankList(blanks) {
  const list = h('ul', { class: 'blanks' });
  blanks.forEach((blank, index) => {
    const given = String(blank.given ?? '').trim();
    const expected = String(blank.expected ?? '').trim();
    list.append(
      h('li', { class: `blanks__row blanks__row--${blank.correct ? 'correct' : 'wrong'}` },
        mark(blank.correct ? 'correct' : 'wrong'),
        h('span', { class: 'blanks__key', text: gapName(blank.key, index) }),
        h('code', { class: 'blanks__value', text: given || 'left blank' }),
        blank.correct || !expected || expected === given
          ? null
          : h('span', { class: 'blanks__expected', text: `expected ${expected}` }),
      ),
    );
  });
  return list;
}

// ── Open-ended ─────────────────────────────────────────────────────────────

function open(step, { result, onRespond, onNext, isLast }) {
  const wrap = h('div', { class: 'q' });
  wrap.append(h('h3', { class: 'question__prompt', text: step.prompt }));

  if (step.rubric?.length) {
    wrap.append(
      h('div', { class: 'rubric' },
        h('p', { class: 'rubric__label', text: 'A full answer covers' }),
        h('ul', { class: 'rubric__list' },
          ...step.rubric.map((criterion) => h('li', { text: criterion.criterion })),
        ),
      ),
    );
  }

  if (!result) {
    const area = h('textarea', {
      class: 'open__answer',
      rows: 5,
      placeholder: 'Explain in your own words…',
      spellcheck: 'true',
    });
    wrap.append(
      area,
      h('div', { class: 'q__actions' },
        h('button', {
          class: 'btn btn--primary',
          type: 'button',
          text: 'Submit answer',
          onclick: () => onRespond(area.value),
        }),
        h('span', { class: 'q__actions-hint', text: 'Graded against the points above' }),
      ),
    );
    return wrap;
  }

  const extra = [];
  if (result.criteria?.length) {
    extra.push(
      h('ul', { class: 'criteria' },
        ...result.criteria.map((criterion) => {
          const met = criterion.awarded >= 0.85 ? 'met' : criterion.awarded > 0 ? 'partly met' : 'not met';
          return h('li', { class: `criteria__row criteria__row--${met.replace(/\s/g, '-')}` },
            mark(met === 'met' ? 'correct' : met === 'partly met' ? 'partial' : 'wrong'),
            h('span', { class: 'criteria__criterion', text: criterion.criterion }),
            h('span', { class: 'criteria__verdict', text: met }),
            criterion.comment ? h('span', { class: 'criteria__comment', text: criterion.comment }) : null,
          );
        }),
      ),
    );
  }
  if (result.missing?.length) {
    extra.push(
      h('p', { class: 'criteria__missing' },
        h('strong', { text: 'Not mentioned: ' }),
        result.missing.join(', '),
      ),
    );
  }
  wrap.append(feedback(result, { onNext, isLast, extra }));
  return wrap;
}

// ── Feedback and results ───────────────────────────────────────────────────

/**
 * A drawn verdict mark.
 *
 * The check, the cross and the dash are borders and rotated bars rather than glyphs, so
 * they never depend on which font happens to carry U+2713. Bundled latin faces usually
 * do not, and a missing glyph is exactly the kind of silent fallback nobody catches in
 * a screenshot.
 */
function mark(kind) {
  return h('span', { class: `mark mark--${kind}`, 'aria-hidden': 'true' });
}

/**
 * The moment after an answer.
 *
 * Status decides the tint and the mark; the headline and the detail are the backend's
 * words, so the grading rules stay in one place. Anything extra (a per-blank list, the
 * rubric verdicts) is appended before the button, because the next move is the last
 * thing on screen.
 */
function feedback(result, { onNext, isLast, extra = [] }) {
  const verdict = VERDICT[result.status] || VERDICT.wrong;
  const block = h(
    'div',
    { class: `feedback feedback--${result.status || 'wrong'}` },
    mark(verdict.mark),
    h('div', { class: 'feedback__body' },
      h('strong', { class: 'feedback__headline', text: result.headline }),
      result.detail ? h('p', { class: 'feedback__detail', text: result.detail }) : null,
      ...extra,
    ),
  );
  if (onNext) block.append(nextButton({ onNext, isLast }));
  return block;
}

/**
 * The end card.
 *
 * Wording comes from the band the backend chose, so the four thresholds and their copy
 * are defined once. `tone` is exposed as a class so the colour can be styled without
 * knowing which band produced it.
 *
 * The confetti is part of this, not a wrapper around it: the celebration has to be drawn
 * on the same pass that draws the score, or the result appears first and the reaction
 * lands a frame later, which reads as lag.
 */
export function renderResults(container, { summary, attempt, onBack, onRetry } = {}) {
  container.replaceChildren();
  const band = summary?.band;
  const total = Number(summary?.total ?? 0);
  const percentage = Math.max(0, Math.min(100, Number(summary?.percentage ?? 0)));
  const bits = confettiCount(percentage, total);

  const card = h(
    'section',
    { class: `result-card result-card--celebrate${band ? ` result-card--${band.tone}` : ''}` },
    confetti(bits, percentage),
    h('div', { class: 'result-card__top' },
      h('span', { class: 'result-card__eyebrow', text: 'Your score' }),
      h('span', { class: 'result-card__percent', text: total > 0 ? `${Math.round(percentage)}%` : 'not scored' }),
    ),
    h('div', { class: 'result-card__dial' },
      h('p', { class: 'result-card__score' },
        h('span', { class: 'result-card__value', text: formatScore(summary?.score) }),
        h('span', { class: 'result-card__of', text: ` / ${total}` }),
      ),
      total > 0 ? meter(percentage) : null,
    ),
    h('h3', { class: 'result-card__headline', text: band?.headline || 'Quiz complete' }),
    summary?.line ? h('p', { class: 'result-card__line', text: summary.line }) : null,
    breakdown(attempt),
  );

  const row = h('div', { class: 'result-card__actions' });
  if (onRetry) row.append(h('button', { class: 'btn', type: 'button', text: 'Try again', onclick: onRetry }));
  if (onBack) row.append(h('button', { class: 'btn btn--primary', type: 'button', text: 'Back to conversation', onclick: onBack }));
  card.append(row);
  container.append(card);
}

/** How much of the quiz was earned, as one filled bar. */
function meter(percentage) {
  return h('div', { class: 'meter' },
    h('span', { class: 'meter__fill', style: `width: ${percentage}%` }),
  );
}

// ── Confetti ──────────────────────────────────────────────────────────────

/** A low score still gets a nod. Zero marks still means you finished something. */
const CONFETTI_MIN = 16;
/** A perfect run gets the full storm. */
const CONFETTI_MAX = 96;
/** Five tints, cycled, so the burst is not a single block of one colour. */
const CONFETTI_TINTS = ['a', 'b', 'c', 'd', 'e'];

/**
 * How many pieces to drop, from the score.
 *
 * Linear in the percentage between a floor and a ceiling, and never below the floor,
 * including when there is nothing to score at all: the screen that celebrates finishing
 * is the same screen that reports a bad result, so the reaction cannot be conditional on
 * the result being good.
 */
function confettiCount(percentage, total) {
  if (!(total > 0)) return CONFETTI_MIN;
  return CONFETTI_MIN + Math.round((Math.max(0, Math.min(100, percentage)) / 100) * (CONFETTI_MAX - CONFETTI_MIN));
}

/**
 * The pieces themselves.
 *
 * DOM and CSS only, no canvas and no library: a few absolutely positioned spans, each
 * with its own fall duration, delay, drift and spin handed over as custom properties, so
 * the animation itself stays in the stylesheet and this function only decides how many
 * and where. Seeded from the score, so the same result draws the same burst and a
 * screenshot is comparable between runs.
 *
 * `aria-hidden`, because a decorative celebration is not content and a screen reader
 * announcing 96 spans of nothing is worse than no celebration.
 */
function confetti(count, percentage) {
  const random = seededRandom(`confetti-${percentage}`);
  const layer = h('div', { class: 'confetti', 'aria-hidden': 'true' });
  for (let i = 0; i < count; i += 1) {
    const bit = h('span', {
      class: `confetti__bit confetti__bit--${CONFETTI_TINTS[i % CONFETTI_TINTS.length]}`,
    });
    // Custom properties have to go through setProperty. Setting them as a `style`
    // attribute string leaves them unregistered: every var() in the rule then fails,
    // the animation shorthand is invalid at computed-value time, animation-name
    // computes to none, and each piece sits at its initial opacity:0 forever. Measured
    // in the running window (attribute gave animationName 'none', setProperty 'q-fall'),
    // not assumed. The order of these five calls is the seeded draw order, so the same
    // score still produces the same burst.
    bit.style.setProperty('--x', `${(random() * 100).toFixed(2)}%`);
    bit.style.setProperty('--drift', `${((random() - 0.5) * 90).toFixed(1)}px`);
    bit.style.setProperty('--spin', `${Math.round(180 + random() * 900)}deg`);
    bit.style.setProperty('--delay', `${(random() * 0.55).toFixed(3)}s`);
    bit.style.setProperty('--fall', `${(1.7 + random() * 1.9).toFixed(2)}s`);
    layer.append(bit);
  }
  return layer;
}

/**
 * Which questions were right, by name.
 *
 * The attempt carries question ids and a fraction awarded; the prompt comes from the
 * steps this session drew. A restored quiz that has not been walked through in this
 * window falls back to the type name rather than showing nothing.
 */
function breakdown(attempt) {
  const rows = attempt?.perQuestion || [];
  if (!rows.length) return null;

  const list = h('ul', { class: 'breakdown' });
  const tally = { correct: 0, partial: 0, wrong: 0, skipped: 0 };
  for (const row of rows) {
    // Skipped is its own outcome. Folding it into "wrong" told someone they had got a
    // question wrong when they never answered it, which is exactly what the skip button
    // is there to avoid. An open question that was never graded arrives as `skipped`; an
    // objective one the learner left blank arrives as `unanswered`.
    const isSkipped = row.skipped === true || row.unanswered === true;
    const kind = row.error
      ? 'error'
      : isSkipped
        ? 'skipped'
        : Number(row.awarded) >= 0.85
          ? 'correct'
          : Number(row.awarded) > 0 ? 'partial' : 'wrong';
    tally[kind] += 1;
    const step = SEEN.get(row.questionId);
    list.append(
      h('li', { class: `breakdown__row breakdown__row--${kind}` },
        mark(kind),
        h('span', { class: 'breakdown__text', text: step ? step.prompt || step.front || step.topicLabel : KIND[row.type] || 'Question' }),
        h('span', { class: 'breakdown__kind', text: KIND[step?.kind || row.type] || 'Question' }),
      ),
    );
  }

  // The denominator stays the whole deck, because every question is worth a mark and a
  // skipped one forfeits it. Only the wording of the outcome changes.
  const counts = [`${tally.correct} of ${rows.length} right`];
  if (tally.partial) counts.push(`${tally.partial} partly right`);
  if (tally.wrong) counts.push(`${tally.wrong} missed`);
  if (tally.skipped) counts.push(`${tally.skipped} skipped`);

  return h('div', { class: 'breakdown-wrap' },
    h('p', { class: 'breakdown__summary', text: counts.join(' · ') }),
    list,
  );
}

/** The kicker above the title: "QUESTION 2 OF 5". */
export function progressLabel({ index, total }) {
  return `QUESTION ${Math.min(index + 1, total)} OF ${total}`;
}
