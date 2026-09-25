'use strict';
/*
 * NODO Supervisor / Anti-loop Governor v1.
 *
 * This is mechanical control, not a prompt rule. It sits inside the harness
 * tool pipeline, so every model - DeepSeek today, anything later - is governed
 * by the same code:
 *
 *   ctx.tools.guard(...)          -> the only place a call can be stopped
 *   ctx.on('tools/execute', ...)  -> real outcomes, durations, in-flight count
 *   ctx.on('session/event', ...)  -> turn boundaries and inbound user messages
 *   ctx.sessionController.cancel  -> the standard, safe way to stop a turn
 *
 * The supervisor never guesses what the agent "meant". It counts normalized
 * operations, objective state changes and elapsed time, and it stops a turn
 * when the numbers say the turn is not going anywhere:
 *
 *   repeatLimit         same normalized operation without new progress
 *   postFixCheckLimit   re-runs of a still-failing check after one concrete fix
 *   passNoChangeLimit   re-runs of a check that already passed, code unchanged
 *   optionalAuditLimit  extra verification commands after acceptance is met
 *   noProgressMs        no objective progress at all while a turn runs
 *
 * A stop is soft first: new tool calls are denied with a human-readable reason
 * while the in-flight operation is allowed to finish. Only when the turn still
 * does not end inside graceMs does the supervisor cancel it the standard way.
 * One "Continue once" grants exactly one further attempt.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const telemetry = require('./telemetry.cjs');

const VERSION = 1;

const DEFAULTS = {
  repeatLimit: 3,
  postFixCheckLimit: 1,
  passNoChangeLimit: 0,
  optionalAuditLimit: 2,
  noProgressMs: 15 * 60 * 1000,
  stepWarnMs: 10 * 60 * 1000,
  graceMs: 15000,
  tickMs: 20000,
  publishMs: 400,
  eventsKept: 200,
  detailsKept: 60,
  historyKept: 400,
  // Persistence is deliberately small: the last few sessions, each with the
  // last handful of operations. Enough to survive a restart, never a history.
  persistMs: 1500,
  sessionsKept: 6,
  opsKept: 12
};

// Thresholds a human may tune in Settings / Advanced. Everything else in
// DEFAULTS is mechanical detail of the supervisor itself, not a preference.
const TUNABLE = {
  repeatLimit: { min: 1, max: 10, unit: 'runs', label: 'Repeats without a new result', hint: 'the run after this many identical executions is stopped' },
  postFixCheckLimit: { min: 0, max: 5, unit: 'reruns', label: 'Re-runs of a failing check after one fix', hint: 'a concrete fix earns this many repeats of the related check' },
  passNoChangeLimit: { min: 0, max: 3, unit: 'reruns', label: 'Re-runs of a check that already passed', hint: 'zero means a passing check is never repeated while the code is unchanged' },
  optionalAuditLimit: { min: 0, max: 10, unit: 'checks', label: 'Optional checks after the criteria are met', hint: 'extra audits allowed once the acceptance check passed' },
  noProgressMs: { min: 60000, max: 7200000, unit: 'ms', label: 'No objective progress', hint: 'whole-turn time without any real progress before the supervisor intervenes' },
  stepWarnMs: { min: 30000, max: 3600000, unit: 'ms', label: 'One step running long', hint: 'a single tool call is reported as long-running after this time' }
};
const TUNABLE_KEYS = Object.keys(TUNABLE);

function readSettings(file) {
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    const out = {};
    for (const key of TUNABLE_KEYS) {
      const value = Number(saved && saved[key]);
      if (Number.isFinite(value) && value >= TUNABLE[key].min && value <= TUNABLE[key].max) out[key] = Math.round(value);
    }
    return out;
  } catch {
    return {};
  }
}

const WRITE_TOOLS = new Set(['write', 'edit', 'str_replace_editor', 'apply_patch', 'notebook_edit', 'rc_write_file']);
const PATH_TOOLS = new Set(['read', 'write', 'edit', 'str_replace_editor', 'apply_patch', 'rc_read_file', 'rc_write_file', 'rc_list_files', 'present']);
// Recording a commit does not change the code under test; everything else a
// mutating command does, does.
const VCS_BOOKKEEPING = /^git\s+(?:add|commit|push|tag|fetch|remote)\b/i;

// ---------------------------------------------------------------------------
// Normalization. Two operations that do the same thing must produce the same
// signature even when pids, timestamps, temp paths or an equivalent `cd` prefix
// differ, and two operations that differ in what they actually touch must not.
// ---------------------------------------------------------------------------

const VOLATILE = [
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<ID>'],
  [/\b[0-9a-f]{16,}\b/gi, '<ID>'],
  [/\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?\b/g, '<TS>'],
  [/\b\d{2}:\d{2}:\d{2}(?:\.\d+)?\b/g, '<TS>'],
  [/\b1\d{9}\b|\b1\d{12}\b/g, '<TS>'],
  [/(?:\/private)?\/var\/folders\/[^\s"']+|\/tmp\/[^\s"']+|\$TMPDIR\/[^\s"']+/g, '<TMP>'],
  [/\bnodo-[A-Za-z0-9]{4,}\b/g, '<TMP>'],
  [/\b\d{5,7}\b/g, '<N>'],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '<MAIL>'],
  [/\b[0-9a-f]{12,}\b/gi, '<ID>']
];

function normalize(value) {
  let text = value === undefined || value === null ? '' : String(value);
  text = text.replace(/\s+/g, ' ').trim();
  for (const [pattern, replacement] of VOLATILE) text = text.replace(pattern, replacement);
  return text.replace(/\s+/g, ' ').trim();
}

function normalizePath(value, cwd) {
  let target = String(value === undefined || value === null ? '' : value).trim().replace(/^['"]|['"]$/g, '');
  if (!target) return '';
  target = target.replace(/^~(?=\/|$)/, process.env.HOME || '~').replace(/^\$HOME(?=\/|$)/, process.env.HOME || '$HOME');
  if (cwd && !target.startsWith('/')) target = path.resolve(cwd, target);
  return normalize(path.normalize(target));
}

/** A `cd X && cmd` prefix carries no identity of its own. */
function trimCdPrefix(command) {
  return String(command || '')
    .replace(/^(?:\s*cd\s+(?:"[^"]*"|'[^']*'|[^\s;&|]+)\s*(?:&&|;)\s*)+/, '')
    .replace(/^\s*sudo\s+/, '')
    .trim();
}

// ---------------------------------------------------------------------------
// Command classification. Verify-class operations are the ones whose PASS means
// something, and whose repeat is therefore governed by its own budgets.
// ---------------------------------------------------------------------------

const VERIFY_RE = new RegExp([
  '\\bnode\\s+--test\\b',
  '^(?:npm|pnpm|yarn|bun)\\s+(?:run\\s+)?(?:test|tests|lint|typecheck|check|verify|validate|audit)\\b',
  '^(?:npx|pnpm\\s+dlx|yarn\\s+dlx)\\s+(?:jest|vitest|mocha|tsc|eslint|playwright)\\b',
  '^(?:jest|vitest|mocha|pytest|tsc|eslint|ruff|shellcheck|golangci-lint|swiftlint|biome)\\b',
  '^python3?\\s+-m\\s+(?:pytest|unittest)\\b',
  '^(?:swift|xcodebuild|go|cargo|gradle|mvn)\\b[\\s\\S]*\\b(?:test|check|verify)\\b',
  '^make\\s+(?:test|check|verify)\\b',
  '^(?:node|bash|\\.\\/)?(?:scripts\\/)?(?:test|verify|check|audit)[\\w.-]*\\.(?:c?m?js|mjs|sh|py)\\b'
].join('|'), 'i');

const MUTATE_RE = new RegExp([
  '^git\\s+(?:add|commit|checkout|switch|merge|rebase|apply|am|stash|tag|reset|rm|mv|restore|clean|init|clone|pull|push|cherry-pick|revert)\\b',
  '^(?:npm|pnpm|yarn|bun)\\s+(?:i|install|ci|uninstall|remove|add|link|publish|build|run\\s+build|run\\s+release)\\b',
  '^(?:pip3?|pipx)\\s+(?:install|uninstall)\\b',
  '^brew\\s+(?:install|uninstall|upgrade|link)\\b',
  '^(?:make|cmake|ninja|xcodebuild\\s+build|swift\\s+build|cargo\\s+build|go\\s+build)\\b',
  '^(?:mkdir|rmdir|rm|mv|cp|touch|chmod|chown|ln|sed|patch|tee|dd|truncate|install|rsync|mktemp)\\b',
  '^(?:kill|pkill|killall|launchctl|defaults|chflags|setfile)\\b',
  '^osascript\\b'
].join('|'), 'i');

const LAUNCH_RE = /^(?:open\s+(?:-[a-zA-Z]+\s+)*|osascript\s+[\s\S]*\b(?:launch|activate|open)\b)/i;
const INSPECT_RE = /^(?:cat|ls|find|grep|rg|egrep|fgrep|head|tail|stat|wc|file|du|df|ps|top|which|type|echo|printf|pwd|env|printenv|date|whoami|uname|sw_vers|mdfind|plutil|jq|awk|diff|cmp|xxd|hexdump|git\s+(?:status|log|diff|show|rev-parse|branch|remote|describe|blame|ls-files)|node\s+-e|node\s+-p|python3?\s+-c)\b/i;
const REDIRECT_RE = /(?:^|[^0-9\s])>{1,2}\s*[^\s&|]/;

function classify(command) {
  const head = trimCdPrefix(command);
  if (!head) return 'other';
  if (VERIFY_RE.test(head)) return 'verify';
  if (LAUNCH_RE.test(head)) return 'launch';
  if (MUTATE_RE.test(head) || REDIRECT_RE.test(head)) return 'mutate';
  if (INSPECT_RE.test(head)) return 'inspect';
  return 'other';
}

// ---------------------------------------------------------------------------
// Composite shell commands. An agent must not be able to hide a repeat behind a
// shell wrapper or by gluing commands together: every command is unwrapped,
// split into its top-level segments and identified by the sequence of those
// segments, so `bash -c "npm test"`, `npm test` and `cd x && npm test` are one
// operation while `npm test && git commit` is not.
// ---------------------------------------------------------------------------

const WRAPPER_RE = /^(?:\/(?:usr\/)?bin\/)?(?:ba|z|k|da)?sh\s+-[A-Za-z]*c\s+[\s\S]+$/;
const ENV_PREFIX_RE = new RegExp(
  '^(?:' +
  'sudo(?:\\s+(?:-[A-Za-z-]+|--[A-Za-z-]+)(?:\\s+[^\\s-][^\\s]*)?)*\\s+' +   // sudo -u root -E cmd
  '|(?:command|nohup|time|env(?:\\s+[A-Za-z_][A-Za-z0-9_]*=\\S*)*)\\s+' +
  '|(?:[A-Za-z_][A-Za-z0-9_]*=\\S+\\s+)+' +                                     // VAR=value cmd
  ')'
);

/** Peel `sudo/time/env K=V/bash -c '...'` until the real script is visible. */
function unwrapCommand(raw, depth = 0) {
  let text = String(raw === undefined || raw === null ? '' : raw).trim();
  if (depth > 4) return text;
  for (let i = 0; i < 4; i += 1) {
    const prefix = text.match(ENV_PREFIX_RE);
    if (!prefix) break;
    text = text.slice(prefix[0].length).trim();
  }
  const wrapper = text.match(WRAPPER_RE);
  if (wrapper) {
    const script = text.replace(/^[\s\S]*?\s-[A-Za-z]*c\s+/, '').trim();
    const quote = script[0];
    const end = quote === '"' || quote === "'" ? script.indexOf(quote, 1) : -1;
    return unwrapCommand(end > 0 ? script.slice(1, end) : script, depth + 1);
  }
  return text;
}

/** Top-level `&&`, `||`, `;`, `|`, `&` and newlines, ignoring quotes and $( ). */
function splitSegments(text) {
  const segments = [];
  const operators = [];
  let buffer = '';
  let quote = null;
  let depth = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      buffer += ch;
      if (ch === '\\' && quote === '"') { buffer += text[i + 1] || ''; i += 1; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '\\') { buffer += ch + (text[i + 1] || ''); i += 1; continue; }
    if (ch === '"' || ch === "'") { quote = ch; buffer += ch; continue; }
    if (ch === '(' || ch === '{' || ch === '[') depth += 1;
    else if (ch === ')' || ch === '}' || ch === ']') depth = Math.max(0, depth - 1);
    if (depth === 0) {
      const pair = text.slice(i, i + 2);
      if (pair === '&&' || pair === '||') { segments.push(buffer); operators.push(pair); buffer = ''; i += 1; continue; }
      if (ch === ';' || ch === '|' || ch === '&' || ch === '\n') { segments.push(buffer); operators.push(ch); buffer = ''; continue; }
    }
    buffer += ch;
  }
  segments.push(buffer);
  return { segments: segments.map(part => part.trim()).filter(Boolean), operators };
}

const KIND_RANK = { mutate: 4, verify: 3, launch: 2, inspect: 1, other: 0 };

/**
 * One command, fully analyzed: the strongest kind among its segments, and a
 * fingerprint built from the segments themselves rather than from the syntax
 * that glued them together.
 */
function analyzeCommand(raw) {
  const unwrapped = unwrapCommand(raw);
  const { segments, operators } = splitSegments(trimCdPrefix(unwrapped));
  const parts = (segments.length ? segments : [unwrapped])
    .map(segment => unwrapCommand(segment))
    .filter(segment => segment && !/^cd(?:\s|$)/.test(segment))
    .map(segment => ({ text: normalize(segment), kind: classify(segment) }))
    .filter(part => part.text);
  let kind = 'other';
  for (const part of parts) if (KIND_RANK[part.kind] > KIND_RANK[kind]) kind = part.kind;
  const joined = parts.map(part => part.text).join(' ;; ');
  return { parts, operators, kind, wrapper: unwrapped !== String(raw === undefined || raw === null ? '' : raw).trim(),
    fingerprint: joined.slice(0, 600), target: parts.map(part => part.text).join(' ; ').slice(0, 200) || normalize(raw).slice(0, 200) };
}

/** `git add && git commit` moves no code; anything else that mutates does. */
function isBookkeeping(call) {
  const parts = call && call.parts && call.parts.length ? call.parts.map(part => part.text) : [call && call.command || ''];
  const mutating = parts.filter(part => classify(part) === 'mutate');
  return mutating.length > 0 && mutating.every(part => VCS_BOOKKEEPING.test(part));
}

// ---------------------------------------------------------------------------
// Auxiliary Verifier hook.
//
// NODO has exactly one auxiliary model and it is Nemotron 3 Ultra Free. v1 is
// fully mechanical and never needs it: the hook exists so a later round can
// consult one verifier when code alone cannot decide, and only for three
// questions - real progress or repeat, new blocker or a rephrased old one, is
// the task safe to call finished. The telemetry handed over is deliberately
// anonymous: tool names, classes, counts, durations, normalized hashes. No
// prompts, no file contents, no paths, no client or private data. When the
// model is absent the answer is simply "no opinion" and the mechanical path
// continues unchanged.
// ---------------------------------------------------------------------------

class AuxiliaryVerifier {
  constructor(options = {}) {
    this.endpoint = options.endpoint || process.env.NODO_AUX_VERIFIER_ENDPOINT || '';
    this.model = options.model || process.env.NODO_AUX_VERIFIER_MODEL || 'nemotron-3-ultra-free';
    this.timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 8000;
    this.disabled = options.disabled === true || process.env.NODO_AUX_VERIFIER === 'off';
  }
  get available() {
    return !this.disabled && typeof this.endpoint === 'string' && /^https?:\/\//.test(this.endpoint);
  }
  /**
   * Ask one bounded question about anonymous telemetry.
   * @returns {Promise<null|{answer: string, confidence: number}>} null when no opinion is available.
   */
  async ask(kind, telemetry) {
    if (!this.available) return null;
    try {
      const response = await fetch(this.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: this.model, kind, telemetry: anonymize(telemetry) }),
        signal: AbortSignal.timeout(this.timeoutMs)
      });
      if (!response.ok) return null;
      const body = await response.json();
      if (!body || typeof body.answer !== 'string') return null;
      return { answer: body.answer, confidence: Number(body.confidence) || 0 };
    } catch {
      return null;
    }
  }
}

/** Strip anything a third party must not see before it leaves the machine. */
function anonymize(value) {
  if (typeof value === 'string') return normalize(value).slice(0, 160);
  if (Array.isArray(value)) return value.slice(0, 20).map(anonymize);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (/path|file|text|content|prompt|message|output|stdout|stderr|token|key|command|operation|signature|target|cwd|dir|arg/i.test(key)) continue;
      out[key] = anonymize(item);
    }
    return out;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Supervisor
// ---------------------------------------------------------------------------

class Supervisor {
  constructor(options = {}) {
    this.settingsFile = options.settingsFile || path.join(options.dataDir || process.env.NODO_DATA || path.join(os.tmpdir(), 'nodo-supervisor'), 'supervisor-settings.json');
    this.thresholds = { ...DEFAULTS, ...readSettings(this.settingsFile), ...(options.thresholds || {}) };
    this.logger = options.logger || null;
    this.bridge = typeof options.bridge === 'function' ? options.bridge : null;
    this.cancel = typeof options.cancel === 'function' ? options.cancel : null;
    // One auxiliary provider for the whole product: anything with an `ask`
    // method is accepted, so the verifier and the interpreters share one model.
    this.verifier = options.verifier && typeof options.verifier.ask === 'function'
      ? options.verifier
      : new AuxiliaryVerifier(options.verifier || {});
    this.dataDir = options.dataDir || process.env.NODO_DATA || path.join(os.tmpdir(), 'nodo-supervisor');
    this.logFile = options.logFile || path.join(this.dataDir, 'supervisor.jsonl');
    this.stateFile = options.stateFile || path.join(this.dataDir, 'supervisor-state.json');
    this.sessions = new Map();
    this.history = [];
    this.timer = null;
    this.persistTimer = null;
    this.enabled = options.enabled !== false;
    this.logWriteFailed = false;
    this.restore();
  }

  // -- persistence --------------------------------------------------------
  //
  // Budgets, PASS state, interventions and a granted Continue once survive a
  // restart of NODO; nothing else does. The file is bounded by construction:
  // the newest `sessionsKept` sessions, each with its newest `opsKept`
  // operations. Events are journal-only and stay in supervisor.jsonl.

  restore() {
    try {
      if (!fs.existsSync(this.stateFile)) return;
      const saved = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
      const records = (saved && Array.isArray(saved.sessions) ? saved.sessions : []).slice(0, this.thresholds.sessionsKept);
      const now = Date.now();
      for (const record of records) {
        if (!record || typeof record.sessionId !== 'string' || this.sessions.has(record.sessionId)) continue;
        const state = this.state(record.sessionId, true);
        state.codeGen = Number(record.codeGen) || 0;
        state.progressCount = Number(record.progressCount) || 0;
        state.lastProgressAt = Number(record.lastProgressAt) || now;
        state.lastProgress = record.lastProgress || null;
        if (record.acceptance && typeof record.acceptance === 'object') state.acceptance = record.acceptance;
        state.auditsAfterAcceptance = Number(record.auditsAfterAcceptance) || 0;
        // A restart is not a resume: nothing is running, but an intervention
        // stays visible and still blocks the same operation until it is acted on.
        state.phase = record.phase === 'intervened' || record.phase === 'finished' ? record.phase : 'idle';
        state.intervention = record.intervention || null;
        state.blocked = record.blocked || null;
        if (state.intervention && !state.blocked) state.blocked = { signature: state.intervention.signature || null, gen: state.codeGen, problem: state.intervention.problem || state.intervention.code || 'loop' };
        if (record.oneShot && typeof record.oneShot === 'object' && Number(record.oneShot.expiresAt) > now) state.oneShot = { ...record.oneShot, turnsSeen: 0 };
        for (const op of (Array.isArray(record.ops) ? record.ops : []).slice(0, this.thresholds.opsKept)) {
          if (!op || typeof op.signature !== 'string') continue;
          state.ops.set(op.signature, { ...op, oneShotAttempt: false });
          state.order.push(op.signature);
        }
        state.restored = true;
      }
    } catch (error) {
      this.warn('state restore skipped: ' + (error && error.message));
    }
  }

  schedulePersist() {
    if (!this.enabled || this.persistTimer) return;
    this.persistTimer = setTimeout(() => { this.persistTimer = null; this.save(); }, this.thresholds.persistMs);
    if (this.persistTimer.unref) this.persistTimer.unref();
  }

  save() {
    try {
      const sessions = [...this.sessions.values()]
        .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
        .slice(0, this.thresholds.sessionsKept)
        .map(state => ({
          sessionId: state.id,
          updatedAt: state.updatedAt,
          phase: state.phase,
          codeGen: state.codeGen,
          progressCount: state.progressCount,
          lastProgressAt: state.lastProgressAt,
          lastProgress: state.lastProgress,
          acceptance: state.acceptance,
          auditsAfterAcceptance: state.auditsAfterAcceptance,
          intervention: state.intervention,
          blocked: state.blocked,
          oneShot: state.oneShot,
          ops: [...state.ops.values()]
            .sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0))
            .slice(0, this.thresholds.opsKept)
            .map(op => ({
              signature: op.signature, target: op.target, kind: op.kind, executions: op.executions,
              sinceProgress: op.sinceProgress, lastOutcome: op.lastOutcome, passGen: op.passGen,
              sincePass: op.sincePass, sinceFix: op.sinceFix, fixedAfterFail: op.fixedAfterFail,
              tripNext: op.tripNext, lastAt: op.lastAt, error: op.error || null,
              resultDigest: op.resultDigest, lastDigest: op.lastDigest
            }))
        }));
      fs.mkdirSync(path.dirname(this.stateFile), { recursive: true, mode: 0o700 });
      const tmp = this.stateFile + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ version: VERSION, savedAt: Date.now(), sessions }), { mode: 0o600 });
      fs.renameSync(tmp, this.stateFile);
    } catch (error) {
      this.warn('state save skipped: ' + (error && error.message));
    }
  }

  // -- state --------------------------------------------------------------

  state(sessionId, create = false) {
    let state = this.sessions.get(sessionId);
    if (!state && create) {
      state = {
        id: sessionId,
        phase: 'idle',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        turn: { startedAt: 0, count: 0, step: 0 },
        lastProgressAt: Date.now(),
        lastProgress: null,
        progressCount: 0,
        codeGen: 0,
        acceptance: { met: false, at: 0, check: null, gen: -1 },
        ops: new Map(),
        order: [],
        attempts: 0,
        stepsSinceProgress: 0,
        inFlight: 0,
        inFlightSince: 0,
        inFlightTool: null,
        current: null,
        lastError: null,
        intervention: null,
        blocked: null,
        oneShot: null,
        interrupts: [],
        auditsAfterAcceptance: 0,
        stopTimer: null,
        lastPublishAt: 0,
        events: []
      };
      this.sessions.set(sessionId, state);
    }
    return state;
  }

  /** The session a call belongs to: a real agent turn with its own session record. */
  sessionKey(exec) {
    return telemetry.observation(exec).sessionId;
  }

  /** The adapter of the runner that produced this call. */
  adapterFor(exec) {
    return telemetry.adapterFor((exec && exec.provider) || 'dsh');
  }

  // -- observation --------------------------------------------------------

  describe(exec) {
    // Provider-neutral: the adapter decides what a call looks like, the
    // supervisor only knows tools, arguments and a working directory.
    const canonical = telemetry.observation(exec);
    const args = canonical.arguments || {};
    const cwd = canonical.cwd || '';
    const name = canonical.tool || 'tool';
    if (name === 'bash' || name === 'shell' || name === 'terminal' || typeof args.command === 'string') {
      const raw = String(args.command || '');
      const analysis = analyzeCommand(raw);
      const workdir = normalizePath(args.workdir || cwd, '');
      return {
        name,
        kind: analysis.kind,
        target: analysis.target || name,
        signature: name + '|' + (workdir ? workdir + '|' : '') + analysis.fingerprint,
        command: analysis.fingerprint,
        parts: analysis.parts,
        operators: analysis.operators,
        wrapped: analysis.wrapper,
        writeArgs: null
      };
    }
    const pointed = PATH_TOOLS.has(name) && (args.file_path || args.path);
    const pointedValue = pointed ? normalizePath(args.file_path || args.path, cwd) : '';
    const target = pointedValue || normalize(args.url || args.id || args.action || args.pattern || args.query || '');
    const signature = name + '|' + (target || normalize(JSON.stringify(args)).slice(0, 300));
    const kind = WRITE_TOOLS.has(name) ? 'mutate' : (name === 'rc_browser' || name === 'open') ? 'launch' : 'other';
    return {
      name,
      kind,
      target: (target || name).slice(0, 200),
      signature,
      command: '',
      writeArgs: WRITE_TOOLS.has(name) ? crypto.createHash('sha1').update(JSON.stringify(args)).digest('hex').slice(0, 16) : null
    };
  }

  /**
   * The only hard control point. Returns a denial reason, or undefined to let
   * the call through unchanged. Guard bodies stay synchronous and cheap: the
   * tool pipeline calls this for every single call.
   */
  guard(exec) {
    if (!this.enabled) return undefined;
    try {
      const sessionId = this.sessionKey(exec);
      if (!sessionId || exec.parent) return undefined;
      const state = this.state(sessionId, true);
      const call = this.describe(exec);
      const op = this.opFor(state, call, true);
      const now = Date.now();
      state.updatedAt = now;

      const denial = this.decide(state, op, call, sessionId);
      if (denial) {
        op.denied += 1;
        state.denials = (state.denials || 0) + 1;
        this.remember(state, {
          type: denial.event,
          code: denial.code,
          detail: { tool: call.name, operation: call.target, signature: call.signature, reason: denial.reason }
        });
        return denial.reason;
      }

      op.attempts += 1;
      op.sinceProgress += 1;
      op.sinceFix += 1;
      op.lastAt = now;
      state.attempts += 1;
      state.stepsSinceProgress += 1;
      state.current = { tool: call.name, target: call.target, kind: call.kind, at: now, signature: call.signature };
      if (op.attempts > 1) {
        this.remember(state, {
          type: 'repeated-command',
          code: 'repeat',
          detail: { tool: call.name, operation: call.target, occurrences: op.attempts }
        }, 'quiet');
      }
      return undefined;
    } catch (error) {
      // A supervisor fault must never take the harness down with it.
      this.warn('guard failed: ' + (error && error.message));
      return undefined;
    }
  }

  decide(state, op, call, sessionId) {
    if (state.phase === 'intervened' || state.phase === 'finished') {
      const inter = state.intervention || {};
      return {
        code: state.phase === 'finished' ? 'finished' : (inter.code || 'loop'),
        event: 'denied',
        reason: this.reasonText(state.phase === 'finished' ? 'finished' : (inter.code || 'loop'), inter, call)
      };
    }
    // "Continue once" opens exactly one more attempt of the blocked operation.
    // Nothing else about the loop changes: a second identical repeat without a
    // new result is stopped again.
    if (state.oneShot && (state.oneShot.signature === null || state.oneShot.signature === call.signature)) {
      if (state.oneShot.used || Date.now() > state.oneShot.expiresAt) {
        return {
          code: 'one-shot-used',
          event: 'denied',
          reason: 'NODO Supervisor: the single additional attempt granted by Continue once was already used for this operation. Change the related code or input, or finish the turn and report the state.'
        };
      }
      state.oneShot.used = true;
      op.oneShotAttempt = true;
      this.remember(state, { type: 'manual-continue-attempt', code: 'one-shot', detail: { tool: call.name, operation: call.target } }, 'quiet');
      return null;
    }
    if (state.phase === 'pausing') return { code: 'user-interrupt', event: 'denied', reason: this.pauseText(state) };
    // A new user turn clears the intervention, but the exact operation that
    // caused it stays blocked until something objective changes.
    if (state.blocked && state.blocked.signature === call.signature && state.blocked.gen === state.codeGen) {
      return {
        code: 'blocked-operation',
        event: 'denied',
        reason: 'NODO Supervisor: this exact operation is still blocked after a loop (' + (state.blocked.problem || 'no new result') +
          '). Change the related code or input first, or use Continue once in the supervisor card.'
      };
    }
    if (state.blocked && state.blocked.gen !== state.codeGen) state.blocked = null;
    // The granted attempt produced nothing new: the next identical repeat is
    // the loop, and it is stopped without waiting for the whole budget again.
    if (op.tripNext) {
      const intervention = this.intervene(state, sessionId, 'repeated-operation', {
        operation: call.target,
        tool: call.name,
        occurrences: op.attempts,
        blocker: op.error
      });
      return { code: 'repeated-operation', event: 'repeated-command', reason: this.reasonText('repeated-operation', intervention, call) };
    }

    // Acceptance already met: further verification is an optional audit.
    if (state.acceptance.met && state.acceptance.gen === state.codeGen && call.kind === 'verify') {
      if (state.auditsAfterAcceptance >= this.thresholds.optionalAuditLimit) {
        const intervention = this.intervene(state, sessionId, 'success-stop', { operation: call.target, tool: call.name });
        return { code: 'success-stop', event: 'success-stop', reason: this.reasonText('success-stop', intervention, call) };
      }
      state.auditsAfterAcceptance += 1;
    }

    // A check that already passed must not run again while its code is untouched.
    if (call.kind === 'verify' && op.lastOutcome === 'pass' && op.passGen === state.codeGen) {
      op.sincePass += 1;
      if (op.sincePass > this.thresholds.passNoChangeLimit) {
        const intervention = this.intervene(state, sessionId, 'pass-no-change', { operation: call.target, tool: call.name });
        return { code: 'pass-no-change', event: 'repeated-pass', reason: this.reasonText('pass-no-change', intervention, call) };
      }
    }

    // One concrete fix buys at most one re-run of the still-failing check.
    if (call.kind === 'verify' && op.lastOutcome === 'fail' && op.fixedAfterFail && op.sinceFix >= this.thresholds.postFixCheckLimit) {
      const intervention = this.intervene(state, sessionId, 'post-fix-repeat', { operation: call.target, tool: call.name, blocker: op.error });
      return { code: 'post-fix-repeat', event: 'repeated-command', reason: this.reasonText('post-fix-repeat', intervention, call) };
    }

    // The plain budget: the same normalized operation, again and again, with
    // nothing objective in between.
    if (op.sinceProgress >= this.thresholds.repeatLimit) {
      const intervention = this.intervene(state, sessionId, 'repeated-operation', {
        operation: call.target,
        tool: call.name,
        occurrences: op.sinceProgress,
        blocker: op.error
      });
      return { code: 'repeated-operation', event: 'repeated-command', reason: this.reasonText('repeated-operation', intervention, call) };
    }
    return null;
  }

  opFor(state, call, create) {
    let op = state.ops.get(call.signature);
    if (!op && create) {
      op = {
        signature: call.signature,
        kind: call.kind,
        tool: call.name,
        target: call.target,
        attempts: 0,
        sinceProgress: 0,
        sinceFix: 0,
        sincePass: 0,
        firstAt: Date.now(),
        lastAt: 0,
        lastOutcome: null,
        lastDigest: null,
        resultDigest: null,
        passGen: -1,
        passedAt: 0,
        failedAt: 0,
        error: null,
        denied: 0,
        fixedAfterFail: false,
        oneShotAttempt: false,
        tripNext: false
      };
      state.ops.set(call.signature, op);
      state.order.push(call.signature);
      while (state.order.length > this.thresholds.detailsKept * 2) {
        const dropped = state.order.shift();
        const candidate = state.ops.get(dropped);
        if (candidate && candidate.lastAt === 0) state.ops.delete(dropped);
      }
    }
    return op;
  }

  /** Record one settled execution. */
  observeResult(exec, result, durationMs) {
    if (!this.enabled) return;
    try {
      const sessionId = this.sessionKey(exec);
      if (!sessionId) return;
      const state = this.sessions.get(sessionId);
      if (!state) return;
      const call = this.describe(exec);
      const op = this.opFor(state, call, true);
      const outcome = outcomeFor(this.adapterFor(exec), result);
      const previous = op.lastOutcome;
      const now = Date.now();
      op.lastAt = now;
      op.lastOutcome = outcome.ok ? 'pass' : 'fail';
      op.error = outcome.ok ? null : outcome.error;
      op.durationMs = durationMs;
      if (outcome.ok) op.passedAt = now; else op.failedAt = now;
      if (outcome.ok && call.kind === 'verify') {
        op.passGen = state.codeGen;
        op.sincePass = 0;
        if (!state.acceptance.met || state.acceptance.gen !== state.codeGen) {
          state.acceptance = { met: true, at: now, check: call.target, gen: state.codeGen };
          state.auditsAfterAcceptance = 0;
          this.remember(state, { type: 'acceptance-met', code: 'checks-passed', detail: { check: call.target, tool: call.name } });
        }
      }
      if (!outcome.ok) state.lastError = { at: now, signature: call.signature, message: outcome.error, tool: call.name };

      // Objective progress only. Nothing here trusts the model's narration.
      const text = contentText(result);
      const digest = crypto.createHash('sha1').update(text).digest('hex').slice(0, 16);
      const newInformation = call.kind === 'inspect' && op.resultDigest !== null && op.resultDigest !== digest;
      op.resultDigest = digest;
      const progressBefore = state.progressCount;

      if (previous === 'fail' && outcome.ok) {
        this.noteProgress(state, 'check-recovered', call.target + ' now passes');
      } else if (call.writeArgs && outcome.ok && call.writeArgs !== op.lastDigest) {
        this.noteProgress(state, 'file-changed', call.target);
      } else if (outcome.ok && call.kind === 'mutate' && !isBookkeeping(call)) {
        this.noteProgress(state, 'state-changed', call.target);
      } else if (newInformation && outcome.ok) {
        // The data really changed since the last read: a new attempt, not a repeat.
        op.sinceProgress = 0;
        this.remember(state, { type: 'new-information', code: 'inspect', detail: { tool: call.name, operation: call.target } }, 'quiet');
      }
      if (call.writeArgs && outcome.ok) op.lastDigest = call.writeArgs;
      // The one attempt granted by Continue once is spent: if it produced no new
      // result, the next identical repeat is the loop and is stopped at once.
      if (op.oneShotAttempt) {
        op.oneShotAttempt = false;
        if (state.progressCount === progressBefore) op.tripNext = true;
      }
      this.publish(state, 'result');
    } catch (error) {
      this.warn('observeResult failed: ' + (error && error.message));
    }
  }

  /**
   * Objective state change. This is the only thing that counts as progress and
   * the only thing that legitimizes running the same check again.
   */
  noteProgress(state, kind, detail) {
    const now = Date.now();
    state.lastProgressAt = now;
    state.progressCount += 1;
    state.stepsSinceProgress = 0;
    state.lastProgress = { kind, what: String(detail || '').slice(0, 200), at: now };
    const codeChanged = kind === 'file-changed' || kind === 'state-changed';
    if (codeChanged) {
      state.codeGen += 1;
      state.auditsAfterAcceptance = 0;
      state.acceptance = { met: false, at: 0, check: null, gen: -1 };
    }
    for (const op of state.ops.values()) {
      op.sinceProgress = 0;
      op.tripNext = false;
      if (codeChanged) {
        op.sinceFix = 0;
        op.sincePass = 0;
        op.fixedAfterFail = op.lastOutcome === 'fail';
      }
    }
    if (state.phase === 'active' && state.intervention) state.intervention = null;
    this.remember(state, { type: 'progress', code: kind, detail: { what: state.lastProgress.what } }, 'quiet');
  }

  // -- session lifecycle --------------------------------------------------

  observeSession(session, event) {
    if (!this.enabled || !session || !event) return;
    try {
      const sessionId = session.id;
      if (typeof sessionId !== 'string' || !sessionId) return;
      const state = this.state(sessionId, true);
      if (event.type === 'turn/start') {
        state.turn.startedAt = Date.now();
        state.turn.count += 1;
        state.attempts = 0;
        state.stepsSinceProgress = 0;
        state.lastProgressAt = Date.now();
        state.auditsAfterAcceptance = 0;
        // A granted "Continue once" survives the resume turn: the user sends the
        // message, the runtime opens a fresh turn, and the single extra attempt
        // is spent there. Operations themselves start clean with the new turn.
        if (state.oneShot) state.oneShot.turnsSeen += 1;
        state.ops.clear();
        state.order = [];
        state.current = null;
        state.interrupts = [];
        state.pauseReason = null;
        if (state.intervention) {
          // A new turn means the agent moved on; the previous loop stops being
          // a wall, but its offending operation stays blocked until the code
          // actually changes (see decide).
          state.blocked = {
            signature: state.intervention.signature,
            gen: state.intervention.gen,
            problem: state.intervention.problem
          };
          state.intervention = null;
        }
        state.phase = 'active';
        this.clearStopTimer(state);
        this.remember(state, { type: 'turn-start', code: 'turn', detail: { turn: state.turn.count } }, 'quiet');
        this.publish(state, 'turn-start');
        return;
      }
      if (event.type === 'turn/end') {
        state.current = null;
        state.pauseReason = null;
        // A granted attempt that the resumed turn never used lapses with that
        // turn; the user can grant again, but it is not left open indefinitely.
        if (state.oneShot && !state.oneShot.used && state.oneShot.turnsSeen > 0) state.oneShot = null;
        if (state.phase !== 'intervened' && state.phase !== 'finished') state.phase = 'idle';
        this.clearStopTimer(state);
        this.remember(state, { type: 'turn-end', code: 'turn', detail: { turn: state.turn.count } }, 'quiet');
        this.publish(state, 'turn-end');
        return;
      }
      if (event.type === 'user/message') {
        const source = event.data && event.data.source;
        const fromUser = !source || source.kind === 'user' || source.kind === 'client';
        if (!fromUser) return;
        const text = (event.data && Array.isArray(event.data.content) ? event.data.content : [])
          .filter(part => part && part.type === 'text').map(part => part.text).join(' ').trim();
        if (!text) return;
        if (state.phase !== 'active') return;
        if (state.turn.startedAt && Date.now() - state.turn.startedAt < 1500) return; // the prompt that opened this turn
        this.requestUserInterrupt(sessionId, text, null, 'event');
        return;
      }
      if (event.type === 'assistant/message') state.lastAssistantAt = Date.now();
      if (event.type === 'step/start') state.turn.step += 1;
    } catch (error) {
      this.warn('observeSession failed: ' + (error && error.message));
    }
  }

  // -- interventions ------------------------------------------------------

  intervene(state, sessionId, code, detail = {}) {
    const now = Date.now();
    if (state.phase === 'intervened' && state.intervention && state.intervention.code === code) return state.intervention;
    const offending = state.current ? state.current.signature : null;
    const op = offending ? state.ops.get(offending) : null;
    const attempts = detail.occurrences || (op ? op.attempts : state.attempts);
    const intervention = {
      code,
      at: now,
      sessionId,
      gen: state.codeGen,
      operation: detail.operation || (state.current && state.current.target) || '',
      tool: detail.tool || (state.current && state.current.tool) || '',
      attempts,
      problem: problemText(code, { ...detail, occurrences: attempts }, state),
      lastProgress: state.lastProgress ? { what: state.lastProgress.what, at: state.lastProgress.at, kind: state.lastProgress.kind } : null,
      blocker: detail.blocker || (state.lastError && state.lastError.message) || null,
      safeNextAction: nextActionText(code),
      signature: offending
    };
    state.phase = 'intervened';
    state.intervention = intervention;
    state.blocked = null;
    state.denials = 0;
    this.remember(state, { type: eventForCode(code), code, detail: intervention });
    this.clearStopTimer(state);
    // Soft stop first: the in-flight operation is allowed to finish, new calls
    // are denied with a readable reason, and the turn is asked to wrap up.
    state.stopTimer = setTimeout(() => this.enforceStop(sessionId), this.thresholds.graceMs);
    if (state.stopTimer.unref) state.stopTimer.unref();
    this.publish(state, 'intervention', true);
    return intervention;
  }

  /** Grace expired: stop the turn the standard way, but never mid-operation. */
  enforceStop(sessionId) {
    const state = this.sessions.get(sessionId);
    if (!state || state.phase !== 'intervened') return;
    if (state.inFlight > 0) {
      state.stopTimer = setTimeout(() => this.enforceStop(sessionId), this.thresholds.graceMs);
      if (state.stopTimer.unref) state.stopTimer.unref();
      return;
    }
    this.stopTurn(state, 'intervention');
  }

  stopTurn(state, reason) {
    try {
      if (typeof this.cancel === 'function') this.cancel(state.id, reason);
    } catch (error) {
      this.warn('cancel failed: ' + (error && error.message));
    }
    state.stoppedAt = Date.now();
    this.remember(state, { type: 'forced-stop', code: reason, detail: { phase: state.phase } });
    this.publish(state, 'stopped', true);
  }

  clearStopTimer(state) {
    if (state.stopTimer) {
      clearTimeout(state.stopTimer);
      state.stopTimer = null;
    }
  }

  /**
   * A user message arrived while the turn is running. Questions and discussion
   * request a safe pause so the answer is not stuck behind an hour of work; an
   * action keeps its place in the runtime inbox and is only acknowledged.
   */
  requestUserInterrupt(sessionId, text, kind, source) {
    const state = this.state(sessionId, true);
    const mode = kind || classifyUserMessage(text);
    const entry = { at: Date.now(), mode, source: source || 'ui', preview: normalize(text).slice(0, 160) };
    state.interrupts.push(entry);
    this.remember(state, { type: 'user-interrupt', code: 'interrupt', detail: entry });
    if (mode === 'action') {
      this.publish(state, 'interrupt');
      return { received: true, mode, paused: false, message: 'Queued: it runs after the current step finishes.' };
    }
    state.pauseReason = { at: entry.at, mode, text: entry.preview };
    if (state.phase === 'active') state.phase = 'pausing';
    this.publish(state, 'interrupt', true);
    return { received: true, mode, paused: true, message: 'Received. The agent pauses at the next safe point and answers there.' };
  }

  /** Manual controls, all user-initiated from the UI. */
  // -- provider-neutral ingestion -----------------------------------------
  //
  // A runner that is not the bundled DSH runtime uses this one method for
  // everything the supervisor needs: ask before a call, report what happened,
  // announce the life of a session. Codex and future providers get the same
  // budgets through the same code path.
  //
  //   ask    {sessionId, provider, tool:{name, arguments, cwd}}  -> {allow, reason}
  //   result {sessionId, provider, tool:{...}, result:{ok,exitCode}}
  //   phase  {sessionId, provider, type:'turn-start'|'turn-end'|'step-start'|'step-end'|'user-message'}
  observe(input = {}) {
    const provider = String(input.provider || 'generic');
    const kind = String(input.kind || (input.phase || input.type ? 'phase' : input.result !== undefined ? 'result' : 'ask'));
    if (kind === 'phase') {
      const canonical = telemetry.sessionEvent({ provider, sessionId: input.sessionId, type: input.phase || input.type, turn: input.turn, step: input.step, data: input.data || {} });
      return this.observeSession({ id: canonical.sessionId }, { type: canonical.type, data: { turn: canonical.turn, step: canonical.step, message: canonical.data, source: input.source } });
    }
    const exec = { provider, sessionId: input.sessionId, name: input.tool && input.tool.name, arguments: input.tool && input.tool.arguments, parent: input.parent };
    if (kind === 'result') {
      this.observeResult(exec, input.result);
      return { observed: true };
    }
    const reason = this.guard(exec);
    return { allow: !reason, reason: reason || null, signature: this.describe(exec).signature };
  }

  act(sessionId, action, options = {}) {
    // Tuning is not an intervention: it applies to every session at once and
    // never touches the state of the one that happened to be on screen.
    if (action === 'settings') return { accepted: true, resume: null, settings: this.configure(options.patch || options.values || {}) };
    const state = this.state(sessionId, true);
    if (action === 'continue-once') {
      const signature = options.signature || (state.intervention && state.intervention.signature) || state.blocked && state.blocked.signature || (state.current && state.current.signature) || null;
      const op = signature ? state.ops.get(signature) : null;
      if (op) {
        op.attempts = 0;
        op.sinceProgress = 0;
        op.sinceFix = 0;
        op.sincePass = 0;
      }
      state.auditsAfterAcceptance = 0;
      state.acceptance = { met: false, at: 0, check: null, gen: -1 };
      const previous = state.intervention;
      state.phase = 'active';
      state.oneShot = { signature, used: false, expiresAt: Date.now() + 10 * 60 * 1000, turnsSeen: 0 };
      state.intervention = null;
      state.blocked = null;
      this.clearStopTimer(state);
      this.remember(state, { type: 'manual-continue', code: 'continue-once', detail: { signature, operation: previous && previous.operation } });
      this.publish(state, 'continue-once', true);
      return {
        accepted: true,
        oneShot: signature,
        resume: {
          text: 'NODO Supervisor: exactly one additional attempt is allowed for ' +
            ((previous && previous.operation) || 'the blocked operation') +
            '. Change something first if it failed before: a second identical repeat without a new result stops the turn again.'
        }
      };
    }
    if (action === 'stop-task') {
      state.phase = 'finished';
      state.finishRequested = 'stop';
      this.clearStopTimer(state);
      this.remember(state, { type: 'forced-stop', code: 'user-stop', detail: { via: 'ui' } });
      this.stopTurn(state, 'user-stop');
      return { accepted: true, stopped: true };
    }
    if (action === 'finish') {
      state.phase = 'finished';
      state.finishRequested = 'finish';
      this.clearStopTimer(state);
      this.remember(state, { type: 'forced-finish', code: 'finish', detail: { via: 'ui', acceptance: state.acceptance.met } });
      this.stopTurn(state, 'finish');
      return { accepted: true, finished: true, acceptance: state.acceptance, lastProgress: state.lastProgress };
    }
    if (action === 'acknowledge-interrupt') {
      state.pauseReason = null;
      if (state.phase === 'pausing') state.phase = 'active';
      this.remember(state, { type: 'user-interrupt-acknowledged', code: 'interrupt' }, 'quiet');
      this.publish(state, 'interrupt');
      return { accepted: true };
    }
    if (action === 'thresholds') return { accepted: false, thresholds: this.thresholds, note: 'Thresholds are configuration; v1 keeps the documented defaults.' };
    throw new Error('Unknown supervisor action: ' + action);
  }

  /**
   * Ask the auxiliary verifier whether a stalled turn is really stalled.
   * Telemetry only: counters, tool names, timings, error codes. No prompt, no
   * file content, no path, no message text can leave here.
   */
  verifierConsults(state) {
    if (!this.verifier || !this.verifier.available) return null;
    state.verifierConsults = state.verifierConsults || 0;
    if (state.verifierConsults >= 2) return null;
    state.verifierConsults += 1;
    const telemetry = {
      event: 'no-progress',
      sessionAgeMs: Date.now() - (state.turn.startedAt || state.createdAt),
      sinceLastProgressMs: Date.now() - state.lastProgressAt,
      steps: state.turn.step,
      tools: [...new Set(state.order.slice(-6).map(signature => (state.ops.get(signature) || {}).tool).filter(Boolean))],
      kinds: [...state.ops.values()].slice(-6).map(op => ({ kind: op.kind, executions: op.executions, outcome: op.lastOutcome, failed: !!op.error })),
      inFlight: state.inFlight
    };
    return Promise.resolve()
      .then(() => this.verifier.ask('is-this-progress', telemetry))
      .then(answer => {
        const confident = answer && Number(answer.confidence) >= 0.6 && /progress|прогресс|работает|moving/i.test(String(answer.answer));
        if (confident) {
          state.lastProgressAt = Date.now();
          this.remember(state, { type: 'new-information', code: 'verifier', detail: { answer: String(answer.answer).slice(0, 160), confidence: Number(answer.confidence) || 0 } });
          this.publish(state, 'verifier');
          return;
        }
        this.intervene(state, state.id, 'no-progress', { verified: true });
      })
      .catch(() => this.intervene(state, state.id, 'no-progress', {}));
  }

  /** Periodic accounting: no objective progress in a running turn, stale sessions. */
  tick() {
    if (!this.enabled) return;
    const now = Date.now();
    for (const state of this.sessions.values()) {
      try {
        if (state.phase !== 'active' && state.phase !== 'pausing') continue;
        if (state.inFlight > 0 && now - state.inFlightSince > this.thresholds.stepWarnMs) {
          this.intervene(state, state.id, 'long-step', { tool: state.inFlightTool, operation: state.current && state.current.target });
          continue;
        }
        if (state.inFlight === 0 && now - state.lastProgressAt > this.thresholds.noProgressMs) {
          // The mechanical clock only knows that nothing changed. When an
          // auxiliary model is available the supervisor may ask it one bounded
          // question about anonymous telemetry - and only to be more careful:
          // the answer can delay this intervention, never authorize anything.
          const consult = this.verifierConsults(state);
          if (consult) { consult.catch(() => this.intervene(state, state.id, 'no-progress', {})); continue; }
          this.intervene(state, state.id, 'no-progress', {});
        }
      } catch (error) {
        this.warn('tick failed: ' + (error && error.message));
      }
    }
    const cutoff = now - 6 * 60 * 60 * 1000;
    for (const [id, state] of this.sessions) {
      if (state.phase === 'idle' && !state.intervention && state.updatedAt < cutoff) this.sessions.delete(id);
    }
  }

  start() {
    if (this.timer || !this.enabled) return this;
    this.timer = setInterval(() => this.tick(), this.thresholds.tickMs);
    if (this.timer.unref) this.timer.unref();
    return this;
  }

  // -- reporting ----------------------------------------------------------

  // -- settings -----------------------------------------------------------

  settings() {
    const values = {};
    for (const key of TUNABLE_KEYS) values[key] = this.thresholds[key];
    return { values, defaults: Object.fromEntries(TUNABLE_KEYS.map(key => [key, DEFAULTS[key]])), bounds: TUNABLE, file: this.settingsFile };
  }

  /** Apply a validated tuning patch. Nothing is written when anything is invalid. */
  configure(patch = {}) {
    const values = {}, rejected = {};
    for (const [key, raw] of Object.entries(patch || {})) {
      if (!TUNABLE_KEYS.includes(key)) { rejected[key] = 'unknown threshold'; continue; }
      const value = Number(raw);
      if (!Number.isFinite(value)) { rejected[key] = 'not a number'; continue; }
      const rounded = Math.round(value);
      if (rounded < TUNABLE[key].min || rounded > TUNABLE[key].max) { rejected[key] = 'outside ' + TUNABLE[key].min + '..' + TUNABLE[key].max; continue; }
      values[key] = rounded;
    }
    if (Object.keys(rejected).length || !Object.keys(values).length) return { accepted: false, rejected, settings: this.settings() };
    Object.assign(this.thresholds, values);
    try {
      fs.mkdirSync(path.dirname(this.settingsFile), { recursive: true, mode: 0o700 });
      const tmp = this.settingsFile + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ ...readSettings(this.settingsFile), ...values }, null, 1), { mode: 0o600 });
      fs.renameSync(tmp, this.settingsFile);
    } catch (error) {
      this.warn('settings not saved: ' + (error && error.message));
    }
    this.remember(this.state('settings', true), { type: 'settings', code: 'thresholds', detail: values });
    return { accepted: true, values, settings: this.settings() };
  }

  status(sessionId) {
    const list = [];
    for (const state of this.sessions.values()) {
      if (sessionId && state.id !== sessionId) continue;
      list.push(this.statusOf(state));
    }
    list.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    const active = list.find(item => item.active) || null;
    return { version: VERSION, active: active || list[0] || null, sessions: list.slice(0, 8), card: this.card(sessionId || (active && active.sessionId)) };
  }

  statusOf(state) {
    const now = Date.now();
    return {
      version: VERSION,
      sessionId: state.id,
      phase: state.phase,
      active: state.phase === 'active' || state.phase === 'pausing',
      heartbeat: {
        working: workingText(state),
        progress: state.lastProgress ? state.lastProgress.what : 'no objective change yet',
        next: nextStepText(state),
        elapsedMs: state.turn.startedAt ? now - state.turn.startedAt : 0,
        sinceProgressMs: now - state.lastProgressAt,
        updatedAt: state.updatedAt
      },
      attempts: state.attempts,
      stepsSinceProgress: state.stepsSinceProgress,
      toolCalls: state.order.length,
      inFlight: state.inFlight,
      acceptance: state.acceptance.met
        ? { met: true, at: state.acceptance.at, check: state.acceptance.check, holds: state.acceptance.gen === state.codeGen }
        : { met: false },
      intervention: state.intervention,
      blocked: state.blocked || null,
      interrupts: state.interrupts.slice(-3),
      pauseReason: state.pauseReason || null,
      oneShot: state.oneShot ? { available: !state.oneShot.used, signature: state.oneShot.signature } : null,
      thresholds: this.thresholds,
      updatedAt: state.updatedAt
    };
  }

  events(options = {}) {
    const limit = Math.min(Math.max(Number(options.limit) || 40, 1), 200);
    const source = options.sessionId ? this.eventsOf(options.sessionId) : this.history;
    return { version: VERSION, events: source.slice(-limit).reverse(), file: this.logFile };
  }

  eventsOf(sessionId) {
    const state = this.sessions.get(sessionId);
    return state ? state.events : [];
  }

  /** The human card: exactly what the UI shows on an intervention. */
  card(sessionId) {
    if (!sessionId) return null;
    const state = this.sessions.get(sessionId);
    if (!state) return null;
    if (!state.intervention && state.phase !== 'finished') return null;
    const source = state.intervention || {
      code: 'finished',
      at: state.stoppedAt || Date.now(),
      problem: 'The turn was finished on request.',
      attempts: state.attempts,
      lastProgress: state.lastProgress,
      safeNextAction: 'Review the result and continue only if the user asks for it.'
    };
    return {
      title: source.code === 'finished' ? 'Supervisor finished the turn' : 'Supervisor stopped a loop',
      code: source.code,
      sessionId: state.id,
      phase: state.phase,
      reason: source.problem,
      lastProgress: source.lastProgress ? source.lastProgress.what : 'none recorded',
      attempts: source.attempts,
      blocker: source.blocker || null,
      safeNextAction: source.safeNextAction || null,
      operation: source.operation || null,
      signature: source.signature || null,
      at: source.at
    };
  }

  reasonText(code, intervention, call) {
    const attempts = intervention && intervention.attempts ? intervention.attempts : 0;
    const last = intervention && intervention.lastProgress ? intervention.lastProgress.what : 'none recorded';
    const head = 'NODO Supervisor stopped a loop: ' + problemText(code, { operation: call.target, tool: call.name, occurrences: attempts }, null) + '.';
    const facts = ' Attempts: ' + attempts + '. Last real progress: ' + last +
      (intervention && intervention.blocker ? '. Current blocker: ' + String(intervention.blocker).slice(0, 200) : '') + '.';
    const tail = ' Do not repeat this operation: nothing changed since the last run. Finish the turn and report what is done, what is blocked and the safe next step.';
    return head + facts + tail;
  }

  pauseText(state) {
    const pending = state.pauseReason;
    return 'NODO Supervisor: the user sent a message while this turn is running' +
      (pending && pending.text ? ' ("' + pending.text + '")' : '') +
      '. Stop starting new work now, finish the current step and answer it.';
  }

  // -- plumbing -----------------------------------------------------------

  remember(state, event, level) {
    const entry = { at: Date.now(), sessionId: state.id, level: level === 'quiet' ? 'quiet' : 'notice', ...event };
    state.events.push(entry);
    while (state.events.length > this.thresholds.eventsKept) state.events.shift();
    state.updatedAt = entry.at;
    if (entry.level === 'notice') {
      this.history.push(entry);
      while (this.history.length > this.thresholds.historyKept) this.history.shift();
      this.append(entry);
    }
    this.schedulePersist();
  }

  append(entry) {
    try {
      fs.mkdirSync(path.dirname(this.logFile), { recursive: true, mode: 0o700 });
      fs.appendFileSync(this.logFile, JSON.stringify(entry) + '\n', { mode: 0o600 });
    } catch (error) {
      if (!this.logWriteFailed) {
        this.logWriteFailed = true;
        this.warn('event log unavailable: ' + (error && error.message));
      }
    }
  }

  publish(state, reason, force) {
    this.schedulePersist();
    state.lastPublishAt = state.lastPublishAt || 0;
    if (!force && this.bridge && Date.now() - state.lastPublishAt < this.thresholds.publishMs) return;
    state.lastPublishAt = Date.now();
    if (!this.bridge) return;
    try {
      Promise.resolve(this.bridge('supervisor.backend', {
        action: 'state',
        reason,
        status: this.statusOf(state),
        card: this.card(state.id)
      })).catch(() => {});
    } catch {
      /* the UI bridge is optional; supervision itself never depends on it */
    }
  }

  warn(message) {
    if (this.logger && typeof this.logger.warn === 'function') this.logger.warn('supervisor: ' + message);
  }

  dispose() {
    if (this.persistTimer) { clearTimeout(this.persistTimer); this.persistTimer = null; }
    this.save();
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const state of this.sessions.values()) this.clearStopTimer(state);
  }
}

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

function eventForCode(code) {
  switch (code) {
    case 'repeated-operation': return 'repeated-command';
    case 'post-fix-repeat': return 'repeated-command';
    case 'pass-no-change': return 'repeated-pass';
    case 'no-progress': return 'no-progress-timeout';
    case 'long-step': return 'no-progress-timeout';
    case 'success-stop': return 'success-stop';
    default: return 'loop-detected';
  }
}

function problemText(code, detail, state) {
  const operation = normalize((detail && (detail.operation || detail.tool)) || '').slice(0, 140);
  switch (code) {
    case 'repeated-operation':
      return 'the same operation ran ' + (detail.occurrences || 0) + ' times without a new result' + (operation ? ': ' + operation : '');
    case 'post-fix-repeat':
      return 'the same still-failing check was re-run after a fix without a new fix' + (operation ? ': ' + operation : '');
    case 'pass-no-change':
      return 'a check that already passed was about to run again with no related code change' + (operation ? ': ' + operation : '');
    case 'no-progress':
      return 'no objective progress for ' + Math.round((state ? Date.now() - state.lastProgressAt : 0) / 60000) + ' minutes';
    case 'long-step':
      return 'one step has been running for more than ' + Math.round((state ? Date.now() - state.lastProgressAt : 0) / 60000) + ' minutes without a result';
    case 'success-stop':
      return 'acceptance checks already passed and only optional extra tests or audits were being added';
    case 'finished':
      return 'the turn was finished on request';
    default:
      return 'a repeated operation without new progress' + (operation ? ': ' + operation : '');
  }
}

function nextActionText(code) {
  switch (code) {
    case 'repeated-operation':
      return 'Use the result already produced. If the operation failed, change the related code or the input before running it again; otherwise report the blocker and stop.';
    case 'post-fix-repeat':
      return 'Read the failure output, make one concrete change in the related code, then re-run the check once.';
    case 'pass-no-change':
      return 'The check already passed; finish the turn and report the result instead of re-running it.';
    case 'no-progress':
    case 'long-step':
      return 'Report the current state: what is done, what is stuck, and what you need to continue.';
    case 'success-stop':
      return 'Acceptance checks passed; finish the turn and report the result.';
    default:
      return 'Stop repeating the operation and report the current state.';
  }
}

function workingText(state) {
  if (state.inFlight > 0 && state.inFlightTool) return state.inFlightTool + (state.current ? ': ' + state.current.target : '');
  if (state.current) return state.current.tool + ': ' + state.current.target;
  return 'waiting for the model';
}

function nextStepText(state) {
  if (state.acceptance.met && state.acceptance.gen === state.codeGen) return 'finish the turn and report the result';
  const current = state.current;
  if (!current) return 'continue the current step';
  if (current.kind === 'verify') return 'read the result; on failure change the code, then re-run once';
  if (current.kind === 'mutate') return 'verify the change once';
  if (current.kind === 'inspect') return 'act on what was read';
  return 'continue the current step';
}

/** Provider-neutral outcome: an adapter maps whatever a runner returned. */
function outcomeFor(adapter, result) {
  const shaped = adapter && typeof adapter.outcome === 'function' ? adapter.outcome(result) : null;
  if (!shaped) return outcomeOf(result);
  const exit = shaped.exitCode;
  const failed = shaped.ok === false || shaped.timedOut === true || (Number.isFinite(exit) && exit !== 0) || !!shaped.error;
  return {
    ok: !failed,
    timedOut: !!shaped.timedOut,
    exitCode: Number.isFinite(exit) ? exit : null,
    error: shaped.error || (failed ? firstLine(contentText(result)) || 'tool reported a failure' : null)
  };
}

function outcomeOf(result) {
  if (!result) return { ok: true };
  if (result.isError) return { ok: false, error: errorSignature(result) };
  const value = result.value;
  if (value && typeof value === 'object') {
    if (value.timedOut) return { ok: false, error: 'timed out' };
    if (typeof value.exitCode === 'number' && value.exitCode !== 0) {
      return { ok: false, error: 'exit ' + value.exitCode + ' ' + firstLine(textOf(value.stderr) || textOf(value.stdout)) };
    }
  }
  const content = contentText(result);
  const marker = /\[exit code:\s*(\d+)\]/.exec(content);
  if (marker && marker[1] !== '0') return { ok: false, error: 'exit ' + marker[1] + ' ' + firstLine(content) };
  return { ok: true };
}

function errorSignature(result) {
  const failure = result && result.error ? result.error : {};
  const name = failure.name || failure.code || 'error';
  return String(name) + ': ' + firstLine(failure.message || contentText(result)).slice(0, 160);
}

function firstLine(text) {
  return normalize(String(text || '').split('\n').find(line => line.trim()) || '').slice(0, 160);
}

function contentText(result) {
  const content = result && Array.isArray(result.content) ? result.content : [];
  return content.filter(block => block && block.type === 'text').map(block => block.text).join('\n');
}

function textOf(stream) {
  return stream && typeof stream === 'object' && typeof stream.text === 'string' ? stream.text : '';
}

const QUESTION_RE = /(^\s*(?:что|кто|где|когда|почему|зачем|как|какой|какая|какие|сколько|можно|нужно ли|стоит ли|есть ли|будет ли|объясни|расскажи|поясни|подскажи|сравни)(?![\p{L}\p{N}_-])|^\s*(?:what|who|where|when|why|how|which|can|could|should|would|is|are|do|does|did|explain|tell me|compare)(?![\p{L}\p{N}_-])|\?\s*$)/iu;
const DISCUSSION_RE = /(мнение|думаешь|считаешь|обсуди|обсудим|предложи|варианты|opinion|thoughts|discuss|propose|options)/i;

/**
 * Mechanical first pass at QUESTION/DISCUSSION versus ACTION. Only a fallback:
 * the Auxiliary Verifier may refine it later, never the other way round.
 */
function classifyUserMessage(text) {
  const value = String(text || '').trim();
  if (!value) return 'action';
  // A '?' inside a URL or query string is not a question mark.
  if (/\?(?=\s|$)/.test(value) || QUESTION_RE.test(value)) return 'question';
  if (DISCUSSION_RE.test(value)) return 'discussion';
  return 'action';
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

/**
 * Install the supervisor into one harness context.
 * @param ctx - plugin context with tools, agents and sessionController.
 * @param options - bridge (host callback), logger, thresholds, dataDir, cancel, enabled.
 */
function installSupervisor(ctx, options = {}) {
  const cancel = options.cancel || (ctx.sessionController && typeof ctx.sessionController.cancel === 'function'
    ? (sessionId) => ctx.sessionController.cancel({ sessionId })
    : null);
  const supervisor = new Supervisor({ ...options, cancel });

  // The single mechanical gate. Denying here never runs a tool body, so an
  // atomic filesystem or update operation is never cut in half.
  const disposeGuard = ctx.tools.guard(exec => supervisor.guard(exec));

  const disposeExecute = ctx.on('tools/execute', async (exec, next) => {
    const sessionId = supervisor.sessionKey(exec);
    const state = sessionId ? supervisor.state(sessionId, true) : null;
    const counted = !!state && !exec.parent;
    if (counted) {
      state.inFlight += 1;
      state.inFlightSince = Date.now();
      state.inFlightTool = exec.name;
    }
    const started = Date.now();
    try {
      const result = await next();
      supervisor.observeResult(exec, result, Date.now() - started);
      return result;
    } catch (error) {
      supervisor.observeResult(exec, { isError: true, error: { name: 'thrown', code: 'THROWN', message: error && error.message }, content: [] }, Date.now() - started);
      throw error;
    } finally {
      if (counted) {
        state.inFlight = Math.max(0, state.inFlight - 1);
        if (state.inFlight === 0) state.inFlightTool = null;
      }
    }
  });

  const disposeEvents = ctx.on('session/event', (session, event) => supervisor.observeSession(session, event));
  supervisor.start();

  const agentRunning = sessionId => {
    try {
      return ctx.agents && typeof ctx.agents.get === 'function' && ctx.agents.get(sessionId)?.status === 'running';
    } catch {
      return false;
    }
  };

  return {
    supervisor,
    status: params => supervisor.status(params && params.sessionId),
    events: params => supervisor.events(params || {}),
    card: params => supervisor.card(params && params.sessionId),
    settings: () => supervisor.settings(),
    act: (params = {}) => {
      // Tuning applies to every session and needs no open one.
      if (params.action === 'settings') return supervisor.act('settings', 'settings', params);
      if (typeof params.sessionId !== 'string' || !params.sessionId) throw Error('sessionId required');
      return supervisor.act(params.sessionId, params.action, params);
    },
    userMessage: (params = {}) => {
      const sessionId = params.sessionId;
      if (typeof sessionId !== 'string' || !sessionId) throw Error('sessionId required');
      const state = supervisor.sessions.get(sessionId) || supervisor.state(sessionId, true);
      const running = state.phase === 'active' || state.phase === 'pausing' || agentRunning(sessionId);
      if (!running) return { received: false, running: false };
      const result = supervisor.requestUserInterrupt(sessionId, params.text, params.kind, params.source || 'ui');
      return { ...result, running: true };
    },
    dispose: () => {
      disposeGuard();
      disposeExecute();
      disposeEvents();
      supervisor.dispose();
    }
  };
}

module.exports = {
  installSupervisor,
  analyzeCommand,
  unwrapCommand,
  outcomeFor,
  telemetry,
  AuxiliaryVerifier,
  anonymize,
  splitSegments,
  isBookkeeping,
  Supervisor,
  AuxiliaryVerifier,
  anonymize,
  classify,
  classifyUserMessage,
  normalize,
  normalizePath,
  trimCdPrefix,
  outcomeOf,
  DEFAULTS,
  VERSION
};
