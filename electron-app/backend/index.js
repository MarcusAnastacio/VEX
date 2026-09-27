// Public API of the compatibility layer.
//
// Electron main process usage:
//
//   import { CompatibilityLayer } from './backend/index.js'
//   const layer = new CompatibilityLayer()
//   layer.on('progress', e => win.webContents.send('scan:progress', e))
//   const catalog = await layer.refresh()
//   const session = layer.getSession(id)
//   const payload = layer.quizPayload(id)   // -> hand to Gemini
//
// The layer owns no UI and no Gemini calls: it only answers "what conversations
// exist on this machine, and what is in them".

import { EventEmitter } from 'node:events';
import { scanAll, discoverStores, findSession, toQuizPayload, isQuizReady, loadRegistry, QUIZ_MIN_CHARS, QUIZ_MIN_USER_TURNS } from './detect.js';
import { redactPayload } from './lib/redact.js';
import { buildDigest } from './lib/digest.js';
import { deriveTopics, topicSlice, topicSlices } from './lib/topics.js';
import {
  generateQuiz, planQuiz, quizSchema, quizCapabilities, assessReadiness,
  quizButtonState, scoreBand, QUESTION_TYPES,
} from './lib/quiz.js';
import { hasApiKey, listModels } from './lib/gemini.js';
import { QuizStore, sqliteAvailable, defaultStorePath, GENERATOR_VERSION } from './lib/store.js';
import { gradeAttempt, gradeOpen, gradeObjective, normalizeAnswer } from './lib/grade.js';
// Needed in module scope for the catalog's platform block, not only re-exported below.
import { PLATFORM, PLATFORM_NAME, platformRoots } from './lib/expand.js';

export class CompatibilityLayer extends EventEmitter {
  constructor(options = {}) {
    super();
    this.options = options;
    /** @type {Awaited<ReturnType<typeof scanAll>>|null} */
    this.catalog = null;
    this.scanning = null;
    /** Lazily opened, so a read-only session never creates a database. */
    this.store = null;
    this.storeFile = options.storeFile;
  }

  /**
   * The quiz database. Opened on first use, so browsing history never touches the disk.
   * Pass `{ storeFile: ':memory:' }` for tests.
   */
  getStore() {
    if (!this.store) this.store = new QuizStore(this.storeFile || defaultStorePath());
    return this.store;
  }

  get storeInfo() {
    return {
      available: sqliteAvailable(),
      path: this.store ? this.store.file : this.storeFile || defaultStorePath(),
      generatorVersion: GENERATOR_VERSION,
    };
  }

  /**
   * Generate and save in one step.
   *
   * With `fromMessage` set, only topics at or after that point are considered, which is
   * how an appended conversation extends an existing quiz instead of regenerating it.
   */
  async generateAndSaveQuiz(id, opts) {
    const session = this.getSession(id);
    if (!session) return null;
    const quiz = await this.generateQuiz(id, opts);
    if (!quiz || !quiz.ok) return quiz;
    try {
      const saved = this.getStore().saveQuiz(quiz, session, {
        // The settings that were ASKED for, with the ones the generator actually
        // resolved filled in.
        //
        // This matters more than it looks. `settingsKey` folds flashcardsPerTopic in,
        // so persisting what the caller sent rather than what was used means that
        // generating with the default and generating with an explicit `2` produce
        // two different settings keys and therefore two different quiz ids for the
        // same deck. Taking the effective values makes the id a function of the quiz
        // that was built, which is the only thing the id is for.
        settings: {
          ...opts,
          types: quiz.settings?.types ?? opts.types,
          flashcardsPerTopic: quiz.settings?.flashcardsPerTopic ?? opts.flashcardsPerTopic,
          questionCount: quiz.settings?.questionCount ?? opts.questionCount,
        },
        redaction: quiz.redaction,
        // Generated to replace: anything answered belongs to the previous questions.
        preserveProgress: false,
      });
      return { ...quiz, stored: saved };
    } catch (err) {
      // A storage failure must not lose a quiz that was successfully generated.
      return { ...quiz, stored: null, storeError: String(err?.message || err) };
    }
  }

  /** One stored quiz, with its questions and flashcards. */
  getQuiz(quizId) {
    return this.getStore().getQuiz(quizId);
  }

  /** Newest quiz for a conversation, or null. */
  getQuizForSession(id) {
    return this.getStore().getQuizForSession(id);
  }

  /** Stored quizzes, newest first. Rows are summaries, not full question lists. */
  listQuizzes(opts) {
    return this.getStore().list(opts);
  }

  /**
   * Is a stored quiz still valid, was the conversation appended to, or did the messages
   * it was built from change?
   */
  quizStaleness(id, opts) {
    const session = this.getSession(id);
    if (!session) return null;
    return this.getStore().staleness(session, opts);
  }

  /**
   * Where the user got to in a quiz, and the score from their last completed run.
   * `resumable` says whether there is a position to restore.
   */
  quizProgress(quizId) {
    return this.getStore().getProgress(quizId);
  }

  /** Record the position after each answer, so navigating away is safe. */
  saveQuizProgress(quizId, position) {
    return this.getStore().saveProgress(quizId, position);
  }

  /** Record a completed run: keeps the score, resets the position. */
  finishQuiz(quizId, result) {
    return this.getStore().finishAttempt(quizId, result);
  }

  /** Retake: forget the position, keep the previous score until it is replaced. */
  restartQuiz(quizId) {
    return this.getStore().clearProgress(quizId);
  }

  /** The quartile band and its copy for a percentage. */
  scoreBand(percentage) {
    return scoreBand(percentage);
  }

  /**
   * The label and action for the one button in the top right.
   *
   * Reads the stored position as well as staleness, so a quiz that is part finished
   * offers to resume rather than to start over.
   */
  quizButton(id, opts) {
    const staleness = this.quizStaleness(id, opts);
    if (!staleness) return null;
    const quiz = this.getStore().getQuizForSession(this.getSession(id)?.id || id);
    const progress = quiz ? this.quizProgress(quiz.id) : null;
    return quizButtonState(staleness, progress);
  }

  /** Generate only about turns added since the stored quiz, then merge into it. */
  async extendQuiz(id, opts = {}) {
    const session = this.getSession(id);
    if (!session) return null;
    const staleness = this.getStore().staleness(session, opts);
    if (staleness.state !== 'extended') return { ok: false, reason: staleness.state, staleness };

    const fresh = await this.generateQuiz(id, { ...opts, fromMessage: staleness.fromMessage });
    if (!fresh?.ok) return { ...fresh, staleness };

    const previous = this.getStore().getQuiz(staleness.quizId);
    const merged = {
      ...previous,
      questions: [...previous.questions, ...fresh.questions],
      flashcards: [...previous.flashcards, ...fresh.flashcards],
      topicsUsed: [...previous.topicsUsed, ...(fresh.topicsUsed || [])],
      model: fresh.model,
      settings: { ...previous.settings, ...fresh.settings, producedQuestions: previous.questions.length + fresh.questions.length },
    };
    // Extending keeps the existing questions and adds to them, so the stored answers still
    // refer to the same questions and the position survives.
    const saved = this.getStore().saveQuiz(merged, session, {
      settings: merged.settings,
      preserveProgress: true,
    });
    return { ok: true, added: { questions: fresh.questions.length, flashcards: fresh.flashcards.length }, quizId: saved.id, staleness, quiz: merged };
  }

  /** Grade an attempt, either against a stored quiz or a quiz object. */
  async gradeQuiz(quizOrId, answers, opts) {
    const quiz = typeof quizOrId === 'string' ? this.getStore().getQuiz(quizOrId) : quizOrId;
    if (!quiz) return null;
    const result = await gradeAttempt(quiz, answers, opts);
    if (opts?.save && typeof quizOrId === 'string') {
      // One end score per quiz: finishAttempt keeps the score and resets the position,
      // overwriting the row from a previous run rather than appending another.
      const finished = this.getStore().finishAttempt(quizOrId, {
        score: result.score,
        maxScore: result.maxScore,
      });
      result.attemptId = finished.id;
    }
    return result;
  }

  /** Grade a single open answer without an attempt around it. */
  async gradeOne(question, answer, opts) {
    if (question?.type === 'open') return gradeOpen(question, answer, opts);
    return gradeObjective(question, answer);
  }

  /** The answer to "delete everything you have stored about me". */
  clearStoredQuizzes() {
    return this.getStore().clear();
  }

  /** Every harness we know how to look for, detected or not. */
  registry() {
    return loadRegistry();
  }

  /** Fast: which stores exist. No parsing. */
  discover() {
    return discoverStores({ projectRoot: this.options.projectRoot });
  }

  /**
   * Full scan. Concurrent calls share one in-flight scan.
   * @returns {Promise<object>} the catalog
   */
  async refresh(options = {}) {
    if (this.scanning) return this.scanning;
    this.scanning = scanAll({
      projectRoot: this.options.projectRoot,
      ...options,
      onProgress: (evt) => {
        this.emit('progress', evt);
        options.onProgress?.(evt);
      },
    })
      .then((catalog) => {
        this.catalog = catalog;
        this.emit('ready', catalog);
        return catalog;
      })
      .finally(() => {
        this.scanning = null;
      });
    return this.scanning;
  }

  /** Sidebar data: harnesses that actually have history, with their sessions. */
  list({ quizReadyOnly = false, harness } = {}) {
    if (!this.catalog) return { scanned: false, groups: [], totalSessions: 0 };
    let sessions = this.catalog.sessions;
    if (harness) sessions = sessions.filter((s) => s.harness === harness);
    if (quizReadyOnly) sessions = sessions.filter(isQuizReady);

    const byHarness = new Map();
    for (const s of sessions) {
      if (!byHarness.has(s.harness)) {
        byHarness.set(s.harness, {
          harness: s.harness,
          name: s.harnessName,
          sessions: [],
        });
      }
      byHarness.get(s.harness).sessions.push({
        id: s.id,
        nativeId: s.nativeId,
        title: s.title,
        project: s.project,
        // Carried into the sidebar summary because the label derived from the store path is
        // often junk: a flat fixture directory yields "claude-code/session.jsonl", where the
        // transcript's own cwd gives "checkout-api". Only the full session had this before.
        cwd: s.cwd,
        updated: s.updated,
        started: s.started,
        messageCount: s.messages.length,
        userTurns: s.userTurns,
        chars: s.chars,
        quizReady: isQuizReady(s),
        partial: s.partial || false,
        source: s.source,
        // Sidebar grouping. `isSubagent` and `parentSessionId` come from the reader,
        // which only sets them from a proven signal (see lib/grouping.js), so a
        // session that might be a subagent arrives here as false rather than absent:
        // the UI can hide the subagent ones without ever hiding one on a guess.
        isSubagent: s.isSubagent === true,
        parentSessionId: s.parentSessionId ?? null,
        // The parent in normalized id space, so the sidebar can join it against a
        // catalog row by equality instead of rebuilding the `<harness>:` prefix.
        parentId: s.parentId ?? null,
        groupKey: s.groupKey,
      });
    }

    return {
      scanned: true,
      scannedAt: this.catalog.scannedAt,
      /** Which OS the scan ran on and the roots it resolved, for the UI to display. */
      platform: { id: PLATFORM, name: PLATFORM_NAME, roots: platformRoots() },
      sqlite: this.catalog.sqlite,
      detectedHarnesses: this.catalog.detectedHarnesses,
      totalHarnesses: this.catalog.totalHarnesses,
      totalSessions: sessions.length,
      quizReady: sessions.filter(isQuizReady).length,
      groups: [...byHarness.values()].sort((a, b) => b.sessions.length - a.sessions.length),
      // Harnesses we looked for but found nothing for — useful for "why isn't my
      // tool here?" and for the presentation slide on coverage.
      absent: this.catalog.harnesses.filter((h) => !h.detected).map((h) => ({ id: h.id, name: h.name })),
    };
  }

  getSession(id) {
    return this.catalog ? findSession(this.catalog, id) : null;
  }

  /**
   * The exact object to hand to Gemini: the conversation trimmed to a budget AND
   * secrets removed. This is the single point where a transcript leaves the
   * machine, which is why redaction lives here and not in the caller.
   *
   * @returns {{payload: object, redaction: object}|null}
   */
  quizPayload(id, opts) {
    const session = this.getSession(id);
    if (!session) return null;
    const raw = toQuizPayload(session, opts);
    const { payload, report } = redactPayload(raw, { entropy: opts?.entropy === true });
    return { payload, redaction: report };
  }

  /**
   * The bounded, ordered digest of one conversation plus the project context it
   * touched. This is the input the topic segmentation and question generation
   * stages will consume — see docs/quiz-design.md §2.
   */
  digest(id, opts) {
    const session = this.getSession(id);
    if (!session) return null;
    return buildDigest(session, opts);
  }

  /**
   * Deterministic topic segmentation of one conversation. No model call: cuts come
   * from file-set changes, lexical overlap, pauses and transition markers, and each
   * topic is labelled with its opening user turn.
   */
  topics(id, opts) {
    const session = this.getSession(id);
    if (!session) return null;
    return deriveTopics(session, opts);
  }

  /** One bounded prompt body for a topic — Stage C's input. */
  topicSlice(id, topicId, opts) {
    const session = this.getSession(id);
    if (!session) return null;
    const { topics } = deriveTopics(session, opts);
    const topic = topics.find((t) => t.id === topicId) || topics[Number(topicId) - 1];
    if (!topic) return null;
    return topicSlice(session, topic, opts);
  }

  /** Every topic slice, each capped. The complete bounded input set for generation. */
  topicSlices(id, opts) {
    const session = this.getSession(id);
    if (!session) return null;
    return topicSlices(session, opts);
  }

  /**
   * What would be generated, without calling the model: which topics, how many
   * flashcards, and one question per (topic, enabled type).
   */
  planQuiz(id, opts) {
    const session = this.getSession(id);
    if (!session) return null;
    return planQuiz(session, opts);
  }

  /**
   * Generate flashcards and quiz questions for one conversation.
   *
   * One Gemini call per selected topic, in parallel, each bounded by
   * `maxCharsPerTopic`. Flashcards are always produced; questions only for the
   * enabled types.
   */
  async generateQuiz(id, opts) {
    const session = this.getSession(id);
    if (!session) return null;
    return generateQuiz(session, opts);
  }

  /**
   * Whether this conversation can support a quiz, with the reasons when it cannot.
   * Cheap and offline, so the UI can call it while rendering the sidebar.
   */
  assessReadiness(id, opts) {
    const session = this.getSession(id);
    if (!session) return null;
    return assessReadiness(session, opts);
  }

  /** Option bounds, type labels and key state, so the UI hardcodes none of it. */
  quizCapabilities() {
    return quizCapabilities();
  }

  /** Whether a Gemini key is available, without revealing it. */
  hasApiKey(explicit) {
    return hasApiKey(explicit);
  }

  /** Which models this key can actually reach. */
  listModels(opts) {
    return listModels(opts);
  }

  /** Redaction only, for inspecting what would be stripped. */
  redactionReport(id, opts) {
    const result = this.quizPayload(id, opts);
    return result ? result.redaction : null;
  }

  /**
   * NOTE: the frontend branch had a second `generateQuiz({ id, prompt })` here that
   * called lib/quiz.js with a *payload* rather than a session. Being later in the class
   * body it silently overrode the real one, and generation then failed on a missing
   * `messages` array. Removed — `generateQuiz(id, options)` below is the implementation,
   * and a free-text "focus" hint would need a parameter on that one, not a second method.
   */

  /**
   * Lightweight candidate list for the "pick a conversation to be quizzed on"
   * step: no message bodies, so it is safe to send to the renderer whole.
   */
  search(query = '') {
    const q = query.trim().toLowerCase();
    const { groups } = this.list();
    const flat = groups.flatMap((g) => g.sessions.map((s) => ({ ...s, harnessName: g.name })));
    if (!q) return flat;
    return flat.filter((s) =>
      [s.title, s.project, s.harnessName].join(' ').toLowerCase().includes(q),
    );
  }
}

export {
  scanAll,
  discoverStores,
  findSession,
  toQuizPayload,
  isQuizReady,
  loadRegistry,
  QUIZ_MIN_CHARS,
  QUIZ_MIN_USER_TURNS,
};
export { expandStorePath, globStorePaths, PLATFORM, PLATFORM_NAME, platformRoots } from './lib/expand.js';
export { readStoreFile } from './readers/index.js';
export { sqliteAvailable } from './readers/sqlite.js';
export { redact, redactPayload, patternKinds } from './lib/redact.js';
export { buildDigest, digestFits, extractTouched, renderTurnRange } from './lib/digest.js';
export { deriveTopics, topicSlice, topicSlices } from './lib/topics.js';
export { generateQuiz, planQuiz, quizSchema, validateResult, quizCapabilities, assessReadiness, quizButtonState, scoreBand, QUESTION_TYPES, READINESS, FLASHCARDS_PER_TOPIC, clampFlashcardsPerTopic, DEFAULTS as QUIZ_DEFAULTS } from './lib/quiz.js';
export { mockEnabled, mockTopicResponse, MOCK_ENV, MOCK_MODEL } from './lib/mock.js';
export { sessionParentId, groupKeyFor, isSubagentName, subagentParentFromPath, SESSION_PARENT_FIELDS, SESSION_ID_FIELDS } from './lib/grouping.js';
export { generateJson, listModels, hasApiKey, resolveApiKey, GeminiError, DEFAULT_MODEL_CHAIN } from './lib/gemini.js';
export { QuizStore, QuizStoreError, sqliteAvailable as storeAvailable, defaultStorePath, fingerprintSession, settingsKey, quizIdFor, GENERATOR_VERSION } from './lib/store.js';
export { gradeAttempt, gradeOpen, gradeObjective, gradeMcq, gradeCloze, gradeSchema, normalizeAnswer } from './lib/grade.js';
export {
  renderTree, collectDocs, collectManifests, commitsInWindow, workingTreeState,
} from './lib/project.js';
