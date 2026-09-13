'use strict';
// ---------------------------------------------------------------------------
// One vocabulary for every runner.
//
// The supervisor never reads a model's wire format. A runner - the bundled DSH
// runtime today, Codex or any future provider tomorrow - hands over a canonical
// observation and receives the same budgets, the same loop detection and the
// same safe pause. Adapters are the only place that knows a concrete shape:
// `dsh` for the bundled runtime, `generic` for anything that can produce
// {sessionId, tool, arguments, cwd, result}. Adding a provider means adding an
// adapter here, never touching the supervisor.
// ---------------------------------------------------------------------------

const ADAPTERS = new Map();

function register(name, adapter) {
  if (typeof name !== 'string' || !name || !adapter || typeof adapter !== 'object') throw Error('An adapter needs a name and a definition');
  ADAPTERS.set(name, { ...adapter, name });
  return ADAPTERS.get(name);
}

function adapterFor(provider) {
  return ADAPTERS.get(String(provider || 'dsh')) || ADAPTERS.get('generic');
}

function registered() {
  return [...ADAPTERS.keys()];
}

// -- canonical shapes -------------------------------------------------------

/** What a runner must tell the supervisor about one tool call. */
function observation(input = {}) {
  const provider = String(input.provider || 'dsh');
  const adapter = adapterFor(provider);
  const call = adapter.tool(input);
  return {
    provider,
    sessionId: call.sessionId,
    tool: call.name,
    arguments: call.arguments,
    cwd: call.cwd,
    parent: !!call.parent
  };
}

/** What a runner must tell the supervisor about the result of that call. */
function resultOf(input = {}) {
  const adapter = adapterFor(input.provider || 'dsh');
  return adapter.outcome(input.result === undefined ? input : input.result);
}

/** What a runner must tell the supervisor about the life of a session. */
function sessionEvent(input = {}) {
  const adapter = adapterFor(input.provider || 'dsh');
  return adapter.session(input);
}

// -- the bundled runtime (DeepSeek / DSH) -----------------------------------

const DSH_TOOL_EVENTS = { start: 'step/start', end: 'step/end', 'turn-start': 'turn/start', 'turn-end': 'turn/end', message: 'user/message' };

const dsh = {
  name: 'dsh',
  tool(exec = {}) {
    const session = exec.agent && exec.agent.session;
    const header = session && session.header;
    const args = exec.arguments && typeof exec.arguments === 'object' ? exec.arguments : {};
    return {
      sessionId: session && typeof session.id === 'string' && session.id ? session.id : exec.sessionId || null,
      name: String(exec.name || 'tool'),
      arguments: args,
      cwd: (args.workdir || (header && header.cwd)) || '',
      parent: !!exec.parent
    };
  },
  outcome(result) {
    return {
      ok: result ? !result.isError && !result.timedOut : true,
      timedOut: !!(result && result.timedOut),
      exitCode: result && result.value && Number.isFinite(result.value.exitCode) ? result.value.exitCode : null,
      error: (result && result.error && (result.error.message || result.error.name)) || (result && result.isError ? String(result.error || 'tool error') : null)
    };
  },
  session(input = {}) {
    const session = input.session || {};
    const event = input.event || {};
    return {
      provider: 'dsh',
      sessionId: session.id || (event.data && event.data.sessionId) || null,
      type: event.type || '',
      turn: event.data && event.data.turn,
      step: event.data && event.data.step,
      data: (event.data && event.data.message) || event.data || {}
    };
  }
};

// -- anything else ----------------------------------------------------------

const generic = {
  name: 'generic',
  tool(input = {}) {
    const call = input.tool && typeof input.tool === 'object' ? input.tool : input;
    return {
      sessionId: input.sessionId || call.sessionId || null,
      name: String(call.name || call.tool || 'tool'),
      arguments: call.arguments || call.args || {},
      cwd: call.cwd || input.cwd || '',
      parent: !!(call.parent || input.parent)
    };
  },
  outcome(result = {}) {
    if (result === null || result === undefined) return { ok: true, timedOut: false, exitCode: null, error: null };
    if (typeof result === 'boolean') return { ok: result, timedOut: false, exitCode: null, error: result ? null : 'reported failure' };
    return {
      ok: result.ok === undefined ? !result.error : !!result.ok,
      timedOut: !!result.timedOut,
      exitCode: Number.isFinite(result.exitCode) ? result.exitCode : null,
      error: result.error ? String(result.error.message || result.error) : null
    };
  },
  session(input = {}) {
    return { provider: input.provider || 'generic', sessionId: input.sessionId || null, type: input.type || '', turn: input.turn, step: input.step, data: input.data || {} };
  }
};

register('dsh', dsh);
register('generic', generic);

module.exports = { register, adapterFor, registered, observation, resultOf, sessionEvent, dsh, generic, DSH_TOOL_EVENTS };
