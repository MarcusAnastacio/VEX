// FUNCTIONAL LAYER — application state.
//
// Deliberately tiny: a plain object, a subscribe list, and named setters. No framework,
// no reactivity magic, no DOM. The visual layer reads from it and renders; only app.js
// writes to it.

const initial = {
  /** The newest scan result: { groups, platform, storeInfo, ... } */
  catalog: null,
  /** Session summaries, flattened, for the sidebar. */
  sessions: [],
  /** Sidebar filter text. */
  filter: '',
  /** The selected session id, or null. */
  selectedId: null,
  /** The selected session with its messages. */
  session: null,
  /** { questionCount, types } — the settings the next generation will use. */
  options: { questionCount: 6, types: ['mcq', 'cloze', 'open'] },
  /** Bounds and labels from the backend, so nothing is hardcoded here either. */
  capabilities: null,
  /** What the backend says about the selected conversation. */
  readiness: null,
  /** The plan for the selected conversation: topics, expected counts. */
  plan: null,
  /** The conversation segmented into topics: { topics, boundaries, stats }. */
  topics: [],
  /** Summaries of the quizzes already stored for this conversation, newest first. */
  quizzes: [],
  /** Topic ids the user has picked, empty when the automatic selection applies. */
  topicSelection: [],
  /** The quiz currently on screen, with `stored` when it came back from the store. */
  quiz: null,
  /**
   * Which of the three per-conversation views is on screen.
   *
   * transcript | generate | quiz
   *
   * The results screen is not a fourth value: it renders inside the quiz view when no
   * step is left, because that is what "no step left" means for a quiz you finished.
   */
  view: 'transcript',
  /** Per-question results once graded. */
  attempt: null,
  /** The quartile band for the final score, from the backend. */
  band: null,
  /** The score from the last completed run, so a resumed quiz can show it. */
  lastScore: null,
  /** The label and action for the generate view's submit button: { action, label, reason }. */
  button: null,
  /** How far the stored quiz has drifted from the conversation: state, newMessages, ... */
  staleness: null,
  /** Where the store lives and whether it is usable, from the backend. */
  storeInfo: null,
  /** Any message the UI should surface, with its severity. */
  notice: null,
  /** True while a generation is in flight. */
  busy: false,
  /** Live progress line while generating. */
  progress: '',
};

export function createStore(overrides = {}) {
  let state = { ...initial, ...overrides };
  const listeners = new Set();

  const emit = () => {
    for (const listener of listeners) listener(state);
  };

  return {
    get state() {
      return state;
    },
    subscribe(listener) {
      listeners.add(listener);
      listener(state);
      return () => listeners.delete(listener);
    },
    /** Merge a patch. `undefined` values are ignored so a partial update cannot null a field. */
    set(patch) {
      const next = { ...state };
      let changed = false;
      for (const [key, value] of Object.entries(patch)) {
        if (value === undefined) continue;
        if (next[key] !== value) changed = true;
        next[key] = value;
      }
      if (!changed) return state;
      state = next;
      emit();
      return state;
    },
    /** Acknowledge a notice so it stops rendering. */
    clearNotice() {
      return this.set({ notice: null });
    },
  };
}
