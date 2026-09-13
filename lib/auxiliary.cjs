'use strict';
// ---------------------------------------------------------------------------
// The single auxiliary model of NODO.
//
// There is exactly one, conceptually: Nemotron 3 Ultra Free, reached through an
// OpenAI-compatible endpoint (OpenRouter or NVIDIA). It answers a few narrow
// questions the mechanical code cannot answer alone - compile this dictation,
// say this in human words, turn this sentence into rules, is this really
// progress - and nothing else. When it is not configured, every caller falls
// back to the mechanical path: no feature of NODO depends on it.
//
// Privacy is enforced here, not by the callers: payloads are minimized, secrets
// never leave the machine, and a payload that looks private is refused for an
// external endpoint.
// ---------------------------------------------------------------------------

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const MODEL = 'nemotron-3-ultra-free';
const PROVIDERS = {
  openrouter: { endpoint: 'https://openrouter.ai/api/v1/chat/completions', keyEnv: 'OPENROUTER_API_KEY', keyFile: 'openrouter-api-key' },
  nvidia: { endpoint: 'https://integrate.api.nvidia.com/v1/chat/completions', keyEnv: 'NVIDIA_API_KEY', keyFile: 'nvidia-api-key' },
  local: { endpoint: '', keyEnv: 'NODO_AUX_API_KEY', keyFile: 'nodo-aux-api-key' }
};

const SECRETS = [
  [/\bsk-[A-Za-z0-9_-]{12,}\b/g, '<SECRET>'],
  [/\b(?:ghp|gho|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{10,}\b/g, '<SECRET>'],
  [/\bBearer\s+[A-Za-z0-9._-]{12,}/gi, 'Bearer <SECRET>'],
  [/(?:api[_-]?key|apikey|token|secret|password|passwd|пароль|токен|ключ)\s*[:=]\s*["']?[^\s"',;]{6,}/giu, '<SECRET-FIELD>'],
  [/\b[A-Za-z0-9+/]{40,}={0,2}\b/g, '<SECRET>'],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '<EMAIL>'],
  [/(?:\+?\d[\s-]?){10,15}\b/g, '<PHONE>'],
  [/\b(?:\d[ -]?){13,19}\b/g, '<CARD>']
];

// Deliberately blunt: over-triggering costs one fallback, under-triggering
// would send something private to somebody else's server.
const SENSITIVE = [
  /(?:password|passwd|secret|token|api[_-]?key|пароль|токен|секрет|ключ доступа)/i,
  /(?:паспорт|снилс|инн|iban|swift|card number|cvv|номер карты)/i,
  /(?:клиент|client|заказчик)[\s\S]{0,60}(?:оплат|заказ|счёт|счет|договор|адрес)/i,
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/
];

const isLocal = endpoint => /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?\//i.test(String(endpoint || ''));

class AuxiliaryProvider {
  constructor(options = {}) {
    this.dataDir = options.dataDir || process.env.NODO_DATA || path.join(os.homedir(), '.dsh');
    this.settingsFile = options.settingsFile || path.join(this.dataDir, 'auxiliary.json');
    const saved = this.read();
    this.providerName = options.provider || saved.provider || process.env.NODO_AUX_PROVIDER || '';
    this.config = PROVIDERS[this.providerName] || null;
    this.endpoint = options.endpoint || saved.endpoint || process.env.NODO_AUX_ENDPOINT || process.env.NODO_AUX_VERIFIER_ENDPOINT || (this.config ? this.config.endpoint : '');
    this.model = options.model || saved.model || process.env.NODO_AUX_MODEL || process.env.NODO_AUX_VERIFIER_MODEL || MODEL;
    this.timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : Number(saved.timeoutMs) || 12000;
    this.maxPayloadChars = Number(options.maxPayloadChars) > 0 ? Number(options.maxPayloadChars) : Number(saved.maxPayloadChars) || 6000;
    this.sensitivePolicy = options.sensitivePolicy || saved.sensitivePolicy || 'fallback';
    this.disabled = options.disabled === true || process.env.NODO_AUX_VERIFIER === 'off' || saved.enabled === false;
    this.key = options.apiKey || this.resolveKey(saved);
    this.lastError = null;
    this.calls = 0;
  }

  read() {
    try {
      return JSON.parse(fs.readFileSync(this.settingsFile, 'utf8')) || {};
    } catch {
      return {};
    }
  }

  /** The key itself is never returned, logged or written anywhere. */
  resolveKey(saved = {}) {
    if (saved.apiKey) return String(saved.apiKey);
    if (this.config && process.env[this.config.keyEnv]) return process.env[this.config.keyEnv];
    const candidates = [];
    if (this.config) candidates.push(path.join(os.homedir(), '.dsh', this.config.keyFile));
    for (const file of candidates) {
      try {
        const value = fs.readFileSync(file, 'utf8').trim();
        if (value) return value;
      } catch {
        /* not configured */
      }
    }
    return '';
  }

  get available() {
    return !this.disabled && !!this.endpoint && !!this.key;
  }

  status() {
    return {
      available: this.available,
      enabled: !this.disabled,
      provider: this.providerName || (isLocal(this.endpoint) ? 'local' : 'external'),
      model: this.model,
      endpoint: this.endpoint ? String(this.endpoint).replace(/\/\/([^/@]+)@/, '//') : '',
      external: !!this.endpoint && !isLocal(this.endpoint),
      key: this.key ? 'configured' : 'missing',
      sensitivePolicy: this.sensitivePolicy,
      calls: this.calls,
      reason: this.disabled ? 'disabled' : !this.endpoint ? 'no endpoint configured' : !this.key ? 'ready for key: set OPENROUTER_API_KEY or ' + path.join(os.homedir(), '.dsh', (this.config && this.config.keyFile) || 'nodo-aux-api-key') : null
    };
  }

  /** Minimize and de-identify before anything leaves the process. */
  prepare(text) {
    let out = String(text === undefined || text === null ? '' : text);
    for (const [pattern, replacement] of SECRETS) out = out.replace(pattern, replacement);
    if (out.length > this.maxPayloadChars) out = out.slice(0, this.maxPayloadChars) + '\n[truncated]';
    return out;
  }

  inspect(text) {
    const raw = String(text || '');
    const reasons = [];
    for (const pattern of SENSITIVE) if (pattern.test(raw)) reasons.push(String(pattern).slice(0, 40));
    return { sensitive: reasons.length > 0, reasons };
  }

  /**
   * One question, one JSON answer, or null. A caller that receives null keeps
   * working: null means "no opinion from the auxiliary model".
   */
  async ask({ role = 'generic', system = '', input = '', schema = null, maxTokens = 700 } = {}) {
    if (!this.available) return null;
    const privacy = this.inspect(input);
    const external = !isLocal(this.endpoint);
    if (privacy.sensitive && external && this.sensitivePolicy === 'fallback') {
      this.lastError = 'skipped: the payload looks private and the endpoint is external';
      return null;
    }
    this.calls += 1;
    const payload = {
      model: this.model,
      max_tokens: maxTokens,
      temperature: 0,
      messages: [
        { role: 'system', content: system || 'You answer with a single JSON object and nothing else.' },
        { role: 'user', content: this.prepare(input) }
      ]
    };
    if (schema) payload.response_format = { type: 'json_object' };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(this.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + this.key },
        body: JSON.stringify(payload),
        signal: controller.signal
      });
      if (!response.ok) {
        this.lastError = 'http ' + response.status;
        return null;
      }
      const body = await response.json();
      const text = body && body.choices && body.choices[0] && body.choices[0].message ? body.choices[0].message.content : '';
      if (typeof text !== 'string' || !text.trim()) {
        this.lastError = 'empty answer';
        return null;
      }
      const json = extractJson(text);
      if (!json) {
        this.lastError = 'answer was not JSON';
        return null;
      }
      this.lastError = null;
      return { role, value: json, model: this.model, provider: this.providerName || 'external' };
    } catch (error) {
      this.lastError = (error && error.name === 'AbortError') ? 'timeout' : (error && error.message) || 'request failed';
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Tolerates a fenced or chatty answer without trusting it. */
function extractJson(text) {
  const trimmed = String(text).trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    /* keep looking */
  }
  const start = trimmed.indexOf('{'), end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      return null;
    }
  }
  return null;
}

module.exports = { AuxiliaryProvider, extractJson, MODEL, PROVIDERS, isLocal, SECRETS };
