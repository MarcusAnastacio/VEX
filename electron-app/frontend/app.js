// WIRING — the only file that reads state, calls the API and tells the visual layer what
// to draw.
//
// Layer rules, so a future redesign stays cheap:
//
//   lib/api.js        talks to the backend. Nothing else does.
//   lib/state.js      holds state. Nothing else writes it.
//   lib/quiz-view.js  turns backend shapes into view models. Nothing else reshapes them.
//   components/*      draw view models and report intent through callbacks.
//   app.js            this file: orchestrates the four, and owns no markup.
//
// If you are restyling: work in components/ and styles.css, and expect no changes here.
// If you are adding a backend feature: add it to lib/api.js, then decide which component
// shows it.
//
// ── The view machine ───────────────────────────────────────────────────────
//
// Every selected conversation has three views and one button that moves between them:
//
//   view        body                                       the button says
//   transcript  transcript, topics, saved quizzes           Generate quiz
//   generate    settings, the Gemini payload, busy         View transcript
//   quiz        flashcards then questions, and results     View transcript
//
// The results screen is not a fourth view. It draws inside the quiz view when no step
// is left, because a finished quiz is exactly that: the quiz, with nothing left to ask.
//
// The button is a view switch and nothing else. It never generates, never resumes and
// never replaces anything, so there is no path by which a button labelled "Generate
// quiz" quietly resumes a stored quiz instead.

import { createApi } from './lib/api.js';
import { createStore } from './lib/state.js';
import { hasStoredQuiz, viewSwitchLabel } from './lib/labels.js';
import { toSteps, stepLabel, describeResult, summarize } from './lib/quiz-view.js';
import { renderSidebar, summaryText } from './components/sidebar.js';
import {
  renderTranscript, renderSettings, renderPayload, renderStaleness,
  sessionSubtitle, payloadSubtitle,
} from './components/panel.js';
import { renderStep, renderResults } from './components/quiz.js';

const api = createApi();
const store = createStore();

const el = {
  summary: document.getElementById('summary'),
  list: document.getElementById('list'),
  search: document.getElementById('search'),
  progress: document.getElementById('progress'),
  refresh: document.getElementById('refresh'),
  fixtures: document.getElementById('fixtures'),
  empty: document.getElementById('empty'),
  sessionHead: document.getElementById('session-head'),
  sessionTitle: document.getElementById('session-title'),
  sessionSub: document.getElementById('session-sub'),
  viewSwitch: document.getElementById('view-switch'),
  session: document.getElementById('session'),
  settings: document.getElementById('settings'),
  promptCount: document.getElementById('prompt-count'),
  generateActions: document.getElementById('generate-actions'),
  generate: document.getElementById('generate'),
  generateHint: document.getElementById('generate-hint'),
  showPayload: document.getElementById('show-payload'),
  staleness: document.getElementById('staleness'),
  transcript: document.getElementById('transcript'),
  messages: document.getElementById('messages'),
  quiz: document.getElementById('quiz'),
  quizKicker: document.getElementById('quiz-progress'),
  // No quizTitle. The quiz pane has no heading of its own: the header above names the
  // conversation in every view, and a quiz is titled with its session's title, so the
  // pane's heading could only ever be that same string a second time.
  quizDescription: document.getElementById('quiz-description'),
  quizBody: document.getElementById('quiz-body'),
  payloadView: document.getElementById('payload-view'),
  payloadSub: document.getElementById('payload-sub'),
  payloadJson: document.getElementById('payload-json'),
  closePayload: document.getElementById('close-payload'),
};

/** Steps and the cursor into them live here, not in the store: purely presentational. */
let steps = [];
let stepIndex = 0;
let responses = {};
/** The fetched payload, and whether the generate view is currently showing it. */
let payload = null;
let payloadOpen = false;

// ── Render ─────────────────────────────────────────────────────────────────

function render() {
  const s = store.state;
  // No conversation means no view to be in, so the landing screen is the transcript
  // view with nothing selected rather than a fourth thing to keep in sync.
  const view = s.session ? s.view : 'transcript';
  const stored = hasStoredQuiz({ quiz: s.quiz, button: s.button });

  el.summary.textContent = summaryText({ catalog: s.catalog, capabilities: s.capabilities });
  renderSidebar(el.list, {
    sessions: s.sessions,
    selectedId: s.selectedId,
    filter: s.filter,
    onSelect: selectSession,
  });

  el.empty.hidden = Boolean(s.session);
  el.sessionHead.hidden = !s.session;
  el.session.hidden = !s.session || view === 'quiz';
  el.quiz.hidden = !s.session || view !== 'quiz';

  if (s.session) {
    el.sessionTitle.textContent = s.session.title;
    el.sessionSub.textContent = sessionSubtitle(s.session, { readiness: s.readiness });

    // The one button. Its label says where it goes; its job is only to go there.
    el.viewSwitch.textContent = viewSwitchLabel(view);
    el.viewSwitch.disabled = s.busy;

    el.transcript.hidden = view !== 'transcript';
    el.generateActions.hidden = view !== 'generate';
    // The payload belongs to the generate view, so it is folded away with it rather
    // than raised by a flag of its own.
    el.payloadView.hidden = view !== 'generate' || !payloadOpen;
    if (payloadOpen && payload) {
      el.payloadSub.textContent = payloadSubtitle(payload);
      renderPayload(el.payloadJson, { payload });
    }

    renderTranscript(el.messages, { session: s.session, onTurnClick: () => {} });
    renderSettings(el.settings, {
      // The view is a prop, not a condition app.js applies afterwards: the panel owns
      // what belongs to the generate view, including drawing no settings form at all
      // when the generate view is not on screen.
      view,
      capabilities: s.capabilities,
      options: s.options,
      plan: s.plan,
      readiness: s.readiness,
      busy: s.busy,
      topics: s.topics,
      quizzes: s.quizzes,
      topicSelection: s.topicSelection,
      hasStoredQuiz: stored,
      onChange: updateOptions,
      // The submit button is the one in index.html, so its label and its disabled
      // state cannot drift from the rule that there is exactly one Generate control.
      onGenerate: null,
      onTopicSelectionChange,
      onQuizOpen,
      onQuizResume,
      onTopicReveal,
    });
    renderStaleness(el.staleness, {
      staleness: s.staleness,
      // Errors and warnings ride in the same strip, because a failed generation is
      // exactly as much a result the user needs to see as a stale quiz is.
      notice: s.notice,
      sessionsAvailable: Boolean(s.catalog?.scanned),
      onDismiss: () => store.clearNotice(),
      onExtend: () => generate({ extend: true }),
      onRegenerate: () => generate(),
    });

    // The count is a promise about a deck, so it belongs to the view that asks for one.
    // The redaction notice beside it stays in both views: that line is about the
    // transcript on screen, and the transcript is what gets sent.
    el.promptCount.textContent = view === 'generate' && s.plan?.plan
      ? `${s.plan.expectedQuestions} questions from ${(s.plan.selectedTopics || []).length} topics`
      : '';
    // Never the backend's button label. That string describes what generating would do
    // to a stored quiz, and this button always does exactly one thing.
    el.generate.disabled = s.busy || s.readiness?.ready === false;
    el.generateHint.textContent = stored
      ? 'Replaces the stored quiz, and the answers you have given it.'
      : 'One model call per topic. Usually under a minute.';
  }

  // The quiz view is drawn from here rather than from the action that caused it. It
  // used to be drawn by whoever set the state, which meant any other route into that
  // view (selecting a conversation, going back to it) left the pane showing and the
  // questions blank. One place draws it, so there is no route that misses.
  if (view === 'quiz') renderCurrentStep();

  // An empty progress has to clear the element. The scan failure path has nothing truthful to
  // put here, and without this the footer keeps whatever it last said, so a failed rescan
  // left "Scanning…" on screen forever.
  if (s.busy && s.progress) el.progress.textContent = s.progress;
  else if (!s.busy && s.progress && view !== 'quiz') el.progress.textContent = s.progress;
  else el.progress.textContent = '';
}

// ── Actions ────────────────────────────────────────────────────────────────

/** The only way the view changes. Nothing here generates. */
function setView(next) {
  store.set({ view: next });
}

async function rescan(options) {
  store.set({ busy: true, progress: 'Scanning…' });
  try {
    const catalog = await api.refresh(options);
    const sessions = (catalog.groups || []).flatMap((group) =>
      group.sessions.map((session) => ({ ...session, harnessName: group.name })));
    store.set({
      catalog,
      sessions,
      busy: false,
      progress: `${sessions.length} conversations`,
      capabilities: await api.capabilities(),
      storeInfo: await api.storeInfo(),
    });
  } catch (err) {
    store.set({
      busy: false,
      progress: '',
      notice: { level: 'error', text: String(err?.message || err) },
    });
  }
}

async function selectSession(id) {
  try {
    const session = await api.session(id);
    if (!session) return;
    // Cleared, not left over: a conversation with nothing stored must not inherit the
    // previous one's topics, saved quizzes, payload or step cursor.
    resetQuiz();
    payload = null;
    payloadOpen = false;
    store.set({
      selectedId: id,
      session,
      view: 'transcript',
      readiness: null,
      plan: null,
      staleness: null,
      button: null,
      topics: [],
      quizzes: [],
      topicSelection: [],
    });
    render();

    // Readiness, the plan, the topics and the saved quizzes are all cheap and offline,
    // so the transcript view can tell the user what is possible, and what already
    // exists, before they spend anything.
    const [readiness, plan, staleness, button, topics, quizzes] = await Promise.all([
      api.readiness({ id, ...store.state.options }),
      api.planQuiz({ id, ...planningArgs() }),
      api.staleness({ id, ...store.state.options }),
      api.quizButton({ id, ...store.state.options }),
      api.topics({ id }),
      api.quizzes({ sessionId: id }),
    ]);
    // Two clicks in quick succession means two sets of answers in flight, and the
    // slower one must not land on top of the conversation the user is now looking at.
    if (store.state.selectedId !== id) return;
    store.set({
      readiness,
      plan,
      staleness,
      button,
      topics: topics?.topics || [],
      quizzes: quizzes || [],
    });

    // The newest stored quiz is loaded with its saved position now, not when it is
    // opened. That is what makes opening a saved quiz a view switch rather than a
    // fetch, and it is why a conversation you were partway through comes back partway
    // through instead of at the top.
    await loadNewestStored();
    if (store.state.selectedId !== id) return;
    render();
  } catch (err) {
    store.set({ notice: { level: 'error', text: String(err?.message || err) } });
  }
}

function resetQuiz() {
  steps = [];
  stepIndex = 0;
  responses = {};
}

/** The score from a completed run, or null when there is nothing finished to show. */
function scoreOf(progress) {
  if (!progress?.completed) return null;
  return { score: progress.score, maxScore: progress.maxScore, percentage: progress.percentage };
}

/**
 * Point the step cursor at a stored quiz.
 *
 * A position is only rebuilt when the backend says there is one to resume. Rebuilding
 * the per-step results from what was stored matters for a resumed open question: it
 * shows its verdict instead of asking the model the same thing twice.
 */
function positionFrom(quiz, progress, { fromStart = false } = {}) {
  steps = toSteps(quiz);
  responses = {};
  if (fromStart || !progress?.resumable) {
    stepIndex = 0;
    return;
  }
  for (const [questionId, raw] of Object.entries(progress.results || {})) {
    const step = steps.find((candidate) => candidate.id === questionId);
    if (step) responses[questionId] = { result: describeResult(step, raw) };
  }
  for (const [questionId, answer] of Object.entries(progress.answers || {})) {
    responses[questionId] = { ...(responses[questionId] || {}), answer };
  }
  stepIndex = Math.min(progress.stepIndex ?? 0, Math.max(0, steps.length - 1));
}

/**
 * Load the newest stored quiz for the selected conversation, with the user's position.
 *
 * A conversation with nothing stored lands on an empty step list, which is the same
 * thing as having never opened a quiz: no "ready" wording, no step, and the transcript
 * view is where the user is left.
 */
async function loadNewestStored() {
  const stored = await api.quizForSession({ id: store.state.selectedId });
  if (!stored) {
    resetQuiz();
    store.set({ quiz: null, attempt: null, band: null, lastScore: null });
    return null;
  }
  const progress = await api.progress({ quizId: stored.id });
  positionFrom(stored, progress);
  store.set({ quiz: stored, attempt: null, band: null, lastScore: scoreOf(progress) });
  return stored;
}

/** One named quiz from the saved list, which need not be the newest one. */
async function loadStored(quizId, { fromStart = false } = {}) {
  const stored = await api.quiz({ quizId });
  if (!stored) return null;
  const progress = await api.progress({ quizId: stored.id });
  positionFrom(stored, progress, { fromStart });
  store.set({ quiz: stored, attempt: null, band: null, lastScore: scoreOf(progress) });
  return stored;
}

/**
 * Re-read what the conversation has now, after a run changed it.
 *
 * All three are read at selection time and a run makes all three wrong: a quiz that was
 * "not started" a minute ago is finished with a score, and the staleness answer and the
 * button action were computed while no quiz existed at all. Without this the panel
 * describes a run the user has just finished as one they have not begun, and a stored
 * quiz as one that is not there.
 */
async function refreshAfterRun() {
  const s = store.state;
  if (!s.selectedId) return;
  try {
    const [quizzes, staleness, button] = await Promise.all([
      api.quizzes({ sessionId: s.selectedId }),
      api.staleness({ id: s.selectedId, ...s.options }),
      api.quizButton({ id: s.selectedId, ...s.options }),
    ]);
    store.set({ quizzes: quizzes || [], staleness, button });
  } catch (err) {
    store.set({ notice: { level: 'warn', text: String(err?.message || err) } });
  }
}

/**
 * Open a stored quiz in the quiz view.
 *
 * `fromStart` is the difference between the two panel actions: opening a quiz begins
 * it again, resuming it lands on the step the user left. Both go through here so the
 * view change and the step cursor can never disagree.
 */
async function openQuiz(quizId, { fromStart = false } = {}) {
  const s = store.state;
  const id = quizId || s.quiz?.id;
  if (!id) return;
  try {
    if (id !== s.quiz?.id) await loadStored(id, { fromStart });
    else if (fromStart) {
      stepIndex = 0;
      responses = {};
    }
    setView('quiz');
  } catch (err) {
    store.set({ notice: { level: 'error', text: String(err?.message || err) } });
  }
}

const onQuizOpen = (quizId) => openQuiz(quizId);
const onQuizResume = (quizId) => openQuiz(quizId);

function onTopicSelectionChange(topicIds) {
  const next = [...new Set(topicIds || [])];
  store.set({ topicSelection: next });
  if (!store.state.selectedId) return;
  // Re-plan against the chosen topics. Only the plan: the stored quiz's freshness is a
  // property of the conversation and the settings, not of which topics are ticked.
  api.planQuiz({ id: store.state.selectedId, ...planningArgs() })
    .then((plan) => store.set({ plan }))
    .catch((err) => store.set({ notice: { level: 'warn', text: String(err?.message || err) } }));
}

/**
 * The option object for a plan or a generation, carrying the topic selection.
 *
 * Everything in `options` comes along: questionCount, types, focus and
 * flashcardsPerTopic. There is no default invented here, because the backend has one
 * (clampFlashcardsPerTopic) and a second one in the frontend would be a third number to
 * keep in step. An absent key is simply absent on the wire.
 *
 * An empty topic list is the automatic selection, and it says so: the backend reads an
 * absent `topicIds` and an empty one the same way, so nothing is substituted for it.
 * `topicIds` is deliberately not sent to staleness or quizButton: those compare the
 * settings a stored quiz was built with, and which topics happen to be ticked is not a
 * setting.
 */
function planningArgs() {
  return { ...store.state.options, topicIds: [...store.state.topicSelection] };
}

async function updateOptions(options) {
  store.set({ options });
  if (!store.state.selectedId) return;
  // Every key in `options` goes to every call, rather than the two the panel used to
  // send. A new control that writes into the options object is then forwarded without
  // this file having to learn its name: questionCount, types, focus and
  // flashcardsPerTopic all reach the same place, and an absent one is the backend's
  // default rather than a guess made here.
  const [readiness, plan, staleness] = await Promise.all([
    api.readiness({ id: store.state.selectedId, ...options }),
    api.planQuiz({ id: store.state.selectedId, ...planningArgs() }),
    api.staleness({ id: store.state.selectedId, ...options }),
  ]);
  store.set({ readiness, plan, staleness });
}

async function generate({ extend = false } = {}) {
  const s = store.state;
  if (!s.selectedId) return;

  // Generating replaces the stored quiz, and with it any answers given against those
  // questions. Ask first, because losing a part finished attempt silently is the worst
  // possible outcome of clicking a button in the generate view.
  if (!extend && hasStoredQuiz({ quiz: s.quiz, button: s.button })) {
    const proceed = window.confirm(
      `${s.button?.reason ? `${s.button.reason}\n\n` : ''}Generating a new quiz will replace it and you will start from the first question.`,
    );
    if (!proceed) return;
  }

  store.set({
    busy: true,
    view: 'generate',
    progress: extend ? 'Adding questions for the new turns' : 'Reading the transcript and generating questions',
  });

  try {
    const result = extend
      ? await api.extendQuiz({ id: s.selectedId, ...planningArgs() })
      : await api.generateAndSave({ id: s.selectedId, ...planningArgs() });

    // A failure has to say so on screen. The old path returned quietly here, and the
    // one symptom anyone could see was that the quiz that was promised never arrived.
    if (!result || result.ok === false) {
      return store.set({
        busy: false,
        progress: '',
        notice: {
          level: 'warn',
          text: result?.message
            || (result?.reason ? `Could not generate a quiz: ${result.reason}.` : 'Could not generate a quiz.'),
        },
      });
    }

    const generated = result.quiz || result;
    // `stored` is the save receipt, not part of the quiz. Attaching it is what lets the
    // score, the resume and the retake find this quiz afterwards: leaving it off gave
    // every saveProgress, finish and restart call an undefined id, so a finished quiz
    // forgot it had been taken.
    const receipt = result.stored || (result.quizId ? { id: result.quizId } : null);
    const replaced = receipt?.replacedProgress;
    positionFrom(generated, null);
    store.set({
      busy: false,
      progress: '',
      quiz: { ...generated, stored: receipt },
      view: 'quiz',
      attempt: null,
      band: null,
      lastScore: null,
      notice: replaced
        ? { level: 'warn', text: `Replaced a part finished quiz, ${replaced.answered} answered.` }
        : null,
    });
    refreshAfterRun();
  } catch (err) {
    store.set({ busy: false, progress: '', notice: { level: 'error', text: String(err?.message || err) } });
  }
}

async function finishQuiz() {
  const s = store.state;
  const summary = summarize(s.attempt, { band: null });
  const quizId = s.quiz?.stored?.id || s.quiz?.id;
  const band = await api.band({ percentage: summary.percentage });
  if (quizId) {
    try {
      // Keeps the score and clears the position, so the next visit starts fresh.
      await api.finish({ quizId, score: summary.score, maxScore: summary.total });
      refreshAfterRun();
    } catch (err) {
      store.set({ notice: { level: 'warn', text: `Could not save your score: ${String(err?.message || err)}` } });
    }
  }
  store.set({ band, lastScore: { score: summary.score, maxScore: summary.total, percentage: summary.percentage } });
  // The store change above already redrew the results screen. This is here because a
  // store.set that changes nothing emits nothing, and the screen must not depend on
  // which branch that was.
  renderCurrentStep();
}

/** The whole-quiz retry, unchanged: it clears the stored position and starts over. */
async function retake() {
  const s = store.state;
  const quizId = s.quiz?.stored?.id || s.quiz?.id;
  if (quizId) await api.restart({ quizId }).catch(() => {});
  stepIndex = 0;
  responses = {};
  store.set({ attempt: null, band: null });
}

function renderCurrentStep() {
  const s = store.state;
  if (s.view !== 'quiz') return;
  const step = steps[stepIndex];

  if (!step) {
    const summary = summarize(s.attempt, { band: s.band });
    el.quizKicker.textContent = 'QUIZ COMPLETE';
    // Nothing to title: the pane has no heading, and the header above is still naming
    // the conversation this quiz was built from.
    el.quizDescription.textContent = '';
    renderResults(el.quizBody, {
      summary,
      attempt: s.attempt,
      onBack: () => setView('transcript'),
      onRetry: retake,
    });
    return;
  }

  // Each number counted within its own phase. The deck is flashcards then questions, so
  // a global stepIndex put the last card at "FLASHCARD 5 OF 9" and the first question
  // at "QUESTION 1 OF 9", both of which are true of neither phase.
  el.quizKicker.textContent = stepLabel(step, steps);
  // The one thing the header above cannot say about this step: which topic it came
  // from. There is no title line here, because it only ever repeated the header.
  el.quizDescription.textContent = step.topicLabel || '';

  const advance = () => {
    stepIndex += 1;
    if (stepIndex >= steps.length) finishQuiz();
    else renderCurrentStep();
  };

  renderStep(el.quizBody, {
    step,
    result: responses[step.id]?.result || null,
    isLast: stepIndex === steps.length - 1,
    onNext: advance,
    // Records nothing at all: no response, no grading call, no saved position. A step
    // with no answer is left out of the denominator when the run is scored, which is
    // what skipping means, and the cursor still has to move or "next" would walk back
    // over the same card. The panel draws this strip only because both of these exist.
    onSkip: advance,
    // The verdict came out of the same entry as the answer, so clearing the entry
    // clears both. The panel offers it only once a result exists, so there is never an
    // unanswered-looking question sitting behind a stored verdict.
    onRetryStep: () => {
      delete responses[step.id];
      renderCurrentStep();
    },
    onRespond: (answer) => respond(step, answer),
  });
}

async function respond(step, answer) {
  responses[step.id] = { answer };
  const s = store.state;

  // Objective questions are graded by the backend with no request; open ones cost one
  // call. Either way the grading lives in one place, not in the UI.
  try {
    const result = await api.grade({ quizId: s.quiz?.stored?.id || null, answers: allAnswers(), quiz: s.quiz });
    const forThisStep = result?.perQuestion?.find((r) => r.questionId === step.id);
    responses[step.id] = { answer, result: forThisStep ? describeResult(step, forThisStep) : null, raw: forThisStep };
    if (stepIndex === steps.length - 1) store.set({ attempt: result });
    else store.set({});
    await persistProgress();
  } catch (err) {
    responses[step.id] = { answer, result: { status: 'error', headline: 'Could not be graded', detail: String(err?.message || err) } };
  }
  renderCurrentStep();
}

/** The raw results, keyed by question id, for the store. */
function rawResults() {
  const out = {};
  for (const [id, entry] of Object.entries(responses)) {
    if (entry?.raw) out[id] = entry.raw;
  }
  return out;
}

/**
 * Save the position. Called after every answer so switching conversations, or quitting,
 * costs nothing. Only the last completed step is stored, which is the one to resume on.
 */
async function persistProgress() {
  const s = store.state;
  const quizId = s.quiz?.stored?.id || s.quiz?.id;
  if (!quizId) return;
  try {
    await api.saveProgress({ quizId, stepIndex, answers: allAnswers(), results: rawResults() });
  } catch (err) {
    store.set({ notice: { level: 'warn', text: `Could not save your place: ${String(err?.message || err)}` } });
  }
}

function allAnswers() {
  const out = {};
  for (const [id, entry] of Object.entries(responses)) {
    if (entry?.answer !== undefined) out[id] = entry.answer;
  }
  return out;
}

async function showPayload() {
  if (!store.state.selectedId) return;
  payload = await api.payload({ id: store.state.selectedId, maxChars: 24000 });
  payloadOpen = true;
  render();
}

// ── The transcript ─────────────────────────────────────────────────────────

/**
 * The block for one message, whether or not it carries an index attribute.
 *
 * The transcript is drawn from the message array in order, so position is the fallback
 * and the attribute is preferred because it survives a block that is added or skipped.
 */
function messageNode(index) {
  const nodes = [...el.transcript.querySelectorAll('.msg')];
  return nodes.find((node) => node.dataset.messageIndex === String(index)) || nodes[index] || null;
}

/**
 * Scroll the transcript to a topic, because app.js owns the transcript DOM.
 *
 * The topic's own `messageRanges` say which messages it covers, so there is no second
 * map of positions to keep in step with the backend's segmentation.
 */
function onTopicReveal(topicId) {
  const topic = (store.state.topics || []).find((candidate) => candidate.id === topicId);
  if (!topic) return;
  const index = topic.messageRanges?.[0]?.[0] ?? topic.from ?? 0;

  // The transcript is not on screen in the other views, so revealing a topic means
  // going to the transcript view first.
  if (store.state.view !== 'transcript') setView('transcript');

  let node = messageNode(index);
  if (!node) {
    // A collapsed transcript has no message blocks to scroll to. Opening it is the
    // panel's own toggle, so the per-conversation open state stays where it is kept.
    const collapsed = el.transcript.querySelector('.transcript__toggle[aria-expanded="false"]');
    if (collapsed) {
      collapsed.click();
      node = messageNode(index);
    }
  }
  node?.scrollIntoView({ block: 'center' });
}

// ── Events ─────────────────────────────────────────────────────────────────

el.refresh.addEventListener('click', () => rescan());
el.fixtures.addEventListener('click', () => rescan({ fixtures: true }));
// The one button beside the title. A view switch, and only a view switch.
el.viewSwitch.addEventListener('click', () => {
  setView(store.state.view === 'transcript' ? 'generate' : 'transcript');
});
el.generate.addEventListener('click', () => generate());
el.showPayload.addEventListener('click', showPayload);
el.closePayload.addEventListener('click', () => {
  payloadOpen = false;
  render();
});
el.search.addEventListener('input', (e) => { store.set({ filter: e.target.value }); render(); });

store.subscribe(render);

// ── Boot ───────────────────────────────────────────────────────────────────

if (!api.available()) {
  el.summary.textContent = 'Backend bridge missing.';
  el.list.replaceChildren(Object.assign(document.createElement('div'), {
    className: 'placeholder',
    text: 'window.compat is missing. Run this through Electron, not a browser.',
  }));
} else {
  api.onProgress((evt) => {
    if (evt.phase === 'harness-done' && evt.sessions > 0) store.set({ progress: `${evt.name}: ${evt.sessions}` });
  });
  api.onQuizProgress((evt) => {
    if (evt.phase === 'topic-start') store.set({ progress: `Generating ${evt.label || evt.topicId}` });
    if (evt.phase === 'topic-done') store.set({ progress: `${evt.topicId}: ${evt.flashcards} cards, ${evt.questions} questions` });
    if (evt.phase === 'topic-failed') store.set({ progress: `${evt.topicId} failed: ${evt.error}` });
  });
  api.onReady(() => api.list().then((catalog) => {
    if (catalog?.scanned && !store.state.catalog) {
      const sessions = (catalog.groups || []).flatMap((g) => g.sessions.map((s) => ({ ...s, harnessName: g.name })));
      store.set({ catalog, sessions });
    }
  }));
  rescan();
  api.capabilities().then((capabilities) => store.set({ capabilities })).catch(() => {});
}
