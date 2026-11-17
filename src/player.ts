import { spawn, spawnSync, type ChildProcess } from 'node:child_process';

interface Backend {
  name: string;
  command: string;
  args(file: string): string[];
}

function hasCommand(command: string): boolean {
  const probe = process.platform === 'win32' ? 'where' : 'which';
  const result = spawnSync(probe, [command], { stdio: 'ignore' });
  return result.status === 0;
}

function powershellArgs(file: string): string[] {
  const escaped = file.replace(/'/g, "''");
  return [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    `(New-Object Media.SoundPlayer '${escaped}').PlaySync()`,
  ];
}

function backendFor(name: string): Backend | undefined {
  switch (name) {
    case 'afplay':
      return { name, command: 'afplay', args: (file) => [file] };
    case 'mpv':
      return {
        name,
        command: 'mpv',
        args: (file) => ['--no-video', '--really-quiet', '--no-terminal', file],
      };
    case 'ffplay':
      return {
        name,
        command: 'ffplay',
        args: (file) => ['-nodisp', '-autoexit', '-loglevel', 'quiet', file],
      };
    case 'paplay':
      return { name, command: 'paplay', args: (file) => [file] };
    case 'aplay':
      return { name, command: 'aplay', args: (file) => ['-q', file] };
    case 'play':
      return { name, command: 'play', args: (file) => ['-q', file] };
    case 'cvlc':
      return {
        name,
        command: 'cvlc',
        args: (file) => ['--play-and-exit', '--intf', 'dummy', file],
      };
    case 'powershell':
      return {
        name,
        command: 'powershell.exe',
        args: powershellArgs,
      };
    default:
      return undefined;
  }
}

export interface PlayerConfig {
  player: string;
  playerArgs: string[];
  debug?: (message: string) => void;
}

export class AudioPlayer {
  private backend: Backend | null = null;
  private child: ChildProcess | null = null;
  private readonly debug?: (message: string) => void;

  constructor(private readonly config: PlayerConfig) {
    this.debug = config.debug;
    this.backend = this.detect();
  }

  get name(): string {
    return this.backend?.name ?? 'none';
  }

  get available(): boolean {
    return this.backend !== null;
  }

  private detect(): Backend | null {
    if (this.config.player !== 'auto') {
      const known = backendFor(this.config.player);
      if (known) {
        if (this.config.player === 'powershell' || hasCommand(known.command)) return known;
        return null;
      }
      if (hasCommand(this.config.player)) {
        return {
          name: this.config.player,
          command: this.config.player,
          args: (file) => [...this.config.playerArgs, file],
        };
      }
      return null;
    }

    const candidates =
      process.platform === 'darwin'
        ? ['afplay', 'mpv', 'ffplay']
        : process.platform === 'win32'
          ? ['powershell']
          : ['mpv', 'ffplay', 'paplay', 'aplay', 'play', 'cvlc'];

    for (const name of candidates) {
      const backend = backendFor(name);
      if (backend && hasCommand(backend.command)) return backend;
    }
    return null;
  }

  async play(file: string): Promise<void> {
    const backend = this.backend;
    if (!backend) throw new Error('No audio player found. Set the "player" option to an installed command.');
    const args = backend.name === 'powershell'
      ? backend.args(file)
      : [...this.config.playerArgs, ...backend.args(file)];

    this.debug?.(`playing with ${backend.name}`);
    await new Promise<void>((resolve, reject) => {
      const child = spawn(backend.command, args, {
        stdio: ['ignore', 'ignore', 'pipe'],
        windowsHide: true,
      });
      this.child = child;
      let stderr = '';
      child.stderr?.on('data', (data: Buffer) => {
        stderr = (stderr + data.toString()).slice(-500);
      });
      child.on('error', (error) => {
        if (this.child === child) this.child = null;
        reject(error);
      });
      child.on('exit', (code, signal) => {
        if (this.child === child) this.child = null;
        if (code === 0 || signal) resolve();
        else reject(new Error(`${backend.name} exited with code ${code}${stderr ? `: ${stderr.trim()}` : ''}`));
      });
    });
  }

  stop(): void {
    if (!this.child) return;
    const child = this.child;
    this.child = null;
    child.kill('SIGTERM');
  }
}
