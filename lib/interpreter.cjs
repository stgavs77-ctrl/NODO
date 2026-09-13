'use strict';
// ---------------------------------------------------------------------------
// NODO Interpreter: one engine, three modes.
//
//   FROM STAS  - a long dictated message becomes a compact, source-mapped brief
//   TO STAS    - a technical answer becomes a human answer, original kept
//   RULES      - free speech becomes proposed project rules, nothing saved
//
// The engine is mechanical first. It never invents a requirement, never turns a
// failure into a success, and never replaces the user's own words: when the
// auxiliary model is missing, slow, or produces something that does not check
// out, the original input is used unchanged.
// ---------------------------------------------------------------------------

const crypto = require('node:crypto');
const { classifyUserMessage } = require('./supervisor.cjs');

const RULE_SCOPES = ['Project', 'Browser', 'Files', 'REAPER', 'Telegram', 'Coding'];

// NB: JavaScript \b is ASCII-only, so a Cyrillic alternative never matches
// with it. Every pattern therefore ends with an explicit "not a letter" lookahead
// and carries the u flag.
const NOT_LETTER = '(?![\\p{L}\\p{N}_])';
const IMPERATIVE_RE = new RegExp('(?:^|[^\\p{L}\\p{N}_])(?:сделай|сделать|добавь|добавить|исправь|исправить|проверь|проверить|запусти|запустить|собери|собрать|перепиши|переписать|обнови|обновить|удали|удалить|перенеси|настрой|реализуй|реализовать|почини|не забудь|нужно|надо|требуется|должен|должна|должно|must|should|need to|add|fix|check|run|build|update|implement|make sure|ensure|refactor)' + NOT_LETTER, 'iu');
const PROHIBITION_RE = new RegExp('(?:не делай|не трогай|не надо|не добавляй|не меняй|не используй|не забудь|без |нельзя|запрещ|do not|don\'t|never|without|avoid|must not)' + NOT_LETTER, 'iu');
const CRITERIA_RE = new RegExp('(?:критери\\p{L}*|готово когда|считается готов|тест[ыа]?\\s+(?:проход|должн)|должно работать|работает без|acceptance|definition of done|passes|зелён|зелен|exit code 0)' + NOT_LETTER, 'iu');
const AMBIGUITY_RE = new RegExp('(?:неясно|непонятно|уточни|возможно|наверное|или же|не уверен|уточним|unclear|maybe|not sure|ambiguous)' + NOT_LETTER, 'iu');
const CONDITION_RE = new RegExp('(?:только (?:когда|если|перед|после|для)|перед |после |при |если |когда |only when|before|after|unless|when )', 'iu');
const PERMISSION_RE = new RegExp('(?:можно|разрешено|допустимо|нельзя|только|except|allowed|permitted|only)' + NOT_LETTER, 'iu');
const FILLER_RE = new RegExp('(?:^|\\s)(?:ну|короче|такое|в общем|типа|значит|во-первых|во-вторых|как бы|это самое|блин|так вот|смотри)' + NOT_LETTER, 'giu');

const FAIL_RE = new RegExp('(?:^|[^\\p{L}\\p{N}_])(?:error|failed|failure|blocked|blocker|cannot|can\'t|не удалось|ошибка|заблокирован|провал|не работает|fail|exit code [1-9]|exit=[1-9]|\\b[1-9]\\d*\\s+failed)', 'iu');
const PARTIAL_RE = new RegExp('(?:частично|partial|не завершен|не закончен|not finished|incomplete|осталось|remaining|предстоит|TODO)' + NOT_LETTER, 'iu');
const DONE_RE = new RegExp('(?:готово|завершено|выполнено|сделано|done|completed|passed|успешно|зелён|зелен)' + NOT_LETTER, 'iu');
const REMAIN_RE = new RegExp('(?:осталось|остаётся|remaining|next step|дальше|предстоит|TODO|не сделано)' + NOT_LETTER, 'iu');
const NEED_RE = new RegExp('(?:нужно от тебя|нужен доступ|нужно решение|нужна команда|подтверди|разреши|approve|confirm|waiting for you|требуется от тебя)' + NOT_LETTER, 'iu');
const BLOCKER_RE = new RegExp('(?:blocker|заблокир|не могу продолжить|cannot proceed|без .{0,30} невозможно|тупик)' + NOT_LETTER, 'iu');

const DEFAULT_SETTINGS = {
  compile: 'auto',
  responseMode: 'NORMAL',
  longChars: 1200,
  veryLongChars: 2600,
  minChars: 240,
  briefInjection: true
};

// ---------------------------------------------------------------------------
// Mechanical helpers. Everything here is deterministic and quote-grounded.
// ---------------------------------------------------------------------------

function sentences(text) {
  return String(text || '')
    .split(/\n+|(?<=[.!?;])\s+(?=[A-ZА-ЯЁ"«(\d])/)
    .map(line => line.replace(/^\s*(?:[-*•—–]|\d+[.)])\s*/, '').trim())
    .filter(line => line.length >= 12);
}

function words(text) {
  return String(text || '').toLowerCase().match(/[\p{L}\p{N}_-]{3,}/gu) || [];
}

function jaccard(a, b) {
  const left = new Set(words(a)), right = new Set(words(b));
  if (!left.size || !right.size) return 0;
  let shared = 0;
  for (const word of left) if (right.has(word)) shared += 1;
  return shared / (left.size + right.size - shared);
}

function normalizeForMatch(text) {
  return String(text || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/** A quote is only a source when it really appears in what the user wrote. */
function grounded(quote, source) {
  const needle = normalizeForMatch(quote).replace(/[«»"'`]/g, '');
  if (needle.length < 8) return false;
  const haystack = normalizeForMatch(source).replace(/[«»"'`]/g, '');
  return haystack.includes(needle) || haystack.includes(needle.slice(0, Math.max(8, Math.floor(needle.length * 0.8))));
}

function detectIntent(text) {
  return classifyUserMessage(text);
}

/** Deterministic trigger: a threshold alone never decides. */
function analyze(text, settings = {}) {
  const value = String(text || '');
  const chars = value.length;
  const signals = [];
  const words_ = (value.match(/\S+/g) || []).length;
  if (chars >= (settings.veryLongChars || DEFAULT_SETTINGS.veryLongChars)) signals.push('very-long');
  else if (chars >= (settings.longChars || DEFAULT_SETTINGS.longChars)) signals.push('long');
  if (words_ >= 200) signals.push('many-words');
  const imperative = (value.match(new RegExp(IMPERATIVE_RE.source, 'giu')) || []).length;
  if (imperative >= 3) signals.push('many-requirements');
  const enumerated = (value.match(/^\s*(?:[-*•—–]|\d+[.)])\s+/gm) || []).length;
  if (enumerated >= 3) signals.push('enumerated');
  if ((value.match(/\n\s*\n/g) || []).length >= 2) signals.push('several-paragraphs');
  if ((value.match(FILLER_RE) || []).length >= 3) signals.push('dictation-fillers');
  if (!/[.!?]\s*$/.test(value.trim()) && chars > 400) signals.push('no-final-punctuation');
  if (/\S{160,}/.test(value)) signals.push('run-on-sentence');
  const strong = signals.includes('very-long') || signals.includes('many-requirements') || signals.includes('many-words');
  const compile = settings.compile === 'off' ? false
    : settings.compile === 'always' ? chars >= 40
      : strong || signals.length >= 2;
  const shortObvious = chars < (settings.minChars || DEFAULT_SETTINGS.minChars) && signals.length <= 1;
  return { compile: compile && !shortObvious, intent: detectIntent(value), signals, chars, words: words_, shortObvious };
}

/** Quote-only brief: it can lose a detail, it can never invent one. */
function extractBrief(text) {
  const lines = sentences(text);
  const pick = re => lines.filter(line => re.test(line)).slice(0, 12);
  const requirements = pick(IMPERATIVE_RE).filter(line => !PROHIBITION_RE.test(line));
  const doNot = lines.filter(line => PROHIBITION_RE.test(line)).slice(0, 8);
  const successCriteria = lines.filter(line => CRITERIA_RE.test(line)).slice(0, 8);
  const ambiguities = lines.filter(line => AMBIGUITY_RE.test(line)).slice(0, 8);
  const goal = requirements[0] || lines[0] || String(text || '').trim().slice(0, 200);
  const firstRequirementAt = lines.indexOf(goal);
  const context = lines.slice(0, Math.max(0, firstRequirementAt)).slice(0, 3);
  const sourceMap = [...requirements, ...doNot, ...successCriteria].map(quote => ({ quote }));
  return {
    intent: detectIntent(text),
    goal,
    context,
    requirements,
    doNot,
    successCriteria,
    ambiguities,
    sourceMap
  };
}

/** Drop every model-made statement that is not anchored in the user's text. */
function validateBrief(brief, source) {
  if (!brief || typeof brief !== 'object') return null;
  const keep = list => (Array.isArray(list) ? list : []).map(item => (typeof item === 'string' ? item : item && item.text)).filter(item => typeof item === 'string' && item.trim());
  const groundedList = list => keep(list).filter(item => grounded(item, source));
  const out = {
    intent: detectIntent(source),
    goal: typeof brief.goal === 'string' && grounded(brief.goal, source) ? brief.goal : null,
    context: groundedList(brief.context).slice(0, 5),
    requirements: groundedList(brief.requirements).slice(0, 12),
    doNot: groundedList(brief.doNot).slice(0, 8),
    successCriteria: groundedList(brief.successCriteria).slice(0, 8),
    ambiguities: groundedList(brief.ambiguities).slice(0, 8)
  };
  const claimed = keep(brief.requirements).length;
  const kept = out.requirements.length;
  out.sourceMap = [...out.requirements, ...out.doNot, ...out.successCriteria].map(quote => ({ quote }));
  out.trust = claimed === 0 ? 1 : kept / claimed;
  if (!out.goal && !out.requirements.length) return null;
  if (claimed >= 2 && out.trust < 0.6) return null;
  return out;
}

function briefToText(brief, original) {
  const block = (title, items) => (items && items.length ? [title, ...items.map(item => '- ' + item)].join('\n') : '');
  return [
    'NODO Interpreter compiled brief (the original message below is unchanged and authoritative).',
    'INTENT: ' + brief.intent,
    block('GOAL:', brief.goal ? [brief.goal] : []),
    block('CONTEXT:', brief.context),
    block('REQUIREMENTS:', brief.requirements),
    block('DO NOT:', brief.doNot),
    block('SUCCESS CRITERIA:', brief.successCriteria),
    block('AMBIGUITIES:', brief.ambiguities),
    block('SOURCE MAP (verbatim from the user):', (brief.sourceMap || []).slice(0, 12).map(item => '“' + item.quote.slice(0, 160) + '”')),
    'ORIGINAL MESSAGE (verbatim, authoritative):\n' + String(original || '')
  ].filter(Boolean).join('\n');
}

// -- human response ---------------------------------------------------------

function verdictOf(text) {
  const value = String(text || '');
  if (FAIL_RE.test(value)) return 'проблема';
  if (PARTIAL_RE.test(value)) return 'частично';
  if (DONE_RE.test(value)) return 'готово';
  return 'не указано';
}

function firstSentences(text, max = 2, limit = 240) {
  const parts = sentences(text).slice(0, max);
  const joined = parts.join(' ').replace(/\s+/g, ' ').trim();
  if (!joined) return String(text || '').replace(/\s+/g, ' ').trim().slice(0, limit);
  return joined.length > limit ? joined.slice(0, limit).trim() + '…' : joined;
}

/** Mechanical human answer. Never upgrades a failure, never hides a blocker. */
function humanResponse(text, mode = 'NORMAL') {
  const source = String(text || '');
  const lines = sentences(source);
  const result = verdictOf(source);
  const human = {
    whatHappened: firstSentences(source, 2),
    result,
    whatRemains: lines.filter(line => REMAIN_RE.test(line)).slice(0, 3),
    needFromYou: lines.filter(line => NEED_RE.test(line)).slice(0, 2),
    blocker: lines.filter(line => BLOCKER_RE.test(line) || (FAIL_RE.test(line) && /blocker|не могу|cannot/i.test(line))).slice(0, 2)
  };
  if (!human.needFromYou.length) human.needFromYou = ['ничего'];
  if (mode === 'SHORT') {
    return {
      mode: 'SHORT',
      whatHappened: human.whatHappened,
      result,
      needFromYou: human.needFromYou,
      blocker: human.blocker,
      whatRemains: []
    };
  }
  return { mode: 'NORMAL', ...human };
}

/** The honesty guard applies to the model's answer as well as to ours. */
function enforceHonesty(human, technical) {
  const mechanical = verdictOf(technical);
  if (!human || typeof human !== 'object') return null;
  const out = { ...human };
  if (mechanical === 'проблема' && out.result === 'готово') out.result = 'проблема';
  if (mechanical === 'проблема' && !(out.blocker && out.blocker.length)) {
    out.blocker = [firstSentences(String(technical).split('\n').filter(line => FAIL_RE.test(line)).join(' '), 1, 200)].filter(Boolean);
  }
  if (!['готово', 'частично', 'проблема', 'не указано'].includes(out.result)) out.result = mechanical;
  out.whatHappened = String(out.whatHappened || '').slice(0, 600);
  out.whatRemains = (Array.isArray(out.whatRemains) ? out.whatRemains : []).slice(0, 3).map(String);
  out.needFromYou = (Array.isArray(out.needFromYou) ? out.needFromYou : ['ничего']).slice(0, 2).map(String);
  out.blocker = (Array.isArray(out.blocker) ? out.blocker : []).slice(0, 2).map(String);
  return out;
}

// -- rules ------------------------------------------------------------------

function scopeOf(text) {
  const value = String(text || '');
  if (/(?:reaper|reaper mcp|трек|аудио|time-?stretch)/i.test(value)) return 'REAPER';
  if (/(?:telegram|телеграм|клиент|чат)/i.test(value)) return 'Telegram';
  if (/(?:браузер|browser|cdp|страниц)/i.test(value)) return 'Browser';
  if (/(?:файл|file|путь|path|каталог|директор)/i.test(value)) return 'Files';
  if (/(?:код|code|тест|test|commit|коммит|репозитор|git|функци|module|модул)/i.test(value)) return 'Coding';
  return 'Project';
}

function ruleId(rule) {
  return crypto.createHash('sha1').update(String(rule.scope || 'Project') + '|' + normalizeForMatch(rule.text)).digest('hex').slice(0, 10);
}

/** Quote-grounded rule extraction: every rule carries the sentence it came from. */
function extractRules(text) {
  const lines = sentences(text).filter(line => line.length >= 15 && !AMBIGUITY_RE.test(line));
  const rules = lines
    .filter(line => IMPERATIVE_RE.test(line) || PROHIBITION_RE.test(line) || CONDITION_RE.test(line) || PERMISSION_RE.test(line) || /(?:всегда|никогда|always|never|обязательно)/i.test(line))
    .slice(0, 20)
    .map(line => {
      const statement = line.replace(/^\s*(?:нет|не так|не то|не совсем|вместо этого|instead)[,:\s-]+/i, '').trim() || line;
      const when = CONDITION_RE.test(statement) ? statement : '';
      const isProhibition = PROHIBITION_RE.test(statement);
      const rule = {
        scope: scopeOf(statement),
        text: statement,
        priority: isProhibition ? 80 : 60,
        when,
        exceptions: '',
        source: line
      };
      rule.id = ruleId(rule);
      return rule;
    });
  return { understanding: '', rules };
}

/**
 * A correction never appends a contradicting batch: the rules it supersedes are
 * replaced, and the rest of the previous proposal is kept as it was.
 */
function applyCorrection(previous, correctionRules, correctionText) {
  const kept = [];
  const replaced = new Map();
  for (const item of previous || []) {
    let superseded = null;
    for (const next of correctionRules) {
      const overlap = jaccard(item.text, next.text);
      // An explicit "no, not like that" supersedes the rule it talks about; a
      // correction must never leave two contradicting rules behind.
      const negated = /(?:^|\s)(?:нет|не так|не то|не совсем|вместо|instead|not\b)/i.test(correctionText) && overlap > 0.15;
      if (overlap >= 0.55 || negated) { superseded = next; break; }
    }
    if (superseded) replaced.set(superseded.id, { ...superseded, replaces: item.id });
    else kept.push(item);
  }
  const added = correctionRules.filter(rule => !replaced.has(rule.id) && !kept.some(item => item.id === rule.id));
  return [...kept, ...replaced.values(), ...added];
}

// ---------------------------------------------------------------------------

class Interpreter {
  constructor(options = {}) {
    this.auxiliary = options.auxiliary || null;
    this.logger = options.logger || null;
    this.settings = { ...DEFAULT_SETTINGS, ...(options.settings || {}) };
    this.stats = { compiled: 0, local: 0, original: 0, responses: 0, rules: 0, auxiliary: 0 };
    this.lastBrief = null;
  }

  status() {
    return {
      settings: { ...this.settings },
      stats: { ...this.stats },
      auxiliary: this.auxiliary ? this.auxiliary.status() : { available: false, reason: 'not wired' },
      scopes: RULE_SCOPES
    };
  }

  configure(patch = {}) {
    const next = { ...this.settings };
    if (patch.responseMode && ['SHORT', 'NORMAL', 'TECHNICAL'].includes(patch.responseMode)) next.responseMode = patch.responseMode;
    if (patch.compile && ['auto', 'always', 'off'].includes(patch.compile)) next.compile = patch.compile;
    if (Number.isFinite(Number(patch.longChars)) && Number(patch.longChars) >= 200) next.longChars = Math.round(Number(patch.longChars));
    if (Number.isFinite(Number(patch.veryLongChars)) && Number(patch.veryLongChars) >= next.longChars) next.veryLongChars = Math.round(Number(patch.veryLongChars));
    if (typeof patch.briefInjection === 'boolean') next.briefInjection = patch.briefInjection;
    this.settings = next;
    return { ...this.settings };
  }

  analyze(text) {
    return analyze(text, this.settings);
  }

  /** Mode A. Returns the original whenever the brief is not trustworthy. */
  async fromUser({ text } = {}) {
    const source = String(text || '');
    const decision = this.analyze(source);
    if (!source.trim() || !decision.compile) {
      this.stats.original += 1;
      return { mode: 'original', intent: decision.intent, brief: null, source, reason: decision.shortObvious ? 'short obvious message' : 'no compilation signal', signals: decision.signals };
    }
    if (this.auxiliary && this.auxiliary.available) {
      const answer = await this.auxiliary.ask({
        role: 'prompt-compiler',
        system: [
          'You compile a long, dictated user message into a structured brief for an engineering agent.',
          'Rules: never invent a requirement; every requirement, prohibition and success criterion must be a verbatim quote from the user text;',
          'keep the user language; answer with JSON only: {"goal":string,"context":string[],"requirements":string[],"doNot":string[],"successCriteria":string[],"ambiguities":string[]}.',
          'If the text is a question or a discussion, put the question into goal and leave requirements empty.'
        ].join(' '),
        input: source,
        schema: true,
        maxTokens: 900
      });
      if (answer && answer.value) {
        const brief = validateBrief(answer.value, source);
        if (brief) {
          this.stats.compiled += 1;
          this.stats.auxiliary += 1;
          this.lastBrief = { at: Date.now(), chars: source.length, mode: 'compiled' };
          return { mode: 'compiled', intent: brief.intent, brief, source, signals: decision.signals, confidence: brief.trust };
        }
      }
    }
    // No auxiliary model, or an answer that did not survive validation.
    const brief = extractBrief(source);
    if (!brief.requirements.length && !brief.doNot.length) {
      this.stats.original += 1;
      return { mode: 'original', intent: brief.intent, brief: null, source, reason: 'nothing safely extractable', signals: decision.signals };
    }
    this.stats.local += 1;
    this.lastBrief = { at: Date.now(), chars: source.length, mode: 'local' };
    return { mode: 'local', intent: brief.intent, brief, source, signals: decision.signals, confidence: 1 };
  }

  text(brief, source) {
    return briefToText(brief, source);
  }

  /** Mode B. The original technical text always travels with the human answer. */
  toUser({ text, mode } = {}) {
    const source = String(text || '');
    const chosen = ['SHORT', 'NORMAL', 'TECHNICAL'].includes(mode) ? mode : this.settings.responseMode;
    this.stats.responses += 1;
    if (chosen === 'TECHNICAL') return { mode: 'TECHNICAL', human: null, technical: source, reason: 'technical mode' };
    const human = humanResponse(source, chosen);
    return { mode: chosen, human, technical: source, mechanical: true, shortAnswer: source.trim().length < 240, result: human.result };
  }

  /** Optional model refinement of the human answer; the mechanical verdict wins. */
  async refine({ text, mode } = {}) {
    const base = this.toUser({ text, mode });
    if (!base.human || !this.auxiliary || !this.auxiliary.available) return base;
    const answer = await this.auxiliary.ask({
      role: 'response-translator',
      system: [
        'You rewrite a technical report for a busy owner. Same language as the report. Never claim success that the report does not show.',
        'JSON only: {"whatHappened":string,"result":"готово|частично|проблема|не указано","whatRemains":string[],"needFromYou":string[],"blocker":string[]}.',
        'Be short; keep numbers and names exact; if something failed, say it plainly.'
      ].join(' '),
      input: String(text || '').slice(0, 4000),
      schema: true,
      maxTokens: 600
    });
    if (!answer || !answer.value) return base;
    const human = enforceHonesty(answer.value, text);
    if (!human) return base;
    this.stats.auxiliary += 1;
    return { ...base, human, mechanical: false };
  }

  /** Mode C. Produces a proposal; saving happens only after the user confirms. */
  async compileRules({ text, previous = null, correction = null } = {}) {
    const source = String(text || '');
    const correctionText = String(correction || '');
    let items = null;
    if (this.auxiliary && this.auxiliary.available) {
      const answer = await this.auxiliary.ask({
        role: 'rule-compiler',
        system: [
          'You turn a spoken sentence into proposed project rules.',
          'JSON only: {"understanding":string,"rules":[{"scope":"Project|Browser|Files|REAPER|Telegram|Coding","text":string,"priority":number,"when":string,"exceptions":string,"source":string}]}.',
          'Every rule must quote the user verbatim in "source". Never invent a rule. One sentence may contain several rules.',
          'If the user corrects an earlier proposal, return only the rules that change.'
        ].join(' '),
        input: correctionText ? source + '\n\nCORRECTION: ' + correctionText : source,
        schema: true,
        maxTokens: 900
      });
      if (answer && answer.value && Array.isArray(answer.value.rules)) {
        const rules = answer.value.rules
          .filter(rule => rule && typeof rule.text === 'string' && grounded(rule.source || rule.text, source + ' ' + correctionText))
          .map(rule => {
            const shaped = {
              scope: RULE_SCOPES.includes(rule.scope) ? rule.scope : scopeOf(rule.text),
              text: String(rule.text).slice(0, 400),
              priority: Math.max(0, Math.min(100, Math.round(Number(rule.priority) || 60))),
              when: String(rule.when || '').slice(0, 200),
              exceptions: String(rule.exceptions || '').slice(0, 200),
              source: String(rule.source || rule.text).slice(0, 300)
            };
            return { ...shaped, id: ruleId(shaped) };
          });
        if (rules.length) {
          this.stats.auxiliary += 1;
          items = { understanding: String(answer.value.understanding || '').slice(0, 300), rules };
        }
      }
    }
    if (!items) {
      const local = extractRules(correctionText || source);
      if (!local.rules.length) {
        return {
          proposal: previous || [],
          rules: previous || [],
          understanding: previous && previous.length ? 'Я понял так: ' + previous.map(rule => rule.text).slice(0, 3).join('; ').slice(0, 300) : 'ничего, что можно превратить в правило',
          proposed: !!(previous && previous.length),
          requiresUserConfirmation: true,
          changed: false,
          mode: previous && previous.length ? 'kept' : 'none'
        };
      }
      items = { understanding: '', rules: local.rules };
    }
    const merged = previous ? applyCorrection(previous, items.rules, correctionText || source) : items.rules;
    this.stats.rules += 1;
    const understanding = items.understanding || ('Я понял так: ' + merged.map(rule => rule.text).slice(0, 3).join('; ')).slice(0, 400);
    return { understanding, rules: merged, proposed: true, requiresUserConfirmation: true, changed: true, mode: items.understanding ? 'compiled' : 'local' };
  }
}

module.exports = {
  Interpreter,
  analyze,
  extractBrief,
  validateBrief,
  briefToText,
  humanResponse,
  enforceHonesty,
  verdictOf,
  extractRules,
  applyCorrection,
  detectIntent,
  grounded,
  jaccard,
  DEFAULT_SETTINGS,
  RULE_SCOPES
};
