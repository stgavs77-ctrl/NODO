'use strict';
/*
 * Supervisor host (Electron main process).
 *
 * The mechanical core lives in the harness plugin (lib/supervisor.cjs): it sees
 * every tool call and every turn boundary. This host is the other half - it
 * owns what the human sees and what the human asks for:
 *
 *   - the compact heartbeat and the intervention card for the current task/turn
 *   - the four controls: Continue once, Stop task, Finish with current result,
 *     Technical details
 *   - the user interrupt path: a message typed while a turn runs is acknowledged
 *     immediately and answered at the next safe point
 *   - the event log behind Advanced/Diagnostics
 *
 * It never decides whether a loop happened. It only carries the decision and
 * the user's answer back to the core.
 */

class SupervisorHost {
  constructor(app) {
    this.app = app;
    this.statuses = new Map();
    this.cards = new Map();
    this.notes = new Map();
  }

  /** Calls arriving from the plugin: latest status and card per session. */
  backend(payload = {}) {
    try {
      const status = payload.status;
      if (status && status.sessionId) {
        this.statuses.set(status.sessionId, status);
        while (this.statuses.size > 6) this.statuses.delete(this.statuses.keys().next().value);
        if (payload.card) {
          this.cards.set(status.sessionId, payload.card);
          const task = this.taskFor(status.sessionId);
          if (task) {
            task.supervisor = payload.card;
            if (!['Done'].includes(task.status)) {
              task.status = 'Paused';
              task.lastAction = payload.card.code === 'finished' ? 'Finished by supervisor' : 'Stopped by supervisor';
              if (task.timer) { clearTimeout(task.timer); delete task.timer; }
            }
          }
        } else if (!status.intervention && status.phase !== 'finished') {
          this.cards.delete(status.sessionId);
          const task = this.taskFor(status.sessionId);
          if (task && task.supervisor) delete task.supervisor;
        }
      }
      this.app.changed();
      return { accepted: true };
    } catch (error) {
      // Presentation must never be able to break supervision.
      return { accepted: false, error: error && error.message };
    }
  }

  taskFor(sessionId) {
    return this.app.tasks.items.find(t => t.sessionId === sessionId && ['Running', 'Paused', 'Waiting', 'Pending'].includes(t.status)) ||
      this.app.tasks.items.find(t => t.sessionId === sessionId);
  }

  card(sessionId) {
    return this.cards.get(sessionId) || null;
  }

  /** Called by the task poller when it sees the turn end on its own. */
  turnEnded(sessionId) {
    const card = this.cards.get(sessionId);
    if (!card) return null;
    if (card.phase === 'finished') return { status: 'Done', lastAction: 'Finished by supervisor' };
    return { status: 'Paused', lastAction: 'Stopped by supervisor' };
  }

  /**
   * User controls. Every one of them is a deliberate user decision, so the
   * host may change task bookkeeping here and nowhere else.
   */
  async act(params = {}, user) {
    if (!user) throw Error('Supervisor actions require the local interface');
    const action = String(params.action || '');
    // Tuning is not an intervention: it applies to every session, so it needs
    // the local interface but not an open one.
    if (action === 'settings') return { accepted: true, settings: await this.app.dsh('supervisor.act', { action: 'settings', patch: params.patch || {} }) };
    const sessionId = params.sessionId;
    if (typeof sessionId !== 'string' || !sessionId) throw Error('Session required');
    if (!['continue-once', 'stop-task', 'finish', 'acknowledge-interrupt'].includes(action)) throw Error('Unknown supervisor action');
    const result = await this.app.dsh('supervisor.act', { sessionId, action, signature: params.signature });
    const task = this.taskFor(sessionId);
    if (action === 'continue-once') {
      await this.resumeAfterContinue(sessionId, task, result);
    } else if (action === 'finish') {
      this.cards.delete(sessionId);
      if (task) {
        task.status = 'Done';
        task.lastAction = 'Finished by supervisor with the current result';
        if (task.timer) { clearTimeout(task.timer); delete task.timer; }
        delete task.supervisor;
      }
      this.app.changed();
    } else if (action === 'stop-task') {
      this.cards.delete(sessionId);
      if (task) {
        task.status = 'Paused';
        task.lastAction = 'Stopped by supervisor';
        if (task.timer) { clearTimeout(task.timer); delete task.timer; }
        delete task.supervisor;
      }
      this.app.changed();
    } else {
      this.app.changed();
    }
    return { ...result, card: this.card(sessionId) };
  }

  /**
   * Continue once grants exactly one further attempt. The resume prompt is sent
   * only after the stopped turn really ended, so it cannot be queued behind it
   * and the one-shot stays one shot.
   */
  async resumeAfterContinue(sessionId, task, result) {
    this.cards.delete(sessionId);
    if (task) {
      delete task.supervisor;
      task.lastAction = 'Continue once granted';
      if (task.status === 'Paused') task.status = 'Done';
    }
    this.app.changed();
    const chat = this.app.state.chats.find(c => c.deepseekId === sessionId);
    if (!chat) return;
    const deadline = Date.now() + 25000;
    while (Date.now() < deadline) {
      const busy = this.app.tasks.items.some(t => t.chatId === chat.id && !t.delegated && t.status === 'Running');
      if (!busy) break;
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    try {
      await this.app.tasks.start({ chatId: chat.id, text: result.resume.text, agent: 'DeepSeek' });
    } catch (error) {
      this.note(sessionId, 'Continue once could not start: ' + error.message);
    }
  }

  /** A user message typed while the agent is working. */
  async userMessage(params = {}, user) {
    if (!user) throw Error('This action requires the RC user interface');
    const sessionId = params.sessionId;
    if (typeof sessionId !== 'string' || !sessionId) throw Error('Session required');
    const answer = await this.app.dsh('supervisor.userMessage', { sessionId, text: params.text, kind: params.kind, source: 'ui' });
    if (answer && answer.received) this.note(sessionId, answer.message);
    return answer;
  }

  note(sessionId, message) {
    this.notes.set(sessionId, { at: new Date().toISOString(), message: String(message || '') });
    this.app.changed();
  }

  snapshot() {
    const statuses = {};
    for (const [sessionId, status] of this.statuses) statuses[sessionId] = status;
    const cards = {};
    for (const [sessionId, card] of this.cards) cards[sessionId] = card;
    const notes = {};
    for (const [sessionId, note] of this.notes) notes[sessionId] = note;
    return { statuses, cards, notes };
  }
}

module.exports = { SupervisorHost };
