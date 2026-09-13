'use strict';
// Interpreter acceptance (project test set G-N) plus the composite-command and
// persistence acceptance for the supervisor (items that belong to the same run).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Supervisor, analyzeCommand } = require('../lib/supervisor.cjs');
const { Interpreter } = require('../lib/interpreter.cjs');
const { AuxiliaryProvider } = require('../lib/auxiliary.cjs');
const { installInterpreter } = require('../lib/interpreter-runtime.cjs');

const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'nodo-interpreter-'));

function supervisor(extra = {}) {
  return new Supervisor({ dataDir: dir(), logger: null, enabled: true, thresholds: { noProgressMs: 300, tickMs: 50 }, ...extra });
}

function bashExec(sessionId, command, workdir = '/w') {
  return { name: 'bash', arguments: { command, workdir }, agent: { session: { id: sessionId, header: { cwd: workdir } } } };
}

const ok = { isError: false, value: { exitCode: 0 }, content: [] };
const failed = { isError: false, value: { exitCode: 1 }, content: [{ type: 'text', text: 'exit code 1' }] };

// -- G. long dictation becomes a correct brief, nothing is lost ---------------

const DICTATION = [
  'Слушай, надо доделать интерпретатор и супервизор. Во-первых, сделай так, чтобы длинные диктовки сжимались в бриф.',
  'Добавь source map для каждого требования, чтобы было видно, откуда оно взялось.',
  'Не трогай production NODO ни в каком случае и не меняй его профиль.',
  'Проверь, что вопрос не считается командой, и что обсуждение прошлой команды не даёт разрешения.',
  'Критерий готовности: тесты проходят и в чате видно короткий человеческий ответ.',
  'И ещё, наверное, надо сохранить оригинал сообщения целиком. Запусти проверку после правки.',
  'Не забудь про приватность: секреты и ключи наружу не уходят.'
].join('\n');

test('G. a long dictated message yields a brief whose every requirement is quoted from the original', async () => {
  const interpreter = new Interpreter({});
  const decision = interpreter.analyze(DICTATION);
  assert.equal(decision.compile, true, 'a long dictation with many requirements must be compiled');
  const result = await interpreter.fromUser({ text: DICTATION });
  assert.notEqual(result.mode, 'original');
  assert.equal(result.intent, 'action');
  assert.ok(result.brief.requirements.length >= 4, 'requirements must survive');
  assert.ok(result.brief.doNot.length >= 1, 'prohibitions must survive');
  assert.ok(result.brief.successCriteria.length >= 1, 'acceptance criteria must survive');
  assert.ok(result.brief.ambiguities.length >= 1, 'uncertainty must be surfaced, not dropped');
  for (const item of result.brief.sourceMap) {
    assert.ok(DICTATION.includes(item.quote), 'every brief item must quote the original verbatim: ' + item.quote);
  }
  const compiled = interpreter.text(result.brief, DICTATION);
  assert.ok(compiled.includes(DICTATION), 'the original message travels with the brief, unchanged');
});

test('G2. a model answer that is not anchored in the user text is rejected wholesale', () => {
  const { validateBrief } = require('../lib/interpreter.cjs');
  const source = 'Сделай кнопку сохранения. Проверь, что тесты проходят.';
  const invented = {
    goal: 'Переписать всё ядро заново',
    requirements: ['Переписать всё ядро заново', 'Сделай кнопку сохранения.', 'Проверь, что тесты проходят.'],
    doNot: [],
    successCriteria: []
  };
  const checked = validateBrief(invented, source);
  assert.equal(checked.requirements.length, 2, 'only grounded requirements survive');
  assert.equal(checked.requirements[0], 'Сделай кнопку сохранения.');
  assert.equal(checked.goal, null, 'an invented goal is dropped');
  assert.equal(validateBrief({ goal: 'придумано', requirements: ['тоже придумано', 'и это'] }, source), null, 'a brief that mostly does not hold up is refused wholesale');
});

// -- H. short obvious messages are never compiled -----------------------------

test('H. a short obvious message never reaches the compiler', async () => {
  const interpreter = new Interpreter({});
  for (const text of ['Запусти тесты', 'Почему упал билд?', 'Спасибо', 'Покажи git status']) {
    const decision = interpreter.analyze(text);
    assert.equal(decision.compile, false, 'must not compile: ' + text);
    const result = await interpreter.fromUser({ text });
    assert.equal(result.mode, 'original');
    assert.equal(result.brief, null);
  }
  assert.equal(interpreter.stats.compiled + interpreter.stats.local, 0, 'no compiler work for obvious messages');
});

// -- I. a question stays a question ------------------------------------------

test('I. a question is never turned into a command', async () => {
  const interpreter = new Interpreter({});
  const question = 'Как думаешь, почему supervisor не ловит повтор, если команда составная и идёт через bash -c? Может, дело в парсинге?';
  const result = await interpreter.fromUser({ text: question });
  assert.equal(result.intent, 'question');
  if (result.brief) assert.equal(result.brief.requirements.length, 0, 'a question yields no requirements');
  const bare = interpreter.analyze('Почему сборка падает?');
  assert.equal(bare.intent, 'question');
  assert.equal(bare.compile, false);
});

// -- J. a technical wall of text becomes a human answer ----------------------

test('J. a technical wall of text is shortened for a human and the original stays available', () => {
  const interpreter = new Interpreter({});
  const wall = [
    'Собрал DEV-сборку в /Users/developer/NODO и прогнал node --test tests/supervisor.test.cjs.',
    'Первый прогон упал: exit code 1, 2 failed - тест persistence не находил state file, потому что путь собирался из process.cwd().',
    'Исправил на path.join(dataDir, supervisor-state.json), перезапустил, тесты прошли: 10 pass, 0 fail.',
    'Осталось: прогнать release-сборку и проверить composite commands в живом рантайме.',
    'Blocker: release-сборка не собрана, нужен свободный порт 4380.',
    'Нужно от тебя: подтверждение, что можно занять порт 4380 для проверки.'
  ].join('\n');
  const response = interpreter.toUser({ text: wall });
  assert.equal(response.mode, 'NORMAL');
  assert.ok(response.human.whatHappened.length < 300, 'the human part is short');
  assert.equal(response.human.result, 'проблема', 'a failed first run is not reported as success');
  assert.ok(response.human.whatRemains.length >= 1);
  assert.ok(response.human.needFromYou.length >= 1);
  assert.ok(response.human.blocker.length >= 1);
  assert.equal(response.technical, wall, 'the technical original is untouched');
  const short = interpreter.toUser({ text: wall, mode: 'SHORT' });
  assert.equal(short.mode, 'SHORT');
  assert.equal(short.human.whatRemains.length, 0);
  const technical = interpreter.toUser({ text: wall, mode: 'TECHNICAL' });
  assert.equal(technical.human, null, 'technical mode shows only the original');
});

test('J2. a failure is never presented as success, mechanically or by the model', () => {
  const { enforceHonesty } = require('../lib/interpreter.cjs');
  const interpreter = new Interpreter({});
  const lied = { whatHappened: 'Всё сделано', result: 'готово', whatRemains: [], needFromYou: ['ничего'], blocker: [] };
  const checked = enforceHonesty(lied, 'Готово. Но error: тест упал, exit code 1.');
  assert.equal(checked.result, 'проблема');
  assert.ok(checked.blocker.length >= 1, 'the real blocker is surfaced');
  assert.equal(interpreter.toUser({ text: 'Всё готово, ошибок нет.' }).human.result, 'готово');
});

// -- K. rules are only proposed, never written -------------------------------

test('K. the rule compiler proposes and writes nothing without confirmation', async () => {
  const interpreter = new Interpreter({});
  const input = 'Не используй длинные тире в ответах. Перед коммитом запускай npm run validate. Всегда проверяй production перед релизом.';
  const proposal = await interpreter.compileRules({ text: input });
  assert.equal(proposal.proposed, true);
  assert.equal(proposal.requiresUserConfirmation, true);
  assert.equal(proposal.rules.length, 3);
  for (const rule of proposal.rules) {
    assert.ok(input.includes(rule.source), 'every proposed rule quotes the user');
    assert.ok(rule.id && rule.scope && typeof rule.priority === 'number');
  }
  assert.ok(proposal.understanding.length > 0, 'the user must see what was understood');
  assert.equal(typeof interpreter.save, 'undefined', 'the engine itself has no way to write rules');
});

test('K2. rules.save refuses to write anything when the brain is not wired', async () => {
  const runtime = installInterpreter({ on: () => () => {}, tools: {} }, { dataDir: dir(), auxiliary: new AuxiliaryProvider({ dataDir: dir(), disabled: true }) });
  const result = await runtime.save({ rules: [{ text: 'Правило' }] });
  assert.equal(result.saved, 0);
  assert.equal(result.rejected[0].reason, 'project storage is not wired');
  runtime.dispose();
});

test('K3. Save all writes through the project brain, once, and duplicates are refused', async () => {
  const written = [];
  const runtime = installInterpreter({ on: () => () => {}, tools: {} }, {
    dataDir: dir(),
    auxiliary: new AuxiliaryProvider({ dataDir: dir(), disabled: true }),
    projectCall: async p => {
      if (p.action === 'list') return { rules: written.map((text, index) => ({ id: String(index), text })) };
      written.push(p.text);
      return { id: 'rule-' + written.length };
    }
  });
  const rules = [
    { scope: 'Coding', text: 'Перед коммитом запускай npm run validate', priority: 60, when: '', exceptions: '', source: 'Перед коммитом запускай npm run validate.' },
    { scope: 'Project', text: 'Не используй длинные тире', priority: 80, when: 'в клиентских сообщениях', exceptions: '', source: 'Не используй длинные тире.' }
  ];
  const first = await runtime.save({ sessionId: 's', rules });
  assert.equal(first.saved, 2);
  assert.ok(written[0].includes('Перед коммитом запускай npm run validate'));
  assert.ok(written[1].includes('Когда: в клиентских сообщениях'), 'when/applies is preserved in the stored rule');
  const second = await runtime.save({ sessionId: 's', rules });
  assert.equal(second.saved, 0, 'the same rule is not stored twice');
  assert.equal(second.rejected.filter(item => item.reason === 'already saved').length, 2);
  runtime.dispose();
});

// -- L. a correction updates the proposal instead of adding a second batch ----

test('L. a correction replaces the rule it talks about and creates no contradiction', async () => {
  const interpreter = new Interpreter({});
  const input = 'Не используй длинные тире в ответах. Перед коммитом запускай npm run validate.';
  const first = await interpreter.compileRules({ text: input });
  assert.equal(first.rules.length, 2);
  const corrected = await interpreter.compileRules({
    text: input,
    previous: first.rules,
    correction: 'Нет, не так: длинные тире можно, но только не в клиентских сообщениях.'
  });
  assert.equal(corrected.rules.length, 2, 'still one batch, not two');
  assert.equal(corrected.rules.filter(rule => /длинные тире/i.test(rule.text)).length, 1, 'exactly one rule about dashes');
  const replacement = corrected.rules.find(rule => rule.replaces);
  assert.ok(replacement, 'the new rule records what it replaced');
  assert.ok(!/^нет,?\s*не так/i.test(replacement.text), 'the conversational lead-in is not stored as the rule');
  const added = await interpreter.compileRules({ text: input, previous: corrected.rules, correction: 'добавь правило: не трогай production без команды' });
  assert.equal(added.rules.length, 3, 'a genuine addition is added');
});

// -- M. auxiliary unavailable: everything still works -------------------------

test('M. without an auxiliary model every mode degrades gracefully', async () => {
  const auxiliary = new AuxiliaryProvider({ dataDir: dir(), endpoint: 'https://example.invalid/v1/chat/completions', apiKey: 'test-key', timeoutMs: 200 });
  assert.equal(auxiliary.available, true);
  assert.equal(await auxiliary.ask({ input: 'hello' }), null, 'an unreachable endpoint yields no opinion');
  const interpreter = new Interpreter({ auxiliary });
  const result = await interpreter.fromUser({ text: DICTATION });
  assert.notEqual(result.mode, 'compiled', 'no compiled brief without a reachable model');
  assert.notEqual(result.mode, 'original', 'the mechanical fallback still produces a usable brief');
  const rules = await interpreter.compileRules({ text: 'Всегда проверяй production перед релизом.' });
  assert.equal(rules.mode, 'local');
  assert.equal(rules.rules.length, 1);
  const unconfigured = new AuxiliaryProvider({ dataDir: dir() });
  assert.equal(unconfigured.available, false);
  assert.match(unconfigured.status().reason, /no endpoint configured/);
});

// -- N. privacy: nothing extra leaves the machine ----------------------------

test('N. a private payload is never sent to an external endpoint', async () => {
  const auxiliary = new AuxiliaryProvider({ dataDir: dir(), endpoint: 'https://openrouter.ai/api/v1/chat/completions', apiKey: 'test-key' });
  // The synthetic key is assembled at runtime: a literal `sk-...` is refused by
  // the public source scan, which is exactly what this test proves the
  // interpreter does to a real payload.
  const fakeKey = 'sk-' + 'abcdefghijklmnop' + '1234';
  const privateText = 'Клиент Стас, пароль: hunter2xyz, ключ ' + fakeKey + ', почта stas@example.com, оплата заказа 45000.';
  const prepared = auxiliary.prepare(privateText);
  assert.ok(!prepared.includes(fakeKey), 'API keys are stripped');
  assert.ok(!prepared.includes('stas@example.com'), 'addresses are stripped');
  assert.equal(auxiliary.inspect(privateText).sensitive, true);
  assert.equal(await auxiliary.ask({ input: privateText }), null, 'a private payload is refused for an external endpoint');
  assert.match(auxiliary.lastError, /private/);
  const local = new AuxiliaryProvider({ dataDir: dir(), endpoint: 'http://127.0.0.1:9999/v1/chat/completions', apiKey: 'test-key' });
  assert.equal(local.status().external, false, 'a local endpoint is not treated as external');
});

test('N2. the supervisor verifier receives telemetry only, never text', () => {
  const { anonymize } = require('../lib/supervisor.cjs');
  const payload = anonymize({
    event: 'no-progress',
    tool: 'bash',
    command: 'cat /Users/developer/client-secret.txt',
    file: '/Users/developer/private.md',
    text: 'клиентское сообщение',
    message: 'prompt content',
    stdout: 'output',
    steps: 12,
    kinds: [{ kind: 'verify', executions: 3 }]
  });
  assert.equal(payload.command, undefined, 'a shell command never leaves');
  assert.equal(payload.file, undefined);
  assert.equal(payload.text, undefined);
  assert.equal(payload.message, undefined);
  assert.equal(payload.stdout, undefined);
  assert.equal(payload.operation, undefined);
  assert.equal(payload.signature, undefined);
  assert.equal(payload.target, undefined);
  assert.equal(payload.tool, 'bash', 'a tool name is not content');
  assert.equal(payload.steps, 12);
});

// -- supervisor: composite commands ------------------------------------------

test('supervisor: a composite command cannot hide a loop', () => {
  const inspect = analyzeCommand('cd /w && npm test');
  assert.equal(inspect.kind, 'verify');
  assert.equal(analyzeCommand('bash -c "npm test"').fingerprint, inspect.fingerprint, 'a shell wrapper is peeled off');
  assert.equal(analyzeCommand('npm test && echo ok').fingerprint, analyzeCommand('npm test ; echo ok').fingerprint, 'the separator is not part of the operation');
  assert.equal(analyzeCommand('cd /w && npm test && echo ok').fingerprint, analyzeCommand('npm test && echo ok').fingerprint, 'a leading cd is not part of the operation');
  assert.equal(analyzeCommand('npm test && echo ok').fingerprint, analyzeCommand('npm test || echo ok').fingerprint);
  assert.notEqual(analyzeCommand('npm test && git commit -m x').fingerprint, inspect.fingerprint, 'a real mutation makes it a different operation');
  assert.equal(analyzeCommand('npm test && git commit -m x').kind, 'mutate');
  assert.notEqual(analyzeCommand('npm test | tee log').fingerprint, inspect.fingerprint);
  assert.equal(analyzeCommand('sudo -u root /bin/bash -c "npm test"').fingerprint, inspect.fingerprint, 'wrappers and env prefixes are transparent');
});

test('supervisor: repeating the same composite check is stopped like a plain one', () => {
  const supervisor = new Supervisor({ dataDir: dir(), logger: null });
  const sessionId = 'composite';
  const variants = ['cd /w && npm test', 'bash -c "npm test"', 'npm test; echo ok', '/bin/sh -c \'cd /w; npm test\''];
  let denied = 0;
  for (const command of variants) {
    const exec = bashExec(sessionId, command);
    const reason = supervisor.guard(exec);
    supervisor.observeResult(exec, ok, 10);
    if (reason) denied += 1;
  }
  assert.ok(denied >= 1, 'a loop written four different ways is still a loop');
});

test('supervisor: a composite mutation with real progress is not a loop', () => {
  const supervisor = new Supervisor({ dataDir: dir(), logger: null });
  const sessionId = 'progress';
  const commands = [
    'cd /w && npm run build && node --test tests/a.cjs',
    'cd /w && npm run build && node --test tests/b.cjs',
    'cd /w && npm run build && node --test tests/c.cjs'
  ];
  for (const command of commands) {
    const exec = bashExec(sessionId, command);
    assert.ok(!supervisor.guard(exec));
    supervisor.observeResult(exec, ok, 10);
  }
  assert.ok(!supervisor.status(sessionId).intervention, 'three different checks are real progress, not a loop');
});

// -- supervisor: persistence across a restart --------------------------------

test('supervisor: last operation fingerprints, PASS state and budgets survive a restart', () => {
  const dataDir = dir();
  const first = new Supervisor({ dataDir, logger: null });
  const sessionId = 'restart';
  const exec = bashExec(sessionId, 'cd /w && npm run validate');
  first.guard(exec);
  for (let index = 0; index < 3; index += 1) {
    first.guard(exec);
    first.observeResult(exec, ok, 10);
  }
  assert.ok(first.guard(exec), 'the loop is recognised before the restart');
  first.save();

  const second = new Supervisor({ dataDir, logger: null });
  const restored = second.status(sessionId);
  const reason = second.guard(bashExec(sessionId, 'npm run validate'));
  assert.ok(reason, 'the same operation is still budgeted out after a restart');
  assert.match(String(reason), /loop|passed|repeat/i);
  assert.ok(restored.operations >= 1 || reason, 'restored state is visible to the card');
  assert.equal(second.card(sessionId).phase, first.card(sessionId).phase, 'the intervention survives the restart');
});

test('supervisor: persisted state stays bounded', () => {
  const dataDir = dir();
  const supervisor = new Supervisor({ dataDir, logger: null, thresholds: { sessionsKept: 2, opsKept: 3 } });
  for (let session = 0; session < 5; session += 1) {
    for (let op = 0; op < 6; op += 1) {
      const exec = bashExec('s' + session, 'node check-' + op + '.cjs');
      supervisor.guard(exec);
      supervisor.observeResult(exec, op % 2 ? ok : failed, 5);
    }
  }
  supervisor.save();
  const saved = JSON.parse(fs.readFileSync(path.join(dataDir, 'supervisor-state.json'), 'utf8'));
  assert.ok(saved.sessions.length <= 2, 'only the newest sessions are kept');
  for (const session of saved.sessions) assert.ok(session.ops.length <= 3, 'only the newest operations are kept');
  assert.ok(fs.statSync(path.join(dataDir, 'supervisor-state.json')).size < 60000, 'the state file stays small');
});

test('supervisor: thresholds are tunable only through settings and are validated', () => {
  const dataDir = dir();
  const supervisor = new Supervisor({ dataDir, logger: null });
  const defaults = supervisor.settings();
  assert.equal(defaults.values.repeatLimit, 3);
  assert.equal(defaults.values.postFixCheckLimit, 1);
  assert.ok(defaults.bounds.noProgressMs.min >= 60000);
  const rejected = supervisor.configure({ repeatLimit: 99, nope: 1 });
  assert.equal(rejected.accepted, false);
  assert.equal(supervisor.thresholds.repeatLimit, 3, 'a rejected patch changes nothing');
  const accepted = supervisor.configure({ repeatLimit: 5, noProgressMs: 600000 });
  assert.equal(accepted.accepted, true);
  const next = new Supervisor({ dataDir, logger: null });
  assert.equal(next.thresholds.repeatLimit, 5, 'the tuned value survives a restart');
  assert.equal(next.thresholds.postFixCheckLimit, 1, 'untouched thresholds keep their default');
});

// -- provider-neutral telemetry ----------------------------------------------

test('telemetry: another provider gets the same budgets through the same interface', () => {
  const supervisor = new Supervisor({ dataDir: dir(), logger: null });
  const call = { provider: 'codex', sessionId: 'codex-1', kind: 'ask', tool: { name: 'bash', arguments: { command: 'npm run validate' }, cwd: '/w' } };
  supervisor.observe({ ...call, phase: 'turn-start' });
  const first = supervisor.observe(call);
  assert.equal(first.allow, true);
  supervisor.observe({ ...call, kind: 'result', result: { ok: true, exitCode: 0 } });
  supervisor.observe(call);
  supervisor.observe({ ...call, kind: 'result', result: { ok: true, exitCode: 0 } });
  const third = supervisor.observe(call);
  assert.equal(third.allow, false, 'the same rules apply to a non-DeepSeek runner');
  assert.match(third.reason, /passed|loop|repeat/i);
  assert.ok(supervisor.status('codex-1'));
});
