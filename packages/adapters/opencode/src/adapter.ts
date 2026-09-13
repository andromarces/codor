import { type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import spawn from 'cross-spawn';

import type {
  ModelCatalog,
  AdapterTurnHooks,
  HarnessAdapter,
  Session,
  SessionRef,
  SpawnOpts,
  ThinkingLevel,
  WireEvent,
} from '@codor/protocol';
import {
  AGENT_PRESET_MAX_MODEL_LENGTH,
  AGENT_PRESET_MODEL_ID_REGEX,
  KNOWN_THINKING_LEVELS,
  normalizeThinkingLevel,
  PolicySchema,
  ThinkingLevelSchema,
} from '@codor/protocol';

import { createTurnTranslator } from './translate.js';

const DISCOVER_QUERY =
  'SELECT id FROM session WHERE parent_id IS NULL ORDER BY time_updated DESC';

// harn:assume harness-declares-supported-thinking-levels ref=opencode-thinking-level-declaration
/**
 * Fixed thinking choices offered for OpenCode. The `--variant` names are
 * per-model variant presets resolved by exact object key, so a bounded custom
 * entry is also accepted (`thinking_custom`). Default omits the variant.
 * OpenCode controls the effective behavior, including its native configuration.
 */
export const OPENCODE_THINKING_LEVELS = ['low', 'medium', 'high'] as const;

export type OpenCodeLine = 'v1' | 'v2' | 'unknown';

/** Fixed failure when the OpenCode line cannot be recognized. No probe output. */
export function unknownOpenCodeLineMessage(token?: string): string {
  return token === undefined
    ? 'opencode line not recognized (probe failed)'
    : `opencode line not recognized (${token})`;
}

/** Fixed failure when a v2 thinking turn has no usable default model. */
export const OPENCODE_V2_EXPLICIT_MODEL_MESSAGE =
  'opencode v2 requires an explicit model to use a thinking value';

function assertThinkingValue(value: string): string {
  const normalized = normalizeThinkingLevel(value);
  if (normalized === '' || !ThinkingLevelSchema.safeParse(normalized).success) {
    throw new Error(
      `unknown thinking level '${value}'; valid levels: ${KNOWN_THINKING_LEVELS.join(', ')}`,
    );
  }
  return normalized;
}

function normalizedSessionThinking(thinking: ThinkingLevel | undefined): string | undefined {
  if (thinking === undefined) return undefined;
  const normalized = normalizeThinkingLevel(thinking);
  if (normalized === '') return undefined;
  if (!ThinkingLevelSchema.safeParse(normalized).success) {
    throw new Error(
      `unknown thinking level '${String(thinking)}'; valid levels: ${KNOWN_THINKING_LEVELS.join(', ')}`,
    );
  }
  return normalized;
}

function invalidPolicy(policy: string): Error {
  return new Error(`unknown policy '${policy}'; valid policies: ${PolicySchema.options.join(', ')}`);
}
// harn:end harness-declares-supported-thinking-levels

export function openCodeAutoApprove(policy: string | undefined): boolean {
  if (policy === undefined) return false;
  if (!PolicySchema.safeParse(policy).success) throw invalidPolicy(policy);
  return policy === 'full-access';
}

/**
 * Inputs that resolve the command, for the detection cache key. Mirrors
 * cross-spawn's resolution: PATH from the merged spawn env (last
 * case-insensitive match on win32), PATHEXT from process.env on win32, and
 * cwd only when it can change resolution (a relative command, or a relative
 * or empty PATH entry). Exported for tests.
 */
export function openCodeDetectionKey(
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): string {
  const pathValue = resolvePathValue(env, platform);
  // PATHEXT is deliberately absent: which resolves extensions against
  // process.env.PATHEXT, which cannot vary between sessions of one daemon.
  const key: Record<string, string> = { path: pathValue };
  if (cwdAffectsResolution(command, pathValue, platform)) key.cwd = cwd;
  return JSON.stringify(key);
}

function resolvePathValue(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string {
  if (platform !== 'win32') return env.PATH ?? '';
  const matches = Object.keys(env).filter((name) => name.toUpperCase() === 'PATH');
  const last = matches.at(-1);
  return last === undefined ? '' : (env[last] ?? '');
}

function isAbsoluteFor(command: string, platform: NodeJS.Platform): boolean {
  if (platform === 'win32') {
    if (/^[a-zA-Z]:[\\/]/.test(command)) return true;
    // A UNC path needs server and share: `//server` and `///x` normalize to
    // the current drive and still resolve against cwd.
    const rest = command.startsWith('\\\\') ? command.slice(2)
      : command.startsWith('//') ? command.slice(2)
      : null;
    if (rest === null) return false;
    const [server, share] = rest.split(/[\\/]/);
    return server !== undefined && server !== '' && share !== undefined && share !== '';
  }
  return command.startsWith('/');
}

function cwdAffectsResolution(command: string, pathValue: string, platform: NodeJS.Platform): boolean {
  // An absolute command never reads PATH, so cwd cannot matter for it. On
  // Windows a bare command searches the session cwd before PATH; on POSIX a
  // relative command with a separator resolves against cwd, and a bare one
  // only through a relative or empty PATH entry.
  if (isAbsoluteFor(command, platform)) return false;
  if (platform === 'win32') return true;
  if (command.includes('/')) return true;
  return pathValue.split(':').some((entry) => entry === '' || !entry.startsWith('/'));
}

/** Successful detections cached per key; unknown results retry on the next turn. */
const DETECTION_CACHE_BOUND = 16;

function cacheDetection(
  cache: Map<string, Promise<{ line: OpenCodeLine; token?: string }>>,
  key: string,
  pending: Promise<{ line: OpenCodeLine; token?: string }>,
): void {
  if (cache.size >= DETECTION_CACHE_BOUND) {
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  cache.set(key, pending);
}
function sanitizeVersionToken(raw: string): string | undefined {
  const token = raw.trim().split(/\s+/)[0] ?? '';
  const clean = token.replace(/[\0-\x1F\x7F]/g, '').slice(0, 32);
  return clean === '' ? undefined : clean;
}

function detectLineFromVersionBanner(banner: string): { line: OpenCodeLine; token?: string } {
  const trimmed = banner.trim();
  if (/^opencode2? v(2\.\d+\.\d+|0\.0\.0-dev-\d+)\b/.test(trimmed)) return { line: 'v2' };
  if (/^(1\.\d+\.\d+|0\.0\.0-dev-\d{12})$/.test(trimmed)) return { line: 'v1' };
  const versionToken = /^opencode2?\s+(v?\S+)/.exec(trimmed)?.[1]
    ?? /^(v?\d\S*|0\.0\.0-dev-\S+)/.exec(trimmed)?.[1];
  const token = versionToken === undefined ? undefined : sanitizeVersionToken(versionToken);
  return token === undefined ? { line: 'unknown' } : { line: 'unknown', token };
}

// harn:assume canonical-spawn-controls-enforced ref=opencode-spawn-control-mapping
export function openCodeArgs(
  session: Session,
  payload: string,
  line: OpenCodeLine,
  modelOverride?: string,
): string[] {
  const autoApprove = openCodeAutoApprove(session.policy);
  const thinking = normalizedSessionThinking(session.thinking);
  const args = ['run', '--format', 'json'];
  const model = modelOverride ?? session.model;
  if (line === 'unknown') {
    throw new Error(unknownOpenCodeLineMessage());
  }
  if (line === 'v1') {
    if (model !== undefined) args.push('--model', model);
    if (autoApprove) args.push('--auto');
    if (thinking !== undefined) args.push('--variant', thinking);
  } else {
    if (thinking !== undefined) {
      if (model === undefined || model === '') throw new Error(OPENCODE_V2_EXPLICIT_MODEL_MESSAGE);
      if (model.includes('#')) throw new Error(OPENCODE_V2_EXPLICIT_MODEL_MESSAGE);
      args.push('--model', `${model}#${thinking}`);
    } else if (model !== undefined) {
      args.push('--model', model);
    }
    if (autoApprove) args.push('--auto');
  }
  if (session.session_ref !== undefined) args.push('--session', session.session_ref);
  args.push(payload);
  return args;
}

/** Direct `opencode run` CLI driver. See NOTES.md for the behavioral sources. */
export class OpenCodeAdapter implements HarnessAdapter {
  readonly id = 'opencode';
  readonly capabilities = {
    resume: true,
    discover: true,
    interactiveAttach: true,
    ask: false,
    approvals: 'spawn-time',
    extensions: false,
    thinking: true,
    thinking_levels: [...OPENCODE_THINKING_LEVELS],
    thinking_custom: true,
    // harn:assume live-inbox-capability-is-evidence-backed-v2 ref=opencode-live-inbox-capability
    live_inbox: false,
    // harn:end live-inbox-capability-is-evidence-backed-v2
    // harn:assume harness-declares-what-a-policy-becomes ref=adapter-policy-declarations
    // Only full-access emits a flag. read-only and workspace-write build IDENTICAL
    // arguments, so neither is enforced by us: both defer to opencode's own rules.
    policies: {
      'read-only': null,
      'workspace-write': null,
      'full-access': '--auto',
    },
    // harn:end harness-declares-what-a-policy-becomes
  } as const;

  private readonly children = new WeakMap<Session, ChildProcess>();
  private readonly lineDetections = new Map<string, Promise<{ line: OpenCodeLine; token?: string }>>();

  constructor(
    private readonly command = 'opencode',
    private readonly probeTimeoutMs = 5_000,
  ) {}

  spawn(opts: SpawnOpts): Session {
    if (opts.policy !== undefined && !PolicySchema.safeParse(opts.policy).success) {
      throw invalidPolicy(opts.policy);
    }
    let thinking: ThinkingLevel | undefined;
    if (opts.thinking !== undefined) {
      const normalized = assertThinkingValue(opts.thinking);
      thinking = normalized as ThinkingLevel;
    }
    return {
      harness: this.id,
      cwd: opts.cwd,
      model: opts.model,
      policy: opts.policy,
      ...(thinking !== undefined && { thinking }),
    };
  }
  // harn:end canonical-spawn-controls-enforced

  private detectLine(session: Session): Promise<{ line: OpenCodeLine; token?: string }> {
    // Successful detections cache per instance under an LRU bound, keyed by
    // PATH (last case-insensitive match on win32) plus cwd exactly when cwd
    // can change resolution. An unknown result is never cached: a transient
    // probe failure must not brick later turns.
    const key = openCodeDetectionKey(this.command, session.cwd, { ...process.env, ...session.env });
    const cached = this.lineDetections.get(key);
    if (cached !== undefined) {
      this.lineDetections.delete(key);
      this.lineDetections.set(key, cached);
      return cached;
    }
    const pending = this.probeLine(session).then((result) => {
      // Delete only our own entry: a concurrent probe may have evicted and
      // replaced it while this one was in flight.
      if (result.line === 'unknown' && this.lineDetections.get(key) === pending) {
        this.lineDetections.delete(key);
      }
      return result;
    });
    cacheDetection(this.lineDetections, key, pending);
    return pending;
  }

  /** Fixed argv, no shell, hard timeout, capped output. Never blocks the event loop. */
  private probeCommand(
    args: string[],
    session: Session,
  ): Promise<{ status: number | null; stdout: string }> {
    return new Promise((resolve) => {
      const child = spawn(this.command, args, {
        cwd: session.cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        // harn:assume adapter-children-inherit-session-env ref=opencode-probe-environment
        env: { ...process.env, ...session.env },
        // harn:end adapter-children-inherit-session-env
      });
      let stdout = '';
      let settled = false;
      const finish = (status: number | null): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { child.kill('SIGKILL'); } catch { /* already exited */ }
        resolve({ status, stdout });
      };
      const timer = setTimeout(() => finish(null), this.probeTimeoutMs);
      timer.unref?.();
      child.stdout?.setEncoding('utf8');
      child.stderr?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => {
        stdout = `${stdout}${chunk}`.slice(-1_000_000);
      });
      // Drain stderr so a chatty probe can never wedge on a full pipe buffer.
      child.stderr?.on('data', () => undefined);
      child.once('error', () => finish(null));
      child.once('close', (code) => finish(code));
    });
  }

  private async probeLine(session: Session): Promise<{ line: OpenCodeLine; token?: string }> {
    const version = await this.probeCommand(['--version'], session);
    if (version.status !== 0) return { line: 'unknown' };
    const banner = version.stdout.split('\n')[0] ?? '';
    // An empty banner still takes the capability fallback: a command that
    // prints its version to stderr classifies via `run --help`.
    const direct = detectLineFromVersionBanner(banner);
    if (direct.line !== 'unknown') return direct;
    if (direct.token !== undefined) {
      // A version-shaped banner outside both families may still resolve via
      // the capability fallback; otherwise the token identifies the failure.
      const fallback = await this.detectLineFromHelp(session);
      if (fallback.line !== 'unknown') return fallback;
      return direct;
    }
    return this.detectLineFromHelp(session);
  }

  private async detectLineFromHelp(session: Session): Promise<{ line: OpenCodeLine; token?: string }> {
    const help = await this.probeCommand(['run', '--help'], session);
    if (help.status !== 0) return { line: 'unknown' };
    const hasVariantFlag = help.stdout.includes('--variant');
    const hasHashVariant = help.stdout.includes('#variant');
    if (hasVariantFlag && !hasHashVariant) return { line: 'v1' };
    if (hasHashVariant && !hasVariantFlag) return { line: 'v2' };
    return { line: 'unknown' };
  }

  private resolveV2DefaultModel(session: Session): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const child = spawn(this.command, ['api', 'GET', '/api/model/default'], {
        cwd: session.cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        // harn:assume adapter-children-inherit-session-env ref=opencode-default-model-environment
        env: { ...process.env, ...session.env },
        // harn:end adapter-children-inherit-session-env
      });
      let stdout = '';
      let stderr = '';
      let settled = false;
      const fail = (error: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { child.kill('SIGKILL'); } catch { /* already exited */ }
        reject(error);
      };
      const timer = setTimeout(() => {
        fail(new Error(OPENCODE_V2_EXPLICIT_MODEL_MESSAGE));
      }, 5_000);
      timer.unref?.();
      child.stdout?.setEncoding('utf8');
      child.stderr?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => {
        stdout = `${stdout}${chunk}`.slice(-1_000_000);
        if (stdout.length >= 1_000_000) fail(new Error(OPENCODE_V2_EXPLICIT_MODEL_MESSAGE));
      });
      child.stderr?.on('data', (chunk: string) => {
        stderr = `${stderr}${chunk}`.slice(-8192);
      });
      child.once('error', () => fail(new Error(OPENCODE_V2_EXPLICIT_MODEL_MESSAGE)));
      child.once('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (code !== 0) {
          reject(new Error(OPENCODE_V2_EXPLICIT_MODEL_MESSAGE));
          return;
        }
        try {
          const parsed = JSON.parse(stdout) as { data?: unknown };
          const data = parsed.data as { providerID?: unknown; id?: unknown } | null | undefined;
          if (typeof data !== 'object' || data === null) {
            reject(new Error(OPENCODE_V2_EXPLICIT_MODEL_MESSAGE));
            return;
          }
          const { providerID, id } = data;
          if (typeof providerID !== 'string' || providerID === ''
            || typeof id !== 'string' || id === '') {
            reject(new Error(OPENCODE_V2_EXPLICIT_MODEL_MESSAGE));
            return;
          }
          const reference = `${providerID}/${id}`;
          if (reference.includes('#')
            || reference.length > AGENT_PRESET_MAX_MODEL_LENGTH
            || !AGENT_PRESET_MODEL_ID_REGEX.test(reference)) {
            reject(new Error(OPENCODE_V2_EXPLICIT_MODEL_MESSAGE));
            return;
          }
          resolve(reference);
        } catch {
          reject(new Error(OPENCODE_V2_EXPLICIT_MODEL_MESSAGE));
        }
      });
    });
  }

  // harn:assume adapters-own-their-model-catalog ref=opencode-model-discovery
  /**
   * opencode's models come from the operator's OWN configured providers, so no
   * fixed list can be right for every install — ask the CLI. Fixed argv (no
   * shell), hard timeout, capped output; a failure throws and the daemon
   * silently degrades this harness to the custom escape.
   */
  async listModels(): Promise<ModelCatalog> {
    const result = spawn.sync(this.command, ['models'], {
      timeout: 5_000,
      maxBuffer: 1_000_000,
      encoding: 'utf8',
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`Command failed: ${this.command} models`);
    const listed = result.stdout;
    const models = listed.split('\n').map((line) => line.trim()).filter((line) => line !== '');
    if (models.length === 0) throw new Error('opencode listed no models');
    return { models, source: 'discovered' };
  }
  // harn:end adapters-own-their-model-catalog

  attach(session_ref: SessionRef): Session {
    return { harness: this.id, session_ref, cwd: process.cwd() };
  }

  // harn:assume windows-cli-adapters-resolve-command-shims ref=windows-cli-spawn-provider
  // harn:assume remaining-cli-adapters-use-supervised-subprocesses ref=opencode-cli-subprocess-driver
  // harn:assume adapter-process-lifecycle-supervised ref=opencode-cli-process-supervision
  async *deliver(
    session: Session,
    payload: string,
    hooks: AdapterTurnHooks = {},
  ): AsyncIterable<WireEvent> {
    const detected = await this.detectLine(session);
    if (detected.line === 'unknown') {
      const translator = createTurnTranslator();
      yield* translator.end({
        status: 'failed',
        final_text: unknownOpenCodeLineMessage(detected.token),
      });
      return;
    }
    let thinking: string | undefined;
    try {
      thinking = normalizedSessionThinking(session.thinking);
    } catch (error) {
      const translator = createTurnTranslator();
      yield* translator.end({
        status: 'failed',
        final_text: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    let modelForTurn = session.model;
    if (detected.line === 'v2' && thinking !== undefined && modelForTurn === undefined) {
      try {
        modelForTurn = await this.resolveV2DefaultModel(session);
      } catch (error) {
        const translator = createTurnTranslator();
        yield* translator.end({
          status: 'failed',
          final_text: error instanceof Error ? error.message : String(error),
        });
        return;
      }
    }
    let args: string[];
    try {
      const sessionForArgs: Session = thinking === undefined
        ? { ...session, thinking: undefined }
        : { ...session, thinking: thinking as ThinkingLevel };
      args = openCodeArgs(sessionForArgs, payload, detected.line, modelForTurn);
    } catch (error) {
      const translator = createTurnTranslator();
      yield* translator.end({
        status: 'failed',
        final_text: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    const child = spawn(this.command, args, {
      cwd: session.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
      // harn:assume adapter-children-inherit-session-env ref=opencode-child-environment
      env: { ...process.env, ...session.env },
      // harn:end adapter-children-inherit-session-env
    });
    this.children.set(session, child);

    let stderr = '';
    child.stderr!.setEncoding('utf8');
    child.stderr!.on('data', (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-8192);
    });
    let childError: Error | undefined;
    const spawned = new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', (error) => {
        childError = error;
        reject(error);
      });
    });
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve) => child.once('close', (code, signal) => resolve({ code, signal })),
    );

    const translator = createTurnTranslator();
    let reportedSessionRef: string | undefined;
    const reportSessionRef = (): void => {
      const discovered = translator.sessionId();
      if (discovered === undefined || discovered === reportedSessionRef) return;
      session.session_ref = discovered;
      reportedSessionRef = discovered;
      hooks.onSessionRef?.(discovered);
    };

    try {
      try {
        await spawned;
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        yield* translator.end({ status: 'failed', final_text: detail });
        return;
      }
      hooks.onStarted?.({ pid: child.pid, process_group_id: child.pid });

      const lines = createInterface({ input: child.stdout! });
      for await (const line of lines) {
        for (const event of translator.push(line)) {
          reportSessionRef();
          yield event;
        }
        reportSessionRef();
      }
      const exit = await closed;
      const detail = stderr.trim() || childError?.message;
      const status = childError !== undefined || (exit.code !== null && exit.code !== 0)
        ? 'failed'
        : exit.code === 0
          ? 'completed'
          : 'interrupted';
      yield* translator.end({
        status,
        ...(status !== 'completed' && detail !== undefined && detail !== '' && { final_text: detail }),
      });
    } finally {
      this.children.delete(session);
      if (child.exitCode === null && child.signalCode === null) this.signal(child, 'SIGKILL');
    }
  }

  interrupt(session: Session): void {
    const child = this.children.get(session);
    if (child) this.signal(child, 'SIGINT');
  }

  // harn:assume member-context-reset-is-authorized-atomic-and-lazy ref=first-party-cli-session-reset
  resetSession(session: Session | undefined): Promise<void> {
    const child = session === undefined ? undefined : this.children.get(session);
    if (child !== undefined) {
      return Promise.reject(new Error('cannot clear OpenCode context while a turn process is still retiring'));
    }
    if (session !== undefined) this.children.delete(session);
    return Promise.resolve();
  }
  // harn:end member-context-reset-is-authorized-atomic-and-lazy

  private signal(child: ChildProcess, signal: NodeJS.Signals): void {
    if (child.pid === undefined) return;
    try {
      process.kill(-child.pid, signal);
    } catch {
      child.kill(signal);
    }
  }
  // harn:end adapter-process-lifecycle-supervised
  // harn:end remaining-cli-adapters-use-supervised-subprocesses
  // harn:end windows-cli-adapters-resolve-command-shims

  respondInteraction(): Promise<void> {
    return Promise.reject(
      new Error('opencode run owns headless permissions and exposes no response channel'),
    );
  }

  discoverSessions(): SessionRef[] {
    const result = spawn.sync(this.command, ['db', '--format', 'json', DISCOVER_QUERY], {
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
    });
    if (result.error || result.status !== 0) return [];
    try {
      const sessions = JSON.parse(result.stdout) as { id?: unknown }[];
      if (!Array.isArray(sessions)) return [];
      return sessions.flatMap((session) =>
        typeof session.id === 'string' && session.id !== '' ? [session.id] : [],
      );
    } catch {
      return [];
    }
  }
}
// harn:assume opencode-capability-truth ref=opencode-capability-conformance
// Capability declarations above are exercised by fixture, translator, subprocess,
// CLI attach, and the recorded single-shot live PONG conformance tests.
// harn:end opencode-capability-truth
