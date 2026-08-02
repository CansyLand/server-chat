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
  constructor({ sessionId, workdir, systemPrompt, model, effort, extraEnv } = {}) {
    super();
    this.sessionId = sessionId || null;
    this.workdir = workdir || WORKDIR;
    this.systemPrompt = systemPrompt || null;
    this.model = model || null;
    this.effort = effort || null;
    this.extraEnv = extraEnv || null;
    this.child = null;
    this.buf = '';
    this.shuttingDown = false;
    this.interrupting = false;
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
    if (this.systemPrompt) {
      args.push('--append-system-prompt', this.systemPrompt);
    }
    if (this.model) {
      args.push('--model', this.model);
    }
    if (this.effort) {
      args.push('--effort', this.effort);
    }
    if (this.sessionId) {
      args.push('--resume', this.sessionId);
    } else {
      this.sessionId = randomUUID();
      args.push('--session-id', this.sessionId);
    }

    this.child = spawn(CLAUDE_BIN, args, {
      cwd: this.workdir,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: this.extraEnv ? { ...process.env, ...this.extraEnv } : process.env,
    });

    this.buf = '';
    this.child.stdout.on('data', (d) => this._onData(d));
    this.child.stderr.on('data', (d) => this.emit('stderr', d.toString()));
    this.child.on('error', (err) => {
      this.emit('stderr', `spawn error: ${err.message}`);
    });
    this.child.on('exit', (code, signal) => {
      this.emit('exit', { code, signal });
      if (this.shuttingDown) return;
      if (this.interrupting) {
        // A deliberate stop, not a crash: the CLI handles SIGINT by ending
        // the current turn cleanly (emits its usual 'result' first) and
        // exiting 0 — respawn immediately with --resume, no delay, no
        // 'crash' event, since nothing actually went wrong.
        this.interrupting = false;
        this.start();
        return;
      }
      this.emit('crash');
      setTimeout(() => this.start(), 2000);
    });
  }

  stop() {
    this.shuttingDown = true;
    if (this.child) this.child.kill('SIGTERM');
  }

  // Interrupts the in-flight turn only — verified empirically that the CLI
  // responds to SIGINT by emitting a normal 'result' event (marked as an
  // error/incomplete) for whatever was generated so far, then exits 0,
  // rather than being killed mid-write or hanging.
  interrupt() {
    if (!this.child) return;
    this.interrupting = true;
    this.child.kill('SIGINT');
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
          // The CLI reports its own currently-available slash commands
          // (built-ins + whatever skills/plugins/custom commands are
          // installed) on every session start — forwarding this straight
          // through means the suggestion list is never our own stale copy.
          this.emit('ready', { sessionId: this.sessionId, slashCommands: obj.slash_commands || [] });
        }
        break;

      case 'stream_event': {
        const ev = obj.event;
        if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
          this.emit('delta', ev.delta.text);
        } else if (ev?.type === 'content_block_start' && ev.content_block?.type === 'thinking') {
          this.emit('thinking_start');
        } else if (ev?.type === 'content_block_delta' && ev.delta?.type === 'thinking_delta') {
          // On Anthropic-native models, extended thinking is redacted before
          // it ever reaches the CLI: `thinking` here is always "" and only
          // estimated_tokens is real. OpenRouter models (no server-side
          // redaction) stream actual text through this same field. Both
          // cases are forwarded as-is; the caller decides how to render an
          // empty-text delta (token-count-only progress) versus a real one.
          this.emit('thinking_delta', { text: ev.delta.thinking || '', estimatedTokens: ev.delta.estimated_tokens ?? null });
        }
        break;
      }

      case 'assistant': {
        for (const block of obj.message?.content || []) {
          if (block.type === 'tool_use') {
            this.emit('tool_use', { id: block.id, name: block.name, input: block.input });
          } else if (block.type === 'thinking' && block.thinking) {
            // Only emitted when the final block actually carries text (i.e.
            // not redacted) — the redacted case already got its progress
            // signal from the thinking_delta token counts above.
            this.emit('thinking_final', { text: block.thinking });
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
