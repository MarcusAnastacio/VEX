// JSONL readers — the format that covers the largest share of agents.
//
// Instead of one reader per agent (33 of them), this file classifies each
// transcript by sniffing its record shape and then routes to a small extractor.
// Claude Code forks (Qwen, zcode, CodeBuddy, CherryStudio, CommandCode),
// pi forks (omp, prime, Senpi, Kimchi) and Codex forks (Open Interpreter)
// all fall out of the same few shapes for free.

import { contentToParts, contentToText } from '../lib/text.js';
import { finalizeSession, makeMessage, toEpochMs } from '../lib/normalize.js';
import { SESSION_PARENT_FIELDS, isSubagentName } from '../lib/grouping.js';
import { readVscodeChatLog } from './json.js';

/** Parse a JSONL blob, ignoring lines that are not valid JSON. */
export function parseJsonl(raw) {
  const records = [];
  let bad = 0;
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed[0] !== '{' && trimmed[0] !== '[') continue;
    try {
      records.push(JSON.parse(trimmed));
    } catch {
      bad++;
    }
  }
  return { records, bad };
}

// --- shape detection -------------------------------------------------------

const ROLES = new Set(['user', 'assistant', 'system', 'tool', 'human', 'ai', 'model', 'developer', 'gemini']);

function pickRole(...candidates) {
  for (const c of candidates) {
    if (typeof c === 'string' && ROLES.has(c.toLowerCase())) return c;
  }
  return null;
}

/**
 * Classify a transcript by its first records.
 * Returns one of: pi | claude | codex-rollout | codex-history | antigravity |
 * gemini | generic
 */
export function detectJsonlShape(records) {
  const head = records.slice(0, 40);

  // Kimi Code: messages under context.append_message, assistant content streamed
  // through context.append_loop_event -> event.part.
  if (head.some((r) => r?.type === 'context.append_loop_event' || r?.type === 'context.append_message')) return 'kimi';

  // Grok / any ACP agent stream: chunks arrive under params.update.
  if (head.some((r) => r?.params?.update?.sessionUpdate)) return 'grok-acp';

  // GitHub Copilot CLI event log: dotted event types.
  if (
    head.some((r) =>
      ['session.start', 'user.message', 'assistant.message', 'session.shutdown'].includes(r?.type),
    )
  ) {
    return 'copilot-cli';
  }

  // DeepSeek Harness: slashed event types (user/message, assistant/message).
  if (head.some((r) => typeof r?.type === 'string' && r.type.includes('/'))) return 'deepseek';

  // VS Code's append-only chat storage log.
  if (head.some((r) => r?.kind === 0 && r?.v && typeof r.v === 'object' && ('requests' in r.v || 'sessionId' in r.v))) {
    return 'vscode-chat-log';
  }
  if (head.some((r) => typeof r?.kind === 'number' && Array.isArray(r?.k))) return 'vscode-chat-log';

  if (head.some((r) => r?.type === 'session' && (r.cwd || r.version))) return 'pi';
  if (head.some((r) => r?.type === 'session_meta' || r?.payload?.type === 'session_meta')) return 'codex-rollout';
  if (head.some((r) => r?.session_id && r?.ts && typeof r.text === 'string' && !r.type)) return 'codex-history';
  if (head.some((r) => typeof r?.step_index === 'number' || (r?.source && r?.created_at && r?.content !== undefined))) {
    return 'antigravity';
  }
  if (head.some((r) => typeof r?.uuid === 'string' && (r?.parentUuid !== undefined || r?.sessionId))) return 'claude';
  if (head.some((r) => r?.type === 'user' || r?.type === 'assistant' || r?.type === 'gemini')) {
    if (head.some((r) => r?.message?.content !== undefined)) return 'claude';
    if (head.some((r) => r?.message?.parts !== undefined)) return 'gemini';
    // Top-level `content`, which is how the Gemini CLI stores it. Without this the
    // whole transcript fell through to the generic extractor.
    if (head.some((r) => r?.content !== undefined)) return 'claude';
  }
  if (head.some((r) => r?.type === 'message' && r?.message?.role)) return 'pi';
  if (head.some((r) => pickRole(r?.role, r?.payload?.role, r?.author?.role))) return 'generic';
  return 'generic';
}

// --- extractors ------------------------------------------------------------

function extractPi(records) {
  let cwd;
  let started;
  let nativeId;
  let parentSessionId;
  let isSubagent = false;
  const messages = [];

  for (const r of records) {
    if (r?.type === 'session') {
      cwd = r.cwd;
      nativeId = r.id;
      started = toEpochMs(r.timestamp);
      // The `{"type":"session"}` header is the one place this family records a
      // SESSION-level parent. Everything after it carries `parentId`, but that links
      // each event to the event above it and says nothing about which session spawned
      // this one, so reading it here would invent a hierarchy out of a message DAG.
      // prime's header has the field; pi, omp, senpi, kimchi and gjc omit it.
      for (const field of SESSION_PARENT_FIELDS) {
        if (r[field] != null) {
          parentSessionId = r[field];
          break;
        }
      }
      continue;
    }
    if (r?.type === 'session_info') {
      // `subagent-worker-<runId>-1` or `subagent-researcher-<runId>-1` is a Pi
      // subagent, stated outright. It proves the fact on its own and carries no parent
      // session id, so it is used for the flag only. The `parentId` on this same record
      // is the event DAG and is deliberately not read.
      if (isSubagentName(r.name)) isSubagent = true;
      continue;
    }
    if (r?.type !== 'message' || !r.message) continue;
    const { text, tools, thinkingChars } = contentToParts(r.message.content);
    if (!text && !tools?.length) continue;
    messages.push(
      makeMessage({ role: r.message.role, text, thinkingChars, ts: toEpochMs(r.timestamp), tools }),
    );
  }
  return { cwd, nativeId, parentSessionId, isSubagent, started, messages };
}

function extractClaude(records) {
  let cwd;
  let nativeId;
  const messages = [];

  for (const r of records) {
    if (r?.cwd && !cwd) cwd = r.cwd;
    if (r?.sessionId && !nativeId) nativeId = r.sessionId;
    if (r?.type === 'summary') continue;
    // System/meta records carry no conversation.
    if (r?.isMeta) continue;
    // 'gemini' is how the Gemini CLI types an assistant turn. Without it here, every
    // assistant message in a Gemini session was dropped and only the user's half of
    // the conversation survived.
    if (r?.type === 'user' || r?.type === 'assistant' || r?.type === 'system' || r?.type === 'gemini' || r?.type === 'model') {
      // Claude uses message.content; Qwen Code and other forks use message.parts.
      const content = r.message?.content ?? r.message?.parts ?? r.content ?? r.parts;
      const { text, tools, thinkingChars } = contentToParts(content);
      if (!text && !tools?.length) continue;
      messages.push(
        makeMessage({
          role: r.message?.role || r.type,
          text, thinkingChars,
          ts: toEpochMs(r.timestamp),
          tools,
        }),
      );
    }
  }
  return { cwd, nativeId, messages };
}

function extractCodexRollout(records) {
  let cwd;
  let nativeId;
  const messages = [];

  for (const r of records) {
    const p = r?.payload ?? r;
    if (r?.type === 'session_meta' || p?.type === 'session_meta') {
      cwd = p.cwd || cwd;
      nativeId = p.id || nativeId;
      continue;
    }
    if (r?.type === 'turn_context' && p?.cwd) cwd = p.cwd;

    if (p?.type === 'message' && p.role) {
      const { text, tools, thinkingChars } = contentToParts(p.content);
      if (!text && !tools?.length) continue;
      messages.push(makeMessage({ role: p.role, text, thinkingChars, ts: toEpochMs(r.timestamp), tools }));
      continue;
    }
    // Current Codex build: record type is response_item, role sits in the payload.
    if ((r?.type === 'response_item' || p?.type === 'response_item') && p?.role) {
      const { text, tools, thinkingChars } = contentToParts(p.content);
      if (!text && !tools?.length) continue;
      messages.push(makeMessage({ role: p.role, text, thinkingChars, ts: toEpochMs(r.timestamp), tools }));
      continue;
    }
    // Codex also logs compact user prompts as their own event.
    if (p?.type === 'user_message' && typeof p.message === 'string') {
      messages.push(makeMessage({ role: 'user', text: p.message, ts: toEpochMs(r.timestamp) }));
      continue;
    }
    if (p?.type === 'agent_message' && typeof p.message === 'string') {
      messages.push(makeMessage({ role: 'assistant', text: p.message, ts: toEpochMs(r.timestamp) }));
      continue;
    }
    // function_call / reasoning / token_count are noise for a quiz.
  }
  return { cwd, nativeId, messages };
}

function extractCodexHistory(records) {
  const messages = [];
  for (const r of records) {
    if (typeof r?.text === 'string' && r.text.trim()) {
      messages.push(makeMessage({ role: 'user', text: r.text, ts: toEpochMs(r.ts) }));
    }
  }
  return { messages };
}

/**
 * Antigravity records carry the speaker in `source`, not `role`, and the value is
 * Antigravity's own vocabulary: `USER_EXPLICIT` and `MODEL`. Only `MODEL` matched a
 * known role before, so every user turn in an Antigravity session was silently
 * dropped and the transcript read as the model talking to itself.
 */
function antigravityRole(source) {
  const s = String(source || '').trim().toLowerCase();
  if (!s) return null;
  if (s.startsWith('user')) return 'user';
  if (s === 'model' || s.startsWith('assistant') || s.startsWith('agent')) return 'assistant';
  if (s.startsWith('tool') || s.startsWith('function')) return 'tool';
  if (s.startsWith('system')) return 'system';
  return null;
}

/**
 * Antigravity wraps a user turn in XML-ish markers and appends a metadata blob:
 *
 *   <USER_REQUEST>inspect the transcript<ADDITIONAL_METADATA>{"cwd":"/x"}</ADDITIONAL_METADATA></USER_REQUEST>
 *
 * The markers are plumbing, so they are stripped, but the metadata is worth reading
 * first because it is where the working directory lives.
 */
function unwrapAntigravityContent(content) {
  if (typeof content !== 'string') return { text: content, cwd: undefined };
  let cwd;
  const meta = /<ADDITIONAL_METADATA>([\s\S]*?)<\/ADDITIONAL_METADATA>/g;
  let text = content.replace(meta, (_m, json) => {
    try {
      const parsed = JSON.parse(json.trim());
      if (typeof parsed?.cwd === 'string') cwd = parsed.cwd;
    } catch {
      /* the metadata is not always valid JSON; it is still not speech */
    }
    return '';
  });
  text = text.replace(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/g, '$1');
  // Any wrapper left over (a truncated or nested tag) is not content either.
  text = text.replace(/<\/?[A-Z_][A-Z0-9_]*>/g, '');
  return { text: text.trim(), cwd };
}

function extractAntigravity(records) {
  const messages = [];
  let cwd;
  let nativeId;

  for (const r of records) {
    if (r?.cwd) cwd = cwd || r.cwd;
    if (r?.conversation_id || r?.conversationId) nativeId = nativeId || r.conversation_id || r.conversationId;

    const role = antigravityRole(r?.source) || antigravityRole(r?.role) || pickRole(r?.type);
    if (!role) continue;

    const { text: raw, cwd: metaCwd } = unwrapAntigravityContent(r.content ?? r.text);
    if (metaCwd) cwd = cwd || metaCwd;

    const { text, tools, thinkingChars } = contentToParts(raw);
    if (!text && !tools?.length) continue;
    messages.push(makeMessage({ role, text, thinkingChars, ts: toEpochMs(r.created_at || r.timestamp), tools }));
  }
  return { cwd, nativeId, messages };
}

/** Best-effort extraction for anything not specifically recognised. */
function extractGeneric(records) {
  const messages = [];
  let cwd;
  let nativeId;
  let isSubagent = false;

  for (const r of records) {
    if (!r || typeof r !== 'object') {
      if (typeof r === 'string' && r.trim()) messages.push(makeMessage({ role: 'assistant', text: r }));
      continue;
    }
    const p = r.payload ?? r;

    if (!cwd) cwd = r.cwd || p.cwd || r.workspace || r.working_directory;
    if (!nativeId) {
      nativeId = r.sessionId || r.session_id || p.sessionId || p.id || r.conversation_id || r.id;
    }
    // A subagent transcript that lost its `{"type":"session"}` header lands here
    // instead of in extractPi, and the `subagent-` name survives that. It names the
    // RUN, not the parent session, so it sets the flag and nothing else.
    if (!isSubagent && (isSubagentName(r.name) || isSubagentName(p.name))) isSubagent = true;

    // Skip records that announce themselves as non-conversation.
    const t = String(r.type || p.type || '').toLowerCase();
    if (['token_count', 'function_call', 'function_call_output', 'tool_result', 'tool_use',
         'reasoning', 'summary', 'metadata', 'session_meta', 'turn_context', 'checkpoint',
         'state', 'error', 'event'].includes(t)) {
      continue;
    }

    const role = pickRole(r.role, r.message?.role, p.role, p.message?.role, p.author?.role,
                          r.author?.role, t);
    if (!role) continue;

    const content = r.content ?? r.message?.content ?? r.message?.parts ?? p.content ??
                    p.message?.content ?? p.message?.parts ?? p.text ?? p.message?.text ?? r.text;
    if (content === undefined) continue;

    const { text, tools, thinkingChars } = contentToParts(content);
    if (!text && !tools?.length) continue;
    messages.push(makeMessage({ role, text, thinkingChars, ts: toEpochMs(r.timestamp || r.ts || r.created_at || p.timestamp), tools }));
  }
  return { cwd, nativeId, isSubagent, messages };
}

/**
 * Event-log agents: one record per event, with the role encoded in the event
 * name and the payload under `data`. Copilot CLI separates with `.`
 * (`user.message`), DeepSeek Harness with `/` (`user/message`).
 */
function extractEventLog(records, sep) {
  let cwd;
  let nativeId;
  let title;
  let started;
  const messages = [];

  for (const r of records) {
    const type = String(r?.type || '');
    const data = r?.data ?? r;

    if (!cwd) cwd = data?.context?.cwd || data?.cwd || r?.cwd;
    if (!nativeId) nativeId = data?.sessionId || data?.id || r?.id || r?.sessionId;
    if (!started) started = toEpochMs(data?.startTime || data?.createdAt || r?.createdAt || r?.timestamp);
    if (!title && type.endsWith(`${sep}title`)) title = data?.title;

    // Take the segment before the separator as the role word.
    const head = type.includes(sep) ? type.slice(0, type.indexOf(sep)) : type;
    if (!['user', 'assistant', 'system', 'human', 'ai', 'model', 'tool'].includes(head)) continue;

    // Chunked streams (assistant.message.chunk) would be concatenated elsewhere.
    const content = data?.content ?? data?.message ?? data?.text;
    if (content === undefined) continue;
    const { text, tools, thinkingChars } = contentToParts(content);
    if (!text && !tools?.length) continue;
    messages.push(makeMessage({ role: head, text, thinkingChars, ts: toEpochMs(r?.timestamp), tools }));
  }

  return { cwd, nativeId, title, started, messages };
}

/**
 * Grok / ACP: incremental chunks that belong to the same turn must be merged.
 * A change of `sessionUpdate` kind closes the current message.
 */
function extractGrokAcp(records) {
  let cwd;
  let nativeId;
  const messages = [];
  let current = null;

  const flush = () => {
    if (current && current.text.trim()) messages.push(makeMessage(current));
    current = null;
  };

  for (const r of records) {
    const update = r?.params?.update;
    if (!update) {
      if (r?.info?.cwd) cwd = r.info.cwd;
      if (r?.info?.id) nativeId = r.info.id;
      continue;
    }
    const kind = String(update.sessionUpdate || '');
    const role = kind.startsWith('user') ? 'user' : kind.startsWith('agent') ? 'assistant' : null;
    if (!role) continue;

    const { text, thinkingChars } = contentToParts(update.content ?? update.text);
    if (!text) continue;

    if (!current || current.role !== role) {
      flush();
      current = { role, text: '', ts: toEpochMs((r.timestamp || 0) * 1000) };
    }
    current.text += text;
  }
  flush();

  return { cwd, nativeId, messages };
}

/**
 * Kimi Code's wire log.
 *
 * Two record kinds carry conversation: `context.append_message` for whole messages
 * (the user's turns), and `context.append_loop_event` for the assistant's streamed
 * `event.part` blocks, where `part.type` is `think` (reasoning, dropped) or `text`.
 * Only the first kind was understood before, so an entire Kimi session read as the
 * user talking to themselves.
 */
function extractKimi(records) {
  const messages = [];
  let nativeId;
  let started;
  let pending = [];
  // Reasoning is dropped from the text but its size is reported, so the digest can
  // say how much of the session it is not showing.
  let pendingThinking = 0;

  const flush = () => {
    const text = pending.join('\n').trim();
    const thinkingChars = pendingThinking;
    pending = [];
    pendingThinking = 0;
    if (text) messages.push(makeMessage({ role: 'assistant', text, thinkingChars }));
  };

  for (const r of records) {
    const ts = toEpochMs(r?.time || r?.timestamp);

    if (r?.type === 'context.append_message' && r.message) {
      const { text, tools, thinkingChars } = contentToParts(r.message.content);
      const role = normalizeRoleish(r.message.role);
      if (role === 'user') {
        flush();
        if (text) messages.push(makeMessage({ role: 'user', text, ts, tools, thinkingChars }));
      } else if (text || tools?.length || thinkingChars) {
        if (text) pending.push(text);
        pendingThinking += thinkingChars || 0;
        if (tools?.length) {
          flush();
          messages.push(makeMessage({ role: 'assistant', text: '', ts, tools }));
        }
      }
      continue;
    }

    if (r?.type === 'context.append_loop_event') {
      const part = r.event?.part;
      if (!part) continue;
      // contentToParts handles part.type of 'think' as reasoning and 'text' as text.
      const { text, tools, thinkingChars } = contentToParts(part);
      if (text) pending.push(text);
      pendingThinking += thinkingChars || 0;
      if (!text && tools?.length) {
        flush();
        messages.push(makeMessage({ role: 'assistant', text: '', ts, tools }));
      }
      continue;
    }
  }
  flush();
  return { nativeId, started, messages };
}

/** Local role normaliser so this extractor does not depend on normalize.js internals. */
function normalizeRoleish(role) {
  const r = String(role || '').toLowerCase();
  if (r === 'user' || r === 'human') return 'user';
  if (r === 'assistant' || r === 'model' || r === 'gemini') return 'assistant';
  if (r === 'system') return 'system';
  if (r === 'tool' || r === 'toolresult') return 'tool';
  return null;
}

const EXTRACTORS = {
  pi: extractPi,
  kimi: extractKimi,
  claude: extractClaude,
  'codex-rollout': extractCodexRollout,
  'codex-history': extractCodexHistory,
  antigravity: extractAntigravity,
  gemini: extractClaude,
  'copilot-cli': (records) => extractEventLog(records, '.'),
  deepseek: (records) => extractEventLog(records, '/'),
  'grok-acp': extractGrokAcp,
  generic: extractGeneric,
};

/**
 * Parse a JSONL transcript into a normalized session.
 * @param {string} raw        decoded file contents
 * @param {object} ctx        { harness, harnessName, path, project }
 */
export function readJsonl(raw, ctx) {
  const { records, bad } = parseJsonl(raw);
  if (records.length === 0) return null;

  const shape = detectJsonlShape(records);

  if (shape === 'vscode-chat-log') {
    const result = readVscodeChatLog(records, ctx);
    if (result.empty) return { empty: true };
    return result.sessions?.[0] ?? null;
  }

  const extractor = EXTRACTORS[shape] || extractGeneric;

  let extracted;
  try {
    extracted = extractor(records);
  } catch {
    extracted = extractGeneric(records);
  }

  if (!extracted.messages?.length) return { empty: true };

  return finalizeSession({
    ...ctx,
    ...extracted,
    source: 'file',
    partial: bad > 0 || undefined,
  });
}
