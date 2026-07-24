import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';

const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';
const WORKDIR = process.env.CLAUDE_WORKDIR || process.env.HOME;

// Wraps a single, long-lived `claude --print --input-format stream-json` process.
// One process = one ongoing conversation. If it dies unexpectedly, we respawn
// with --resume so the conversation (Claude's own on-disk session history)
// picks back up rather than starting over.
export class ClaudeBridge extends EventEmitter {
  constructor({ sessionId } = {}) {
    super();
    this.sessionId = sessionId || null;
    this.child = null;
    this.buf = '';
    this.shuttingDown = false;
    this.currentTurn = null; // { tools: [] } accumulator for the in-flight turn
  }

  start() {
    const args = [
      '--print',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--include-partial-messages',
      '--permission-mode', 'bypassPermissions',
      '--verbose',
    ];
    if (this.sessionId) {
      args.push('--resume', this.sessionId);
    } else {
      this.sessionId = randomUUID();
      args.push('--session-id', this.sessionId);
    }

    this.child = spawn(CLAUDE_BIN, args, {
      cwd: WORKDIR,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.buf = '';
    this.child.stdout.on('data', (d) => this._onData(d));
    this.child.stderr.on('data', (d) => this.emit('stderr', d.toString()));
    this.child.on('error', (err) => {
      this.emit('stderr', `spawn error: ${err.message}`);
    });
    this.child.on('exit', (code, signal) => {
      this.emit('exit', { code, signal });
      if (!this.shuttingDown) {
        this.emit('crash');
        setTimeout(() => this.start(), 2000);
      }
    });
  }

  stop() {
    this.shuttingDown = true;
    if (this.child) this.child.kill('SIGTERM');
  }

  send(text) {
    if (!this.child || this.child.stdin.destroyed) {
      throw new Error('claude process not running');
    }
    const line = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text }] },
    });
    this.child.stdin.write(line + '\n');
  }

  _onData(chunk) {
    this.buf += chunk.toString();
    let idx;
    while ((idx = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, idx);
      this.buf = this.buf.slice(idx + 1);
      if (!line.trim()) continue;
      let obj;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }
      this._handleEvent(obj);
    }
  }

  _handleEvent(obj) {
    switch (obj.type) {
      case 'system':
        if (obj.subtype === 'init') {
          this.sessionId = obj.session_id;
          this.emit('ready', { sessionId: this.sessionId });
        }
        break;

      case 'stream_event': {
        const ev = obj.event;
        if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
          this.emit('delta', ev.delta.text);
        }
        break;
      }

      case 'assistant': {
        for (const block of obj.message?.content || []) {
          if (block.type === 'tool_use') {
            this.emit('tool_use', { id: block.id, name: block.name, input: block.input });
          }
        }
        break;
      }

      case 'user': {
        for (const block of obj.message?.content || []) {
          if (block.type === 'tool_result') {
            this.emit('tool_result', {
              toolUseId: block.tool_use_id,
              isError: !!block.is_error,
              content: block.content,
            });
          }
        }
        break;
      }

      case 'result': {
        this.emit('turn_done', {
          text: obj.result || '',
          isError: !!obj.is_error,
          costUsd: obj.total_cost_usd,
        });
        break;
      }

      default:
        break;
    }
  }
}
