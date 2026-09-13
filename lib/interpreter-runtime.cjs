'use strict';
// ---------------------------------------------------------------------------
// Wiring for the Interpreter inside the NODO plugin process.
//
// FROM STAS: a long dictated user message gets a compiled brief injected as an
// ephemeral reference message. The user's own message is never modified, never
// replaced and never hidden.
// TO STAS: the last assistant answer of a session is kept so the client can show
// the human version with the untouched original one click away.
// RULES: proposals only. Saving happens through the project brain, after the
// user pressed Save all, and never from here.
// ---------------------------------------------------------------------------

const fs = require('node:fs');
const path = require('node:path');
const { Interpreter, RULE_SCOPES } = require('./interpreter.cjs');
const { AuxiliaryProvider } = require('./auxiliary.cjs');

function textOf(message) {
  const parts = message && Array.isArray(message.content) ? message.content : [];
  return parts
    .filter(part => part && part.type === 'text' && typeof part.text === 'string')
    .map(part => part.text)
    .join('\n')
    .trim();
}

function userTextOf(message) {
  const source = message && message.source;
  if (source && source.kind && source.kind !== 'user') return '';
  return textOf(message);
}

/** Rules are stored as one sentence: the brain keeps text, scope and priority. */
function ruleText(rule) {
  const parts = [String(rule.text || '').trim()];
  if (rule.when && !parts[0].includes(rule.when)) parts.push('Когда: ' + String(rule.when).trim());
  if (rule.exceptions) parts.push('Исключения: ' + String(rule.exceptions).trim());
  return parts.filter(Boolean).join(' ').slice(0, 4000);
}

function installInterpreter(ctx, options = {}) {
  const dataDir = options.dataDir || process.env.NODO_DATA || path.join(require('node:os').tmpdir(), 'nodo-interpreter');
  const createUserMessage = options.createUserMessage;
  const projectCall = typeof options.projectCall === 'function' ? options.projectCall : null;
  const logger = options.logger || null;
  const settingsFile = path.join(dataDir, 'interpreter-settings.json');

  const readSettings = () => {
    try {
      return JSON.parse(fs.readFileSync(settingsFile, 'utf8')) || {};
    } catch {
      return {};
    }
  };

  const auxiliary = options.auxiliary || new AuxiliaryProvider({
    dataDir,
    endpoint: process.env.NODO_AUX_ENDPOINT || process.env.NODO_AUX_VERIFIER_ENDPOINT,
    model: process.env.NODO_AUX_MODEL || process.env.NODO_AUX_VERIFIER_MODEL
  });
  const interpreter = new Interpreter({ auxiliary, logger, settings: readSettings() });

  const compiled = new Map();   // sessionId -> {source, result}
  const briefs = new Map();     // sessionId -> last brief record
  const answers = new Map();    // sessionId -> {text, at, turn, ended}
  const responses = new Map();  // cache key -> response
  const proposals = new Map();  // sessionId -> proposed rules

  const persistSettings = () => {
    try {
      fs.mkdirSync(path.dirname(settingsFile), { recursive: true, mode: 0o700 });
      fs.writeFileSync(settingsFile + '.tmp', JSON.stringify(interpreter.settings, null, 1), { mode: 0o600 });
      fs.renameSync(settingsFile + '.tmp', settingsFile);
    } catch (error) {
      if (logger) logger.warn('interpreter settings not saved: ' + (error && error.message));
    }
  };

  // -- FROM STAS ------------------------------------------------------------
  const disposeStep = createUserMessage ? ctx.on('agent/pre-step', async ({ agent, messages }, next) => {
    const decision = await next();
    if (!decision || decision.kind === 'reject') return decision;
    try {
      if (!interpreter.settings.briefInjection) return decision;
      const sessionId = agent && agent.session && agent.session.id;
      const user = [...(messages || [])].reverse().find(message => userTextOf(message));
      if (!user || !sessionId) return decision;
      const text = userTextOf(user);
      if (text.length < 40) return decision;
      const cacheKey = sessionId + '\u0000' + text.length + '\u0000' + text.slice(0, 200);
      let result = compiled.get(cacheKey);
      if (!result) {
        result = await interpreter.fromUser({ text });
        compiled.set(cacheKey, result);
        while (compiled.size > 40) compiled.delete(compiled.keys().next().value);
        briefs.set(sessionId, { mode: result.mode, intent: result.intent, brief: result.brief, source: text, at: Date.now(), signals: result.signals || [], reason: result.reason || null });
      }
      if (result.mode === 'original' || !result.brief) return decision;
      const message = createUserMessage({
        source: { kind: 'plugin', plugin: 'nodo-interpreter', form: 'recall' },
        content: [{ type: 'text', text: interpreter.text(result.brief, text) }]
      });
      return { ...decision, messages: [...decision.messages, message] };
    } catch (error) {
      // The interpreter is optional: a failure here must never block the turn.
      if (logger) logger.warn('interpreter pre-step skipped: ' + (error && error.message));
      return decision;
    }
  }) : () => {};

  // -- TO STAS --------------------------------------------------------------
  const disposeEvents = ctx.on('session/event', (session, event) => {
    try {
      const sessionId = session && session.id;
      if (!sessionId || !event) return;
      if (event.type === 'assistant/message') {
        const text = textOf(event.data && event.data.message) || String((event.data && event.data.text) || '').trim();
        if (text) answers.set(sessionId, { text, at: Date.now(), turn: event.data && event.data.turn, ended: false });
        return;
      }
      if (event.type === 'turn/end') {
        const current = answers.get(sessionId);
        if (current) answers.set(sessionId, { ...current, ended: true, endedAt: Date.now() });
        return;
      }
      if (event.type === 'turn/start') {
        // A new turn is a new answer: the previous card stays until it arrives.
        const current = answers.get(sessionId);
        if (current) answers.set(sessionId, { ...current, ended: true });
      }
    } catch (error) {
      if (logger) logger.warn('interpreter event skipped: ' + (error && error.message));
    }
  });

  const response = async (sessionId, mode, refine) => {
    const answer = answers.get(sessionId);
    if (!answer) return { mode: 'TECHNICAL', human: null, technical: '', shortAnswer: true, at: 0 };
    const key = [sessionId, mode || '', answer.at, refine ? 'r' : 'm'].join('|');
    if (responses.has(key)) return responses.get(key);
    let value;
    if (refine && auxiliary.available && answer.text.length > 800) value = await interpreter.refine({ text: answer.text, mode });
    else value = interpreter.toUser({ text: answer.text, mode });
    value = { ...value, at: answer.at, ended: !!answer.ended };
    responses.set(key, value);
    while (responses.size > 40) responses.delete(responses.keys().next().value);
    return value;
  };

  return {
    interpreter,
    auxiliary,
    brief(sessionId) {
      const record = briefs.get(sessionId);
      if (!record) return { mode: 'original', brief: null, source: '', at: 0, intent: null, signals: [], reason: 'no message compiled yet' };
      return record;
    },
    response,
    status() {
      const base = interpreter.status();
      return { ...base, settings: { ...base.settings }, sessions: { briefs: briefs.size, answers: answers.size } };
    },
    configure(patch = {}) {
      const settings = interpreter.configure(patch);
      persistSettings();
      return { settings };
    },
    async propose(p = {}) {
      const key = String(p.sessionId || 'default');
      const previous = p.correction ? proposals.get(key) || [] : null;
      const proposal = await interpreter.compileRules({ text: p.text, previous, correction: p.correction || null });
      proposals.set(key, proposal.rules || []);
      return { ...proposal, sessionId: key };
    },
    /** Only an explicit Save all reaches this. */
    async save(p = {}) {
      if (!projectCall) return { saved: 0, ids: [], rejected: [{ reason: 'project storage is not wired' }] };
      const rules = Array.isArray(p.rules) ? p.rules.slice(0, 40) : [];
      if (!rules.length) return { saved: 0, ids: [], rejected: [] };
      let existing = [];
      try {
        const listed = await projectCall({ action: 'list', sessionId: p.sessionId });
        existing = (listed && Array.isArray(listed.rules) ? listed.rules : []).map(rule => String(rule.text || '').replace(/\s+/g, ' ').trim().toLowerCase());
      } catch {
        existing = [];
      }
      const ids = [], rejected = [];
      for (const rule of rules) {
        const text = ruleText(rule);
        if (!text) { rejected.push({ rule: rule && rule.text, reason: 'empty rule' }); continue; }
        if (existing.includes(text.replace(/\s+/g, ' ').trim().toLowerCase())) { rejected.push({ rule: rule && rule.text, reason: 'already saved' }); continue; }
        try {
          const item = await projectCall({
            action: 'save',
            sessionId: p.sessionId,
            kind: 'rules',
            text,
            scope: RULE_SCOPES.includes(rule.scope) ? rule.scope : 'Project',
            enabled: true,
            priority: Math.max(0, Math.min(100, Math.round(Number(rule.priority) || 60))),
            source: 'NODO Interpreter: "' + String(rule.source || rule.text || '').slice(0, 200) + '"'
          });
          if (item && item.id) ids.push(item.id);
        } catch (error) {
          rejected.push({ rule: rule && rule.text, reason: (error && error.message) || 'save failed' });
        }
      }
      if (ids.length) proposals.delete(String(p.sessionId || 'default'));
      return { saved: ids.length, ids, rejected };
    },
    dispose() {
      disposeStep();
      disposeEvents();
    }
  };
}

module.exports = { installInterpreter, textOf, userTextOf, ruleText };
