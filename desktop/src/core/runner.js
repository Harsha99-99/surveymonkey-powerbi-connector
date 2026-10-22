/**
 * runner.js
 *
 * The real machine-facing side of `ctx` in steps.js: runs commands in
 * PowerShell, starts and stops background processes, probes ports and calls
 * the connector.
 *
 * Commands run through `powershell.exe -Command`, the same shell the README's
 * Windows section is written for, so a command behaves here exactly as it
 * does when someone pastes it into PowerShell.
 */

const { spawn, spawnSync } = require('node:child_process');
const net = require('node:net');

const PS_ARGS = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command'];

// UTF-8 output so names and survey titles survive the trip into the app.
const UTF8_PREFIX = '[Console]::OutputEncoding = [Text.Encoding]::UTF8; $OutputEncoding = [Text.Encoding]::UTF8; ';

// A command like reading a whole table back can print thousands of lines.
const MAX_LINES_PER_COMMAND = 300;

class Runner {
  /**
   * @param {object} opts
   * @param {(text: string) => void} opts.onOutput receives every line of output
   * @param {(text: string) => string} [opts.redact] scrubs secrets before output
   */
  constructor({ onOutput, redact = (t) => t }) {
    this.onOutput = onOutput;
    this.redact = redact;
    this.env = { ...process.env };
    this.background = new Map();
  }

  /**
   * Picks up PATH changes made by installers since this app started, which is
   * what lets a freshly installed `node` or `func` be found without restarting.
   */
  refreshPath() {
    const result = spawnSync(
      'powershell.exe',
      [
        ...PS_ARGS,
        "[Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')",
      ],
      { encoding: 'utf8', windowsHide: true }
    );
    const value = result.status === 0 ? String(result.stdout).trim() : '';
    if (value) {
      delete this.env.PATH;
      this.env.Path = value;
    }
  }

  run(command, cwd) {
    return new Promise((resolve) => {
      const child = this.#spawn(command, cwd);
      const collected = [];
      const emit = this.#lineEmitter(collected);

      child.stdout.on('data', emit);
      child.stderr.on('data', emit);
      child.on('error', (err) => resolve({ code: -1, output: err.message }));
      child.on('close', (code) => {
        emit.flush();
        resolve({ code: code === null ? -1 : code, output: collected.join('\n') });
      });
    });
  }

  startBackground(id, command, cwd) {
    const child = this.#spawn(command, cwd);
    const emit = this.#lineEmitter(null);
    child.stdout.on('data', emit);
    child.stderr.on('data', emit);

    const exited = new Promise((resolve) => {
      child.on('error', () => resolve(-1));
      child.on('close', (code) => {
        emit.flush();
        resolve(code);
      });
    });
    exited.then(() => {
      if (this.background.get(id) === child) this.background.delete(id);
    });

    this.background.set(id, child);
    return { exited };
  }

  isRunning(id) {
    return this.background.has(id);
  }

  /** Stops one background process this app started, including its children. */
  stop(id) {
    const child = this.background.get(id);
    if (!child) return false;
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
    this.background.delete(id);
    return true;
  }

  /** Stops every background process this app started, including its children. */
  stopAll() {
    for (const child of this.background.values()) {
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
    }
    this.background.clear();
  }

  #spawn(command, cwd) {
    return spawn('powershell.exe', [...PS_ARGS, UTF8_PREFIX + command], {
      cwd: cwd || undefined,
      env: this.env,
      windowsHide: true,
    });
  }

  /** Splits output into lines, redacts them, and caps how many are shown. */
  #lineEmitter(collected) {
    let shown = 0;
    let buffered = '';

    const handle = (raw) => {
      const line = this.redact(raw);
      if (collected) collected.push(line);
      if (collected === null || shown < MAX_LINES_PER_COMMAND) {
        this.onOutput(line);
      } else if (shown === MAX_LINES_PER_COMMAND) {
        this.onOutput('… (more output hidden)');
      }
      shown += 1;
    };

    const emit = (chunk) => {
      buffered += chunk.toString('utf8');
      const lines = buffered.split(/\r?\n/);
      buffered = lines.pop();
      lines.forEach(handle);
    };
    emit.flush = () => {
      if (buffered) handle(buffered);
      buffered = '';
    };
    return emit;
  }
}

function isPortOpen(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const socket = net.connect(port, host);
    const finish = (open) => {
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(1000, () => finish(false));
    socket.on('connect', () => finish(true));
    socket.on('error', () => finish(false));
  });
}

async function fetchJson(url, options = {}) {
  try {
    const response = await fetch(url, { ...options, signal: AbortSignal.timeout(15000) });
    const text = await response.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
    return { status: response.status, body };
  } catch {
    return { status: 0, body: null };
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

module.exports = { Runner, isPortOpen, fetchJson, sleep, MAX_LINES_PER_COMMAND };
