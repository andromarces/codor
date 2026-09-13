import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

import type { WireEvent } from '@codor/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import {
  OPENCODE_THINKING_LEVELS,
  OPENCODE_V2_EXPLICIT_MODEL_MESSAGE,
  OpenCodeAdapter,
  openCodeArgs,
  openCodeAutoApprove,
  openCodeDetectionKey,
  unknownOpenCodeLineMessage,
} from './adapter.js';

const dirs: string[] = [];

function executable(source: string, version = '1.18.30'): string {
  const dir = mkdtempSync(join(tmpdir(), 'codor-opencode-adapter-'));
  dirs.push(dir);
  const path = join(dir, 'fake-opencode');
  writeFileSync(path, `#!/usr/bin/env node\nif (process.argv[2] === '--version') { console.log(${JSON.stringify(version)}); process.exit(0); }\n${source}`);
  chmodSync(path, 0o755);
  return path;
}

async function collect(adapter: OpenCodeAdapter): Promise<WireEvent[]> {
  const events: WireEvent[] = [];
  for await (const event of adapter.deliver(adapter.spawn({ cwd: process.cwd() }), 'hello')) {
    events.push(event);
  }
  return events;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('OpenCode subprocess and capability conformance', () => {
  it('enables CLI-owned auto approval only for explicit full-access policies', () => {
    expect(openCodeAutoApprove('read-only')).toBe(false);
    expect(openCodeAutoApprove('workspace-write')).toBe(false);
    expect(openCodeAutoApprove('full-access')).toBe(true);
    expect(() => openCodeAutoApprove('auto')).toThrow('valid policies');
  });

  // harn:assume harness-declares-supported-thinking-levels ref=opencode-thinking-level-regression
  // Requirement: the adapter declares fixed levels plus custom entry and
  // normalizes at spawn. Non-redundant: the only capability-shape proof.
  it('declares fixed thinking levels plus a bounded custom entry, normalized at the boundary', () => {
    // Verifies the issue #30 restore: low/medium/high are offered again and a
    // custom exact-key variant is accepted; malformed shapes are refused.
    expect([...OPENCODE_THINKING_LEVELS]).toEqual(['low', 'medium', 'high']);
    const capabilities = new OpenCodeAdapter().capabilities;
    expect(capabilities.thinking).toBe(true);
    expect(capabilities.thinking_levels).toEqual(['low', 'medium', 'high']);
    expect(capabilities.thinking_custom).toBe(true);
    expect(new OpenCodeAdapter().spawn({ cwd: '/work', thinking: 'low' }).thinking).toBe('low');
    expect(new OpenCodeAdapter().spawn({ cwd: '/work', thinking: 'extreme' }).thinking)
      .toBe('extreme');
    expect(new OpenCodeAdapter().spawn({ cwd: '/work', thinking: ' HIGH ' }).thinking)
      .toBe('high');
    expect(new OpenCodeAdapter().spawn({ cwd: '/work', thinking: 'Minimal' }).thinking)
      .toBe('Minimal');
    expect(new OpenCodeAdapter().spawn({ cwd: '/work' }).thinking).toBeUndefined();
    for (const bad of ['has space', 'bad#value', '-lead', 'a\nb']) {
      expect(() => new OpenCodeAdapter().spawn({ cwd: '/work', thinking: bad as 'low' }))
        .toThrow('unknown thinking level');
    }
  });
  // harn:end harness-declares-supported-thinking-levels

  it('passes JSON, model, auto, resume, payload, and cwd without stdin', async () => {
    const command = executable(`
const fs = require('node:fs');
const detail = JSON.stringify({argv:process.argv.slice(2),cwd:process.cwd(),input:fs.readFileSync(0,'utf8')});
console.log(JSON.stringify({type:'step_start',sessionID:'ses_existing',part:{type:'step-start'}}));
console.log(JSON.stringify({type:'text',sessionID:'ses_existing',part:{type:'text',text:detail,time:{start:1,end:2}}}));
console.log(JSON.stringify({type:'step_finish',sessionID:'ses_existing',part:{type:'step-finish',tokens:{input:1,output:2},cost:0.01}}));
`);
    const adapter = new OpenCodeAdapter(command);
    const cwd = mkdtempSync(join(tmpdir(), 'codor-opencode-cwd-'));
    dirs.push(cwd);
    const session = adapter.attach('ses_existing');
    session.cwd = cwd;
    session.model = 'opencode/deepseek-v4-flash-free';
    session.policy = 'full-access';
    const events: WireEvent[] = [];
    for await (const event of adapter.deliver(session, 'PONG')) events.push(event);
    const done = events.at(-1) as Extract<WireEvent, { type: 'run.completed' }>;
    expect(JSON.parse(done.final_text!)).toEqual({
      argv: [
        'run', '--format', 'json',
        '--model', 'opencode/deepseek-v4-flash-free',
        '--auto',
        '--session', 'ses_existing',
        'PONG',
      ],
      cwd: realpathSync(cwd),
      input: '',
    });
    expect(done.usage).toEqual({ input_tokens: 1, output_tokens: 2, cost_usd: 0.01 });
    expect(session.session_ref).toBe('ses_existing');
  });

  it('turns missing commands and nonzero exits into failed runs', async () => {
    expect((await collect(new OpenCodeAdapter('/definitely/missing/codor-opencode'))).at(-1))
      .toMatchObject({ type: 'run.completed', status: 'failed' });
    const command = executable("process.stderr.write('native failure\\n'); process.exit(7);\n");
    expect((await collect(new OpenCodeAdapter(command))).at(-1)).toMatchObject({
      type: 'run.completed',
      status: 'failed',
      final_text: 'native failure',
    });
  });

  it('discovers every root id through the documented global JSON database command', () => {
    const command = executable(`
const expected = ['db','--format','json','SELECT id FROM session WHERE parent_id IS NULL ORDER BY time_updated DESC'];
if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(expected)) process.exit(3);
console.log(JSON.stringify([{id:'ses_first'},{id:'ses_second'},{title:'missing id'}]));
`);
    expect(new OpenCodeAdapter(command).discoverSessions()).toEqual(['ses_first', 'ses_second']);
  });

  it('rejects interaction responses because run owns headless permissions', async () => {
    await expect(new OpenCodeAdapter().respondInteraction()).rejects.toThrow(
      'no response channel',
    );
  });
});

// harn:assume adapter-children-inherit-session-env ref=opencode-env-regression
describe('member environment inheritance', () => {
  it('merges session values over the inherited process environment', async () => {
    const command = executable(`
const detail = JSON.stringify({home:process.env.HOME,path:process.env.PATH,member:process.env.CODOR_TEST_SESSION_ENV});
console.log(JSON.stringify({type:'step_start',sessionID:'ses_env',part:{type:'step-start'}}));
console.log(JSON.stringify({type:'text',sessionID:'ses_env',part:{type:'text',text:detail,time:{start:1,end:2}}}));
console.log(JSON.stringify({type:'step_finish',sessionID:'ses_env',part:{type:'step-finish',tokens:{input:1,output:1},cost:0}}));
`);
    const adapter = new OpenCodeAdapter(command);
    const session = adapter.spawn({ cwd: process.cwd() });
    session.env = { HOME: '/codor/session-home', CODOR_TEST_SESSION_ENV: 'member-value' };
    const events: WireEvent[] = [];
    for await (const event of adapter.deliver(session, 'hello')) events.push(event);
    const done = events.at(-1) as Extract<WireEvent, { type: 'run.completed' }>;

    expect(adapter.capabilities.live_inbox).toBe(false);
    expect(JSON.parse(done.final_text!)).toEqual({
      home: '/codor/session-home', path: process.env.PATH, member: 'member-value',
    });
  });
});
// harn:end adapter-children-inherit-session-env

// harn:assume adapters-own-their-model-catalog ref=opencode-model-discovery
describe('opencode model discovery', () => {
  // harn:assume windows-cli-adapters-resolve-command-shims ref=windows-cli-spawn-regression
  const stub = (nodeSource: string): string => {
    const dir = mkdtempSync(join(tmpdir(), 'codor-opencode-models-'));
    const command = join(dir, 'opencode');
    writeFileSync(command, `#!/usr/bin/env node\n${nodeSource}`);
    chmodSync(command, 0o755);
    return command;
  };

  it('reports the models the operator’s own installation configured', async () => {
    // opencode's catalog is per-installation, so it is asked, never hardcoded.
    const command = stub('console.log("anthropic/claude-sonnet-5\\nopenai/gpt-4o");');
    const catalog = await new OpenCodeAdapter(command).listModels();
    expect(catalog).toEqual({
      models: ['anthropic/claude-sonnet-5', 'openai/gpt-4o'],
      source: 'discovered',
    });
  });

  it('fails rather than reporting an empty catalog as fact', async () => {
    await expect(new OpenCodeAdapter(stub('process.exit(0);')).listModels()).rejects.toThrow();
  });

  it('fails when the harness is not installed', async () => {
    await expect(new OpenCodeAdapter('/definitely/missing/codor-opencode').listModels())
      .rejects.toThrow();
  });

  it('fails when the harness exits non-zero', async () => {
    await expect(new OpenCodeAdapter(stub('process.stderr.write("boom\\n"); process.exit(1);')).listModels())
      .rejects.toThrow();
  });
  // harn:end windows-cli-adapters-resolve-command-shims
});

// harn:assume harness-declares-what-a-policy-becomes ref=adapter-policy-regression
describe('the declared policy mapping matches the arguments actually built', () => {
  it('declares a flag only where it emits one, and null where it enforces nothing', () => {
    const { policies } = new OpenCodeAdapter().capabilities;
    for (const [policy, native] of Object.entries(policies)) {
      const args = openCodeArgs({ harness: 'opencode', cwd: '/work', policy }, 'go', 'v1');
      expect(args.includes('--auto'), policy).toBe(native !== null);
      expect(openCodeAutoApprove(policy), policy).toBe(native !== null);
    }
    expect(policies['read-only']).toBeNull();
    expect(policies['workspace-write']).toBeNull();
  });

  it('builds the SAME arguments for both unenforced levels', () => {
    const base = { harness: 'opencode', cwd: '/work' };
    expect(openCodeArgs({ ...base, policy: 'read-only' }, 'go', 'v1'))
      .toEqual(openCodeArgs({ ...base, policy: 'workspace-write' }, 'go', 'v1'));
  });
});

// harn:assume harness-declares-supported-thinking-levels ref=opencode-line-argv-regression
describe('opencode line detection and per-line argv', () => {
  const runSuccess = `
if (process.argv[2] === 'run' && process.argv[3] !== '--help') {
  const fs = require('node:fs');
  fs.writeFileSync(RUN_LOG, JSON.stringify(process.argv.slice(2)));
  console.log(JSON.stringify({type:'step_start',sessionID:'ses_line',part:{type:'step-start'}}));
  console.log(JSON.stringify({type:'text',sessionID:'ses_line',part:{type:'text',text:'ok',time:{start:1,end:2}}}));
  console.log(JSON.stringify({type:'step_finish',sessionID:'ses_line',part:{type:'step-finish',tokens:{input:1,output:1},cost:0}}));
  process.exit(0);
}
`;

  function lineFake(options: {
    version?: string;
    versionExit?: number;
    help?: string;
    versionLog?: string;
    runLog?: string;
    apiBody?: unknown;
    apiExit?: number;
    apiHang?: boolean;
    apiLog?: string;
  }): string {
    const dir = mkdtempSync(join(tmpdir(), 'codor-opencode-line-'));
    dirs.push(dir);
    const path = join(dir, 'fake-opencode');
    const runLog = options.runLog ?? join(dir, 'run-argv.json');
    const lines: string[] = [
      '#!/usr/bin/env node',
      'const fs = require(\'node:fs\');',
      `const RUN_LOG = ${JSON.stringify(runLog)};`,
    ];
    lines.push('const argv = process.argv.slice(2);');
    lines.push('if (argv[0] === \'--version\') {');
    if (options.versionLog !== undefined) {
      lines.push(`  fs.appendFileSync(${JSON.stringify(options.versionLog)}, 'version\\n');`);
    }
    if (options.versionExit !== undefined && options.versionExit !== 0) {
      lines.push(`  process.stderr.write('version boom\\n'); process.exit(${String(options.versionExit)});`);
    } else {
      lines.push(`  console.log(${JSON.stringify(options.version ?? '1.18.30')}); process.exit(0);`);
    }
    lines.push('}');
    lines.push('if (argv[0] === \'run\' && argv[1] === \'--help\') {');
    if (options.help === undefined) {
      lines.push('  process.exit(1);');
    } else {
      lines.push(`  console.log(${JSON.stringify(options.help)}); process.exit(0);`);
    }
    lines.push('}');
    lines.push('if (argv[0] === \'api\') {');
    if (options.apiLog !== undefined) {
      lines.push(`  fs.appendFileSync(${JSON.stringify(options.apiLog)}, 'api\\n');`);
    }
    if (options.apiHang === true) {
      lines.push('  setInterval(() => {}, 1000);');
    } else if (options.apiExit !== undefined && options.apiExit !== 0) {
      lines.push(`  process.exit(${String(options.apiExit)});`);
    } else if (options.apiBody !== undefined) {
      const body = typeof options.apiBody === 'string'
        ? options.apiBody
        : JSON.stringify(options.apiBody);
      lines.push(`  console.log(${JSON.stringify(body)}); process.exit(0);`);
    } else {
      lines.push('  process.exit(1);');
    }
    lines.push('}');
    lines.push(runSuccess);
    lines.push('process.stderr.write(\'unexpected argv \' + JSON.stringify(argv) + \'\\n\'); process.exit(7);');
    writeFileSync(path, lines.join('\n'));
    chmodSync(path, 0o755);
    return path;
  }

  async function deliverOnce(command: string, session: Parameters<OpenCodeAdapter['deliver']>[0], payload = 'hi'): Promise<WireEvent[]> {
    const adapter = new OpenCodeAdapter(command);
    const events: WireEvent[] = [];
    for await (const event of adapter.deliver(session, payload)) events.push(event);
    return events;
  }

  // Requirement: v1 Default omits the variant while fixed and custom values
  // arrive normalized as `--variant`. Non-redundant: the only argv-shape proof for v1.
  it('sends no variant by default and --variant for fixed and custom values on v1', async () => {
    for (const version of ['1.18.30', '0.0.0-dev-202609102034']) {
      const dir = mkdtempSync(join(tmpdir(), 'codor-opencode-runlog-'));
      dirs.push(dir);
      const runLog = join(dir, 'run.json');
      const command = lineFake({ version, runLog });
      const adapter = new OpenCodeAdapter(command);
      const plain = adapter.spawn({ cwd: process.cwd(), model: 'opencode/m' });
      const events: WireEvent[] = [];
      for await (const event of adapter.deliver(plain, 'hi')) events.push(event);
      expect(events.at(-1)).toMatchObject({ type: 'run.completed', status: 'completed' });
      expect(JSON.parse(readFileSync(runLog, 'utf8'))).not.toContain('--variant');

      for (const thinking of ['low', ' HIGH ', 'Minimal'] as const) {
        const session = adapter.spawn({ cwd: process.cwd(), model: 'opencode/m', thinking: thinking as 'low' });
        const runEvents: WireEvent[] = [];
        for await (const event of adapter.deliver(session, 'hi')) runEvents.push(event);
        expect(runEvents.at(-1)).toMatchObject({ type: 'run.completed', status: 'completed' });
        const argv = JSON.parse(readFileSync(runLog, 'utf8')) as string[];
        const expected = thinking.trim().toLowerCase() === 'high' ? 'high' : thinking.trim();
        expect(argv).toContain('--variant');
        expect(argv[argv.indexOf('--variant') + 1]).toBe(expected);
      }
    }
  });

  // Requirement: v2 carries the variant as a `#` suffix and never sends
  // `--variant`, without touching the default-model endpoint when a model is set.
  // Non-redundant: the only `#variant` argv proof.
  it('emits --model with a #variant suffix on v2 and never sends --variant', async () => {
    for (const version of ['opencode v2.0.3', 'opencode2 v0.0.0-dev-19272']) {
      const dir = mkdtempSync(join(tmpdir(), 'codor-opencode-runlog-'));
      dirs.push(dir);
      const runLog = join(dir, 'run.json');
      const apiLog = join(dir, 'api.log');
      const command = lineFake({ version, runLog, apiLog });
      const adapter = new OpenCodeAdapter(command);
      const session = adapter.spawn({ cwd: process.cwd(), model: 'opencode/m', thinking: ' HIGH ' });
      const events: WireEvent[] = [];
      for await (const event of adapter.deliver(session, 'hi')) events.push(event);
      expect(events.at(-1)).toMatchObject({ type: 'run.completed', status: 'completed' });
      const argv = JSON.parse(readFileSync(runLog, 'utf8')) as string[];
      expect(argv).not.toContain('--variant');
      expect(argv).toContain('--model');
      expect(argv[argv.indexOf('--model') + 1]).toBe('opencode/m#high');
      expect(existsSync(apiLog)).toBe(false);
    }
  });

  // Requirement: v2 Default-model resolution uses `data.id` (not `modelID`)
  // and never persists the resolved model. Non-redundant: the only id-selection proof.
  it('resolves the v2 default model by id and preserves the stored session', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'codor-opencode-runlog-'));
    dirs.push(dir);
    const runLog = join(dir, 'run.json');
    const command = lineFake({
      version: 'opencode v2.0.3',
      runLog,
      apiBody: { data: { id: 'deepseek-v4.1-flash', modelID: 'provider-side-name', providerID: 'opencode-go', variants: [{ id: 'high' }] } },
    });
    const adapter = new OpenCodeAdapter(command);
    const session = adapter.spawn({ cwd: process.cwd(), thinking: 'high' });
    const events: WireEvent[] = [];
    for await (const event of adapter.deliver(session, 'hi')) events.push(event);
    expect(events.at(-1)).toMatchObject({ type: 'run.completed', status: 'completed' });
    const argv = JSON.parse(readFileSync(runLog, 'utf8')) as string[];
    expect(argv[argv.indexOf('--model') + 1]).toBe('opencode-go/deepseek-v4.1-flash#high');
    expect(session.model).toBeUndefined();
    expect(session.thinking).toBe('high');
  });

  // Requirement: every unusable-default shape fails with the fixed
  // explicit-model message, builds no argv, and preserves stored thinking.
  // Non-redundant: the only fallback-path coverage.
  it('fails the turn with a fixed message when the v2 default is unusable', async () => {
    const cases: { name: string; apiBody?: unknown; apiExit?: number; apiHang?: boolean }[] = [
      { name: 'null data', apiBody: { data: null } },
      { name: 'non-zero exit', apiExit: 1 },
      { name: 'hang', apiHang: true },
      { name: 'non-json', apiBody: 'not json at all' },
      { name: 'missing id', apiBody: { data: { providerID: 'p' } } },
      { name: 'missing provider', apiBody: { data: { id: 'm' } } },
      { name: 'numeric id', apiBody: { data: { id: 42, providerID: 'p' } } },
      { name: 'bad id shape', apiBody: { data: { id: 'has space', providerID: 'p' } } },
      { name: 'hash id', apiBody: { data: { id: 'a#b', providerID: 'p' } } },
      { name: 'over length', apiBody: { data: { id: 'x'.repeat(300), providerID: 'p' } } },
    ];
    for (const failure of cases) {
      const dir = mkdtempSync(join(tmpdir(), 'codor-opencode-runlog-'));
      dirs.push(dir);
      const runLog = join(dir, 'run.json');
      const command = lineFake({ version: 'opencode v2.0.3', runLog, apiBody: failure.apiBody, apiExit: failure.apiExit, apiHang: failure.apiHang });
      const adapter = new OpenCodeAdapter(command);
      const session = adapter.spawn({ cwd: process.cwd(), thinking: 'high' });
      const events: WireEvent[] = [];
      for await (const event of adapter.deliver(session, 'hi')) events.push(event);
      const done = events.at(-1) as Extract<WireEvent, { type: 'run.completed' }>;
      expect(done.status, failure.name).toBe('failed');
      expect(done.final_text, failure.name).toBe(OPENCODE_V2_EXPLICIT_MODEL_MESSAGE);
      expect(existsSync(runLog), failure.name).toBe(false);
      expect(session.thinking, failure.name).toBe('high');
      expect(session.model, failure.name).toBeUndefined();
    }
  }, 30_000);

  // Requirement: the default resolves per turn (never cached, never stored)
  // and the endpoint is skipped unless v2 needs it. Non-redundant: the only
  // freshness and call-skipping proof.
  it('resolves a fresh default per turn and never calls the endpoint without a v2 thinking need', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'codor-opencode-count-'));
    dirs.push(dir);
    const apiCount = join(dir, 'api.count');
    const runLog = join(dir, 'run.json');
    const path = join(dir, 'fake-opencode');
    writeFileSync(path, `#!/usr/bin/env node
const fs = require('node:fs');
const argv = process.argv.slice(2);
if (argv[0] === '--version') { console.log('opencode v2.0.3'); process.exit(0); }
if (argv[0] === 'api') {
  const n = fs.existsSync(${JSON.stringify(apiCount)}) ? Number(fs.readFileSync(${JSON.stringify(apiCount)}, 'utf8')) : 0;
  fs.writeFileSync(${JSON.stringify(apiCount)}, String(n + 1));
  const id = n === 0 ? 'first-model' : 'second-model';
  console.log(JSON.stringify({data:{id, providerID:'opencode-go'}}));
  process.exit(0);
}
if (argv[0] === 'run') {
  const fs2 = require('node:fs');
  fs2.writeFileSync(${JSON.stringify(runLog)}, JSON.stringify(argv));
  console.log(JSON.stringify({type:'step_start',sessionID:'ses_multi',part:{type:'step-start'}}));
  console.log(JSON.stringify({type:'text',sessionID:'ses_multi',part:{type:'text',text:'ok',time:{start:1,end:2}}}));
  console.log(JSON.stringify({type:'step_finish',sessionID:'ses_multi',part:{type:'step-finish',tokens:{input:1,output:1},cost:0}}));
  process.exit(0);
}
process.exit(7);
`);
    chmodSync(path, 0o755);
    const adapter = new OpenCodeAdapter(path);
    const session = adapter.spawn({ cwd: process.cwd(), thinking: 'high' });
    for await (const event of adapter.deliver(session, 'one')) {
      if (event.type === 'run.completed') {
        expect(event.status).toBe('completed');
      }
    }
    expect(JSON.parse(readFileSync(runLog, 'utf8'))).toContain('opencode-go/first-model#high');
    for await (const event of adapter.deliver(session, 'two')) {
      if (event.type === 'run.completed') {
        expect(event.status).toBe('completed');
      }
    }
    expect(JSON.parse(readFileSync(runLog, 'utf8'))).toContain('opencode-go/second-model#high');
    expect(session.model).toBeUndefined();

    const plainDir = mkdtempSync(join(tmpdir(), 'codor-opencode-plain-'));
    dirs.push(plainDir);
    const plainApiLog = join(plainDir, 'api.log');
    const plain = lineFake({ version: 'opencode v2.0.3', runLog: join(plainDir, 'run.json'), apiLog: plainApiLog });
    const noThinking = await deliverOnce(plain, new OpenCodeAdapter(plain).spawn({ cwd: process.cwd() }));
    expect(noThinking.at(-1)).toMatchObject({ status: 'completed' });
    expect(existsSync(plainApiLog)).toBe(false);
    const withModel = await deliverOnce(
      plain,
      new OpenCodeAdapter(plain).spawn({ cwd: process.cwd(), model: 'opencode/m', thinking: 'high' }),
    );
    expect(withModel.at(-1)).toMatchObject({ status: 'completed' });

    const v1Dir = mkdtempSync(join(tmpdir(), 'codor-opencode-v1-'));
    dirs.push(v1Dir);
    const v1ApiLog = join(v1Dir, 'api.log');
    const v1 = lineFake({ version: '1.18.30', runLog: join(v1Dir, 'run.json'), apiLog: v1ApiLog });
    const v1Events = await deliverOnce(
      v1,
      new OpenCodeAdapter(v1).spawn({ cwd: process.cwd(), thinking: 'high' }),
    );
    expect(v1Events.at(-1)).toMatchObject({ status: 'completed' });
    expect(existsSync(v1ApiLog)).toBe(false);
  });

  // Requirement: unforeseen banners resolve via `run --help`, and unknown
  // failures carry a token or category but never raw probe output.
  // Non-redundant: the only fallback and redaction proof.
  it('detects the line from run --help fallback and fails unknown lines without probe output', async () => {
    const helpV2 = 'Usage: opencode run [options]\n  --model provider/model#variant\n  --session ID\n';
    const dir = mkdtempSync(join(tmpdir(), 'codor-opencode-runlog-'));
    dirs.push(dir);
    const runLog = join(dir, 'run.json');
    const fallback = lineFake({ version: 'opencode v3.0.0', help: helpV2, runLog, apiBody: { data: { id: 'm', providerID: 'p' } } });
    const fallbackEvents = await deliverOnce(
      fallback,
      new OpenCodeAdapter(fallback).spawn({ cwd: process.cwd(), model: 'p/m', thinking: 'high' }),
    );
    expect(fallbackEvents.at(-1)).toMatchObject({ status: 'completed' });
    expect(JSON.parse(readFileSync(runLog, 'utf8'))).toContain('p/m#high');

    const bothHelp = 'flags: --variant and #variant both present';
    const both = lineFake({ version: 'opencode v3.0.0', help: bothHelp, runLog: join(dir, 'both.json') });
    const bothEvents = await deliverOnce(
      both,
      new OpenCodeAdapter(both).spawn({ cwd: process.cwd(), thinking: 'high' }),
    );
    const bothDone = bothEvents.at(-1) as Extract<WireEvent, { type: 'run.completed' }>;
    expect(bothDone.status).toBe('failed');
    expect(bothDone.final_text).toBe(unknownOpenCodeLineMessage('v3.0.0'));

    const garbage = lineFake({ version: 'garbage-marker-xyz\nsecond line secret', runLog: join(dir, 'garbage.json') });
    const garbageEvents = await deliverOnce(
      garbage,
      new OpenCodeAdapter(garbage).spawn({ cwd: process.cwd() }),
    );
    const garbageDone = garbageEvents.at(-1) as Extract<WireEvent, { type: 'run.completed' }>;
    expect(garbageDone.status).toBe('failed');
    expect(garbageDone.final_text).toBe(unknownOpenCodeLineMessage());
    expect(garbageDone.final_text).not.toContain('garbage-marker-xyz');

    const versionFail = lineFake({ version: 'x', versionExit: 3, runLog: join(dir, 'fail.json') });
    const failEvents = await deliverOnce(
      versionFail,
      new OpenCodeAdapter(versionFail).spawn({ cwd: process.cwd() }),
    );
    expect(failEvents.at(-1)).toMatchObject({ status: 'failed', final_text: unknownOpenCodeLineMessage() });
  });

  // Requirement: detection runs once per instance and covers the attach path
  // through deliver. Non-redundant: the only probe-caching and attach proof.
  it('probes once per instance and detects before argv on attach', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'codor-opencode-probe-'));
    dirs.push(dir);
    const versionLog = join(dir, 'version.log');
    const runLog = join(dir, 'run.json');
    const command = lineFake({ version: '1.18.30', versionLog, runLog });
    const adapter = new OpenCodeAdapter(command);
    const first = adapter.spawn({ cwd: process.cwd(), thinking: 'high' });
    for await (const event of adapter.deliver(first, 'one')) {
      expect(event).toBeDefined();
    }
    const second = adapter.spawn({ cwd: process.cwd(), thinking: 'low' });
    for await (const event of adapter.deliver(second, 'two')) {
      expect(event).toBeDefined();
    }
    expect(readFileSync(versionLog, 'utf8').trim().split('\n')).toHaveLength(1);

    const fresh = new OpenCodeAdapter(command);
    const attached = fresh.attach('ses_attach');
    attached.cwd = process.cwd();
    attached.model = 'opencode/m';
    attached.thinking = 'high';
    const events: WireEvent[] = [];
    for await (const event of fresh.deliver(attached, 'hi')) events.push(event);
    expect(events.at(-1)).toMatchObject({ status: 'completed' });
    expect(JSON.parse(readFileSync(runLog, 'utf8'))).toContain('--variant');
  });
  // Requirement: a delayed probe never freezes the shared event loop.
  // Non-redundant: the only event-loop progress proof for detection.
  it('keeps the event loop responsive while a probe is pending', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'codor-opencode-slowprobe-'));
    dirs.push(dir);
    const path = join(dir, 'fake-opencode');
    writeFileSync(path, `#!/usr/bin/env node
const argv = process.argv.slice(2);
if (argv[0] === '--version') {
  setTimeout(() => { console.log('1.18.30'); process.exit(0); }, 1000);
  return;
}
if (argv[0] === 'run') {
  console.log(JSON.stringify({type:'step_start',sessionID:'ses_slow',part:{type:'step-start'}}));
  console.log(JSON.stringify({type:'text',sessionID:'ses_slow',part:{type:'text',text:'ok',time:{start:1,end:2}}}));
  console.log(JSON.stringify({type:'step_finish',sessionID:'ses_slow',part:{type:'step-finish',tokens:{input:1,output:1},cost:0}}));
  process.exit(0);
}
process.exit(7);
`);
    chmodSync(path, 0o755);
    const adapter = new OpenCodeAdapter(path);
    const started = Date.now();
    let tickAt = 0;
    setTimeout(() => { tickAt = Date.now(); }, 100);
    const events: WireEvent[] = [];
    for await (const event of adapter.deliver(adapter.spawn({ cwd: process.cwd() }), 'hi')) {
      events.push(event);
    }
    expect(events.at(-1)).toMatchObject({ type: 'run.completed', status: 'completed' });
    expect(tickAt).toBeGreaterThan(0);
    expect(tickAt - started).toBeLessThan(900);
  });

  // Requirement: a transient probe failure retries on the next turn instead of
  // bricking the instance. Non-redundant: the only detection-retry proof.
  it('retries detection after an unknown result instead of caching it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'codor-opencode-retry-'));
    dirs.push(dir);
    const countPath = join(dir, 'count');
    const path = join(dir, 'fake-opencode');
    writeFileSync(path, `#!/usr/bin/env node
const fs = require('node:fs');
const argv = process.argv.slice(2);
if (argv[0] === '--version') {
  const n = fs.existsSync(${JSON.stringify(countPath)})
    ? Number(fs.readFileSync(${JSON.stringify(countPath)}, 'utf8')) : 0;
  fs.writeFileSync(${JSON.stringify(countPath)}, String(n + 1));
  if (n === 0) process.exit(3);
  console.log('1.18.30');
  process.exit(0);
}
if (argv[0] === 'run') {
  console.log(JSON.stringify({type:'step_start',sessionID:'ses_retry',part:{type:'step-start'}}));
  console.log(JSON.stringify({type:'text',sessionID:'ses_retry',part:{type:'text',text:'ok',time:{start:1,end:2}}}));
  console.log(JSON.stringify({type:'step_finish',sessionID:'ses_retry',part:{type:'step-finish',tokens:{input:1,output:1},cost:0}}));
  process.exit(0);
}
process.exit(7);
`);
    chmodSync(path, 0o755);
    const adapter = new OpenCodeAdapter(path);
    const first: WireEvent[] = [];
    for await (const event of adapter.deliver(adapter.spawn({ cwd: process.cwd() }), 'one')) {
      first.push(event);
    }
    expect(first.at(-1)).toMatchObject({ status: 'failed' });
    const second: WireEvent[] = [];
    for await (const event of adapter.deliver(adapter.spawn({ cwd: process.cwd() }), 'two')) {
      second.push(event);
    }
    expect(second.at(-1)).toMatchObject({ status: 'completed' });
    expect(Number(readFileSync(countPath, 'utf8'))).toBe(2);
  });

  // Requirement: the default-model probe runs with the session environment so
  // it resolves the same default the turn runs under. Non-redundant: the only
  // probe-environment proof.
  it('carries the session environment into the v2 default-model probe', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'codor-opencode-probeenv-'));
    dirs.push(dir);
    const marker = join(dir, 'env-marker');
    const path = join(dir, 'fake-opencode');
    writeFileSync(path, `#!/usr/bin/env node
const fs = require('node:fs');
const argv = process.argv.slice(2);
if (argv[0] === '--version') { console.log('opencode v2.0.3'); process.exit(0); }
if (argv[0] === 'api') {
  fs.writeFileSync(${JSON.stringify(marker)}, process.env.CODOR_TEST_DEFAULT_ENV ?? '');
  console.log(JSON.stringify({data:{id:'m',providerID:'p'}}));
  process.exit(0);
}
if (argv[0] === 'run') {
  console.log(JSON.stringify({type:'step_start',sessionID:'ses_env',part:{type:'step-start'}}));
  console.log(JSON.stringify({type:'text',sessionID:'ses_env',part:{type:'text',text:'ok',time:{start:1,end:2}}}));
  console.log(JSON.stringify({type:'step_finish',sessionID:'ses_env',part:{type:'step-finish',tokens:{input:1,output:1},cost:0}}));
  process.exit(0);
}
process.exit(7);
`);
    chmodSync(path, 0o755);
    const adapter = new OpenCodeAdapter(path);
    const session = adapter.spawn({ cwd: process.cwd(), thinking: 'high' });
    session.env = { CODOR_TEST_DEFAULT_ENV: 'sentinel' };
    const events: WireEvent[] = [];
    for await (const event of adapter.deliver(session, 'hi')) events.push(event);
    expect(events.at(-1)).toMatchObject({ status: 'completed' });
    expect(readFileSync(marker, 'utf8')).toBe('sentinel');
  });
  // Requirement: detection keys on the PATH that resolves the command, so a
  // session overriding PATH re-probes instead of reusing another line.
  // Non-redundant: the only per-environment cache proof.
  it('re-probes when a session PATH differs instead of reusing another line', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'codor-opencode-pathkey-'));
    dirs.push(dir);
    const countPath = join(dir, 'count');
    const path = join(dir, 'fake-opencode');
    writeFileSync(path, `#!/usr/bin/env node
const fs = require('node:fs');
const argv = process.argv.slice(2);
if (argv[0] === '--version') {
  const n = fs.existsSync(${JSON.stringify(countPath)})
    ? Number(fs.readFileSync(${JSON.stringify(countPath)}, 'utf8')) : 0;
  fs.writeFileSync(${JSON.stringify(countPath)}, String(n + 1));
  console.log('1.18.30');
  process.exit(0);
}
if (argv[0] === 'run') {
  console.log(JSON.stringify({type:'step_start',sessionID:'ses_path',part:{type:'step-start'}}));
  console.log(JSON.stringify({type:'text',sessionID:'ses_path',part:{type:'text',text:'ok',time:{start:1,end:2}}}));
  console.log(JSON.stringify({type:'step_finish',sessionID:'ses_path',part:{type:'step-finish',tokens:{input:1,output:1},cost:0}}));
  process.exit(0);
}
process.exit(7);
`);
    chmodSync(path, 0o755);
    const adapter = new OpenCodeAdapter(path);
    const first: WireEvent[] = [];
    for await (const event of adapter.deliver(adapter.spawn({ cwd: process.cwd() }), 'one')) {
      first.push(event);
    }
    expect(first.at(-1)).toMatchObject({ status: 'completed' });
    const other = adapter.spawn({ cwd: process.cwd() });
    other.env = { PATH: `/custom/bin${process.env.PATH === undefined ? '' : `:${process.env.PATH}`}` };
    const second: WireEvent[] = [];
    for await (const event of adapter.deliver(other, 'two')) second.push(event);
    expect(second.at(-1)).toMatchObject({ status: 'completed' });
    const third: WireEvent[] = [];
    for await (const event of adapter.deliver(adapter.spawn({ cwd: process.cwd() }), 'three')) {
      third.push(event);
    }
    expect(third.at(-1)).toMatchObject({ status: 'completed' });
    expect(Number(readFileSync(countPath, 'utf8'))).toBe(2);
  });

  // Requirement: the version probe runs with the session cwd and environment
  // so it resolves the same command the turn runs. Non-redundant: the only
  // probe-context proof.
  it('carries the session cwd and environment into the version probe', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'codor-opencode-probectx-'));
    dirs.push(dir);
    const marker = join(dir, 'probe-ctx.json');
    const path = join(dir, 'fake-opencode');
    writeFileSync(path, `#!/usr/bin/env node
const fs = require('node:fs');
const argv = process.argv.slice(2);
if (argv[0] === '--version') {
  fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify({
    cwd: process.cwd(), marker: process.env.CODOR_TEST_PROBE_ENV ?? '',
  }));
  console.log('1.18.30');
  process.exit(0);
}
if (argv[0] === 'run') {
  console.log(JSON.stringify({type:'step_start',sessionID:'ses_ctx',part:{type:'step-start'}}));
  console.log(JSON.stringify({type:'text',sessionID:'ses_ctx',part:{type:'text',text:'ok',time:{start:1,end:2}}}));
  console.log(JSON.stringify({type:'step_finish',sessionID:'ses_ctx',part:{type:'step-finish',tokens:{input:1,output:1},cost:0}}));
  process.exit(0);
}
process.exit(7);
`);
    chmodSync(path, 0o755);
    const cwd = mkdtempSync(join(tmpdir(), 'codor-opencode-probecwd-'));
    dirs.push(cwd);
    const adapter = new OpenCodeAdapter(path);
    const session = adapter.spawn({ cwd });
    session.env = { CODOR_TEST_PROBE_ENV: 'probe-sentinel' };
    const events: WireEvent[] = [];
    for await (const event of adapter.deliver(session, 'hi')) events.push(event);
    expect(events.at(-1)).toMatchObject({ status: 'completed' });
    expect(JSON.parse(readFileSync(marker, 'utf8'))).toEqual({
      cwd: realpathSync(cwd),
      marker: 'probe-sentinel',
    });
  });
  // Requirement: the cache keys on executable identity, so the same PATH in a
  // different cwd re-probes instead of sending one line's argv to the other.
  // Non-redundant: the only cross-cwd identity proof (absolute fakes cannot
  // exercise PATH resolution at all).
  it('resolves each cwd to its own line when PATH selects different binaries', async () => {
    const root = mkdtempSync(join(tmpdir(), 'codor-opencode-identity-'));
    dirs.push(root);
    const v1Dir = join(root, 'v1');
    const v2Dir = join(root, 'v2');
    mkdirSync(v1Dir, { recursive: true });
    mkdirSync(v2Dir, { recursive: true });
    const v1Log = join(root, 'v1-argv.json');
    const v2Log = join(root, 'v2-argv.json');
    const runHandler = (log: string) => `
if (argv[0] === 'run') {
  fs.writeFileSync(${JSON.stringify(log)}, JSON.stringify(argv));
  console.log(JSON.stringify({type:'step_start',sessionID:'ses_id',part:{type:'step-start'}}));
  console.log(JSON.stringify({type:'text',sessionID:'ses_id',part:{type:'text',text:'ok',time:{start:1,end:2}}}));
  console.log(JSON.stringify({type:'step_finish',sessionID:'ses_id',part:{type:'step-finish',tokens:{input:1,output:1},cost:0}}));
  process.exit(0);
}
process.exit(7);
`;
    writeFileSync(join(v1Dir, 'fake-id'), `#!/usr/bin/env node
const fs = require('node:fs');
const argv = process.argv.slice(2);
if (argv[0] === '--version') { console.log('1.18.30'); process.exit(0); }
${runHandler(v1Log)}
`);
    writeFileSync(join(v2Dir, 'fake-id'), `#!/usr/bin/env node
const fs = require('node:fs');
const argv = process.argv.slice(2);
if (argv[0] === '--version') { console.log('opencode v2.0.3'); process.exit(0); }
${runHandler(v2Log)}
`);
    chmodSync(join(v1Dir, 'fake-id'), 0o755);
    chmodSync(join(v2Dir, 'fake-id'), 0o755);
    const adapter = new OpenCodeAdapter('fake-id');
    const pathWithDot = `.${delimiter}${process.env.PATH ?? ''}`;
    const first = adapter.spawn({ cwd: v1Dir, model: 'p/m', thinking: 'high' });
    first.env = { PATH: pathWithDot };
    const firstEvents: WireEvent[] = [];
    for await (const event of adapter.deliver(first, 'one')) firstEvents.push(event);
    expect(firstEvents.at(-1)).toMatchObject({ status: 'completed' });
    expect(JSON.parse(readFileSync(v1Log, 'utf8'))).toContain('--variant');

    const second = adapter.spawn({ cwd: v2Dir, model: 'p/m', thinking: 'high' });
    second.env = { PATH: pathWithDot };
    const secondEvents: WireEvent[] = [];
    for await (const event of adapter.deliver(second, 'two')) secondEvents.push(event);
    expect(secondEvents.at(-1)).toMatchObject({ status: 'completed' });
    expect(JSON.parse(readFileSync(v2Log, 'utf8'))).toContain('p/m#high');
  });
  // Requirement: a blank version banner still takes the capability fallback
  // instead of failing outright. Non-redundant: the only empty-output proof.
  it('falls back to run --help when version output is blank', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'codor-opencode-blank-'));
    dirs.push(dir);
    const runLog = join(dir, 'run.json');
    const helpLog = join(dir, 'help.log');
    const path = join(dir, 'fake-opencode');
    writeFileSync(path, `#!/usr/bin/env node
const fs = require('node:fs');
const argv = process.argv.slice(2);
if (argv[0] === '--version') { process.exit(0); }
if (argv[0] === 'run' && argv[1] === '--help') {
  fs.writeFileSync(${JSON.stringify(helpLog)}, 'help');
  console.log('Usage: opencode run [options]\\n  --variant VALUE\\n  --session ID\\n');
  process.exit(0);
}
if (argv[0] === 'run') {
  fs.writeFileSync(${JSON.stringify(runLog)}, JSON.stringify(argv));
  console.log(JSON.stringify({type:'step_start',sessionID:'ses_blank',part:{type:'step-start'}}));
  console.log(JSON.stringify({type:'text',sessionID:'ses_blank',part:{type:'text',text:'ok',time:{start:1,end:2}}}));
  console.log(JSON.stringify({type:'step_finish',sessionID:'ses_blank',part:{type:'step-finish',tokens:{input:1,output:1},cost:0}}));
  process.exit(0);
}
process.exit(7);
`);
    chmodSync(path, 0o755);
    const adapter = new OpenCodeAdapter(path);
    const session = adapter.spawn({ cwd: process.cwd(), model: 'p/m', thinking: 'high' });
    const events: WireEvent[] = [];
    for await (const event of adapter.deliver(session, 'hi')) events.push(event);
    expect(events.at(-1)).toMatchObject({ status: 'completed' });
    expect(existsSync(helpLog)).toBe(true);
    expect(JSON.parse(readFileSync(runLog, 'utf8'))).toContain('--variant');
  });
  // Requirement: the cache key tracks every input that resolves the command,
  // mirroring cross-spawn (last case-insensitive PATH match and process
  // PATHEXT on win32), with cwd only when it can change resolution.
  // Non-redundant: the only key-semantics proof.
  it('keys detection on the inputs that resolve the command', () => {
    const absolute = '/opt/bin/opencode';
    expect(openCodeDetectionKey(absolute, '/a', { PATH: '/bin' }))
      .toBe(openCodeDetectionKey(absolute, '/b', { PATH: '/bin' }));
    expect(openCodeDetectionKey(absolute, '/a', { PATH: '/bin' }))
      .not.toBe(openCodeDetectionKey(absolute, '/a', { PATH: '/other' }));
    expect(openCodeDetectionKey(absolute, '/a', { pAtH: '/bin' }))
      .not.toBe(openCodeDetectionKey(absolute, '/a', { PATH: '/bin' }));
    expect(openCodeDetectionKey(absolute, '/a', { pAtH: '/bin' }, 'win32'))
      .toBe(openCodeDetectionKey(absolute, '/a', { PATH: '/bin' }, 'win32'));
    // Last case-insensitive match wins on win32, mirroring path-key.
    expect(openCodeDetectionKey(absolute, '/a', { PATH: '/a', pAtH: '/b' }, 'win32'))
      .toBe(openCodeDetectionKey(absolute, '/a', { PATH: '/b' }, 'win32'));
    // PATHEXT is resolved from process.env by the launcher, so session values
    // do not enter the key on any platform.
    expect(openCodeDetectionKey(absolute, '/a', {}, 'win32'))
      .toBe(openCodeDetectionKey(absolute, '/a', { PATHEXT: '.EXE' }, 'win32'));
    // A relative PATH entry makes cwd resolution-relevant.
    expect(openCodeDetectionKey('opencode', '/a', { PATH: '/bin' }))
      .toBe(openCodeDetectionKey('opencode', '/b', { PATH: '/bin' }));
    expect(openCodeDetectionKey('opencode', '/a', { PATH: `tools/bin${delimiter}/bin` }))
      .not.toBe(openCodeDetectionKey('opencode', '/b', { PATH: `tools/bin${delimiter}/bin` }));
    // A relative command always depends on cwd.
    expect(openCodeDetectionKey('./opencode', '/a', { PATH: '/bin' }))
      .not.toBe(openCodeDetectionKey('./opencode', '/b', { PATH: '/bin' }));
    // An absolute command never reads PATH, so not even a trailing colon
    // (an empty entry) can make cwd matter for it.
    expect(openCodeDetectionKey(absolute, '/a', { PATH: '/bin:' }))
      .toBe(openCodeDetectionKey(absolute, '/b', { PATH: '/bin:' }));
    // which searches the session cwd before PATH on Windows, so bare commands
    // always carry cwd there; on POSIX `\` is an ordinary filename character.
    expect(openCodeDetectionKey('opencode', '/a', { PATH: '/bin' }, 'win32'))
      .not.toBe(openCodeDetectionKey('opencode', '/b', { PATH: '/bin' }, 'win32'));
    expect(openCodeDetectionKey('C:\\Tools\\opencode', '/a', { PATH: 'C:\\bin' }, 'win32'))
      .toBe(openCodeDetectionKey('C:\\Tools\\opencode', '/b', { PATH: 'C:\\bin' }, 'win32'));
    expect(openCodeDetectionKey('//server/share/opencode.exe', '/a', { PATH: 'C:\\bin' }, 'win32'))
      .toBe(openCodeDetectionKey('//server/share/opencode.exe', '/b', { PATH: 'C:\\bin' }, 'win32'));
    expect(openCodeDetectionKey('\\\\server\\share\\opencode.exe', '/a', { PATH: 'C:\\bin' }, 'win32'))
      .toBe(openCodeDetectionKey('\\\\server\\share\\opencode.exe', '/b', { PATH: 'C:\\bin' }, 'win32'));
    // Incomplete UNC prefixes normalize to the current drive, so cwd stays in
    // the key for them.
    expect(openCodeDetectionKey('//server', '/a', { PATH: 'C:\\bin' }, 'win32'))
      .not.toBe(openCodeDetectionKey('//server', '/b', { PATH: 'C:\\bin' }, 'win32'));
    expect(openCodeDetectionKey('///opencode.exe', '/a', { PATH: 'C:\\bin' }, 'win32'))
      .not.toBe(openCodeDetectionKey('///opencode.exe', '/b', { PATH: 'C:\\bin' }, 'win32'));
    expect(openCodeDetectionKey('\\\\server', '/a', { PATH: 'C:\\bin' }, 'win32'))
      .not.toBe(openCodeDetectionKey('\\\\server', '/b', { PATH: 'C:\\bin' }, 'win32'));
    expect(openCodeDetectionKey('foo\\bar', '/a', { PATH: '/bin' }))
      .toBe(openCodeDetectionKey('foo\\bar', '/b', { PATH: '/bin' }));
  });

  // Requirement: the bounded cache evicts least-recently-used entries, and a
  // hit refreshes recency. Without eviction, 17 keys cost 17 probes but the
  // 17th is never cached; without refresh, repeating the oldest evicts it.
  // Here the repeat of K1 must stay a hit while K2 (evicted by K17) re-probes:
  // 18 probes ending with K2. Non-redundant: the only eviction-order proof.
  it('evicts least-recently-used entries and refreshes on hits', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'codor-opencode-evict-'));
    dirs.push(dir);
    const countPath = join(dir, 'count');
    const tagPath = join(dir, 'tags');
    const path = join(dir, 'fake-opencode');
    writeFileSync(path, `#!/usr/bin/env node
const fs = require('node:fs');
const argv = process.argv.slice(2);
if (argv[0] === '--version') {
  const tag = String(process.env.CODOR_TEST_EVICT_TAG ?? '?');
  fs.appendFileSync(${JSON.stringify(tagPath)}, tag + '\\n');
  const n = fs.existsSync(${JSON.stringify(countPath)})
    ? Number(fs.readFileSync(${JSON.stringify(countPath)}, 'utf8')) : 0;
  fs.writeFileSync(${JSON.stringify(countPath)}, String(n + 1));
  console.log('1.18.30');
  process.exit(0);
}
if (argv[0] === 'run') {
  console.log(JSON.stringify({type:'step_start',sessionID:'ses_evict',part:{type:'step-start'}}));
  console.log(JSON.stringify({type:'text',sessionID:'ses_evict',part:{type:'text',text:'ok',time:{start:1,end:2}}}));
  console.log(JSON.stringify({type:'step_finish',sessionID:'ses_evict',part:{type:'step-finish',tokens:{input:1,output:1},cost:0}}));
  process.exit(0);
}
process.exit(7);
`);
    chmodSync(path, 0o755);
    const adapter = new OpenCodeAdapter(path);
    const systemPath = process.env.PATH ?? '';
    const deliverKey = async (tag: string): Promise<void> => {
      const session = adapter.spawn({ cwd: process.cwd() });
      session.env = { PATH: `/${tag}${delimiter}${systemPath}`, CODOR_TEST_EVICT_TAG: tag };
      const events: WireEvent[] = [];
      for await (const event of adapter.deliver(session, `turn-${tag}`)) events.push(event);
      expect(events.at(-1)).toMatchObject({ status: 'completed' });
    };
    for (let index = 0; index < 16; index += 1) {
      await deliverKey(`evict-${String(index)}`);
    }
    await deliverKey('evict-0');
    await deliverKey('evict-16');
    await deliverKey('evict-0');
    await deliverKey('evict-1');
    const tags = readFileSync(tagPath, 'utf8').trim().split('\n');
    expect(tags).toHaveLength(18);
    expect(tags.at(-1)).toBe('evict-1');
    expect(Number(readFileSync(countPath, 'utf8'))).toBe(18);
  });

  // Requirement: a stale failed probe never deletes a newer cached entry for
  // the same key. The predecessor waits on a signal file with a probe timeout
  // far beyond the scenario, so the eviction and replacement strictly precede
  // its failure: no timing window, no vacuous pass. Non-redundant: the only
  // concurrent-settlement proof.
  it('keeps a replaced entry when its evicted predecessor fails late', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'codor-opencode-stale-'));
    dirs.push(dir);
    const countPath = join(dir, 'count');
    const signalPath = join(dir, 'release');
    const path = join(dir, 'fake-opencode');
    writeFileSync(path, `#!/usr/bin/env node
const fs = require('node:fs');
const argv = process.argv.slice(2);
if (argv[0] === '--version') {
  const n = fs.existsSync(${JSON.stringify(countPath)})
    ? Number(fs.readFileSync(${JSON.stringify(countPath)}, 'utf8')) : 0;
  fs.writeFileSync(${JSON.stringify(countPath)}, String(n + 1));
  if (process.env.CODOR_TEST_STALL === '1') {
    const started = Date.now();
    while (!fs.existsSync(${JSON.stringify(signalPath)}) && Date.now() - started < 55000) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
    process.exit(3);
  }
  console.log('1.18.30');
  process.exit(0);
}
if (argv[0] === 'run') {
  console.log(JSON.stringify({type:'step_start',sessionID:'ses_stale',part:{type:'step-start'}}));
  console.log(JSON.stringify({type:'text',sessionID:'ses_stale',part:{type:'text',text:'ok',time:{start:1,end:2}}}));
  console.log(JSON.stringify({type:'step_finish',sessionID:'ses_stale',part:{type:'step-finish',tokens:{input:1,output:1},cost:0}}));
  process.exit(0);
}
process.exit(7);
`);
    chmodSync(path, 0o755);
    const adapter = new OpenCodeAdapter(path, 60_000);
    const systemPath = process.env.PATH ?? '';
    const pathFor = (tag: string): string => `/${tag}${delimiter}${systemPath}`;
    // The first probe waits on the signal file, then fails; 16 other keys
    // evict its pending entry while it hangs.
    const stalled = adapter.spawn({ cwd: process.cwd() });
    stalled.env = { PATH: pathFor('stale'), CODOR_TEST_STALL: '1' };
    const stalledEvents: WireEvent[] = [];
    const stalledDone = (async () => {
      for await (const event of adapter.deliver(stalled, 'stalled')) stalledEvents.push(event);
    })();
    // Barrier: the stalled probe must be the first version call, so poll the
    // count file before inserting anything. Otherwise LRU order — and the
    // final count — depends on spawn scheduling.
    for (let waits = 0; waits < 200; waits += 1) {
      if (existsSync(countPath) && readFileSync(countPath, 'utf8') === '1') break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(readFileSync(countPath, 'utf8')).toBe('1');
    for (let index = 0; index < 16; index += 1) {
      const session = adapter.spawn({ cwd: process.cwd() });
      session.env = { PATH: pathFor(`other-${String(index)}`) };
      const events: WireEvent[] = [];
      for await (const event of adapter.deliver(session, `other-${String(index)}`)) {
        events.push(event);
      }
      expect(events.at(-1)).toMatchObject({ status: 'completed' });
    }
    // Re-probe the first key while its predecessor still hangs: a replacement.
    const replacement = adapter.spawn({ cwd: process.cwd() });
    replacement.env = { PATH: pathFor('stale') };
    const replacementEvents: WireEvent[] = [];
    for await (const event of adapter.deliver(replacement, 'replacement')) {
      replacementEvents.push(event);
    }
    expect(replacementEvents.at(-1)).toMatchObject({ status: 'completed' });
    // Release the predecessor only after the replacement is cached, and prove
    // it was still pending: the stale failure must not delete the replacement,
    // so one more turn on the key is a cache hit.
    expect(stalledEvents).toHaveLength(0);
    writeFileSync(signalPath, 'go');
    await stalledDone;
    expect(stalledEvents.at(-1)).toMatchObject({ status: 'failed' });
    const repeat = adapter.spawn({ cwd: process.cwd() });
    repeat.env = { PATH: pathFor('stale') };
    const repeatEvents: WireEvent[] = [];
    for await (const event of adapter.deliver(repeat, 'repeat')) repeatEvents.push(event);
    expect(repeatEvents.at(-1)).toMatchObject({ status: 'completed' });
    expect(Number(readFileSync(countPath, 'utf8'))).toBe(18);
  }, 30_000);
});
// harn:end harness-declares-supported-thinking-levels
