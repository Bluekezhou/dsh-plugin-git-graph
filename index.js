import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import git from './git.cjs';

export default class GitGraph extends TypertRemoteService {
  static inject = ['workingDirectory', 'sessions', 'typertGateway'];

  constructor(ctx) {
    super(ctx, 'gitGraph');
    // Apply the standard Remote decorator without requiring a decorator transpiler.
    for (const name of ['history', 'historyPage', 'files', 'status', 'diff']) {
      Remote(GitGraph.prototype[name], {
        kind: 'method', name, static: false, private: false,
        addInitializer: initialize => initialize.call(this),
      });
    }
  }

  // SRC Gateway resolves the `session` parameter from the wire's sessionId and injects
  // `signal`. Never accept a path, a command or options from the client.
  async history(session, signal) {
    return this.readSession(session, 'history', cwd => git.history(cwd, signal, session.id));
  }

  async historyPage(session, cursor, signal) {
    return this.readSession(session, 'historyPage', cwd => git.historyPage(cwd, cursor, signal, session.id));
  }

  async files(session, oid, signal) {
    return this.readSession(session, 'files', cwd => git.files(cwd, oid, signal));
  }

  async status(session, signal) {
    return this.readSession(session, 'status', cwd => git.status(cwd, signal, session.id));
  }

  async diff(session, id, side, signal) {
    return this.readSession(session, 'diff', cwd => git.diff(cwd, id, side, signal, session.id));
  }

  async readSession(session, action, read) {
    if (this.ctx.invocation?.peer.principal.kind !== 'owner') {
      throw new RemoteError('remote-access/denied', 'Git history requires the owner.',
        { action: `gitGraph/${action}`, reason: 'owner-only' });
    }
    if (!session || typeof session.snapshotEvents !== 'function' || typeof session.id !== 'string') {
      throw new RemoteError('git-graph/session', 'Session is unavailable.', {});
    }
    try {
      return await read(this.ctx.workingDirectory.get(session));
    } catch (error) {
      throw new RemoteError(error.code === 'git-graph/restart' ? error.code : 'git-graph/read', error.message, {});
    }
  }
}
