import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';

const read = (file: string) => readFileSync(file, 'utf8').replaceAll('\r\n', '\n');
const workflow = read('.github/workflows/quality-check.yml');
const basic = workflow.split('  basic:\n')[1]!.split('  ra2:\n')[0]!;
const ra2 = workflow.split('  ra2:\n')[1]!.split('  yr:\n')[0]!;
const yr = workflow.split('  yr:\n')[1]!;

it('同步流水线兼容事件输入，强推参数缺失时不静默降级', () => {
  const sync = read('.github/workflows/sync-github.yml');
  expect(sync).toContain('FORCE_PUSH: ${{ github.event.inputs.force || inputs.force }}');
  const selection = sync.match(/          case "\$FORCE_PUSH" in[\s\S]*?          esac/)![0];
  for (const [input, status, output] of [
    ['true', 0, '--force\n'],
    ['false', 0, '\n'],
    ['', 1, ''],
    ['invalid', 1, ''],
  ] as const) {
    const result = spawnSync('bash', ['-c', `${selection}\nprintf '%s\\n' "\u0024{push_options[@]}"`], {
      env: { ...process.env, FORCE_PUSH: input },
      encoding: 'utf8',
    });
    expect(result.status).toBe(status);
    expect(result.stdout).toBe(output);
  }
});

it('统一 CI 入口使用固定 action 与 pnpm，格式和无素材验收归 Basic', () => {
  const pkg = JSON.parse(read('package.json'));
  expect(pkg.packageManager).toBe('pnpm@11.24.0');
  expect(pkg.scripts['format:check']).toBe('biome format .');
  expect(existsSync('pnpm-lock.yaml')).toBe(true);
  expect(existsSync('package-lock.json')).toBe(false);
  expect(existsSync('.gitea')).toBe(false);
  expect(readdirSync('.github/workflows').sort()).toEqual(['quality-check.yml', 'sync-github.yml']);
  expect(basic).toContain('name: Basic test');
  expect(basic).toContain('pnpm run format:check');
  expect(basic).toContain('pnpm run ci:basic');
  expect(workflow).toContain('branches: [dev, main]');
  expect(workflow).toContain('contents: read');
  expect(workflow).not.toMatch(/\b(?:npm ci|npm run|npx)\b|GITHUB_ENV|setsid|trap /);
  for (const job of [basic, ra2, yr]) {
    expect(job).toContain('runs-on: ubuntu-latest');
    expect(job).toContain('pnpm install --frozen-lockfile');
    expect(job).toContain('persist-credentials: false');
    expect(job).toContain('dtolnay/rust-toolchain@');
    expect(job).toContain('targets: wasm32-unknown-unknown');
    expect(job).not.toContain('rustup target add');
    expect(job.indexOf('actions/setup-node@')).toBeLessThan(job.indexOf('pnpm/action-setup@'));
  }
  for (const match of workflow.matchAll(/uses:\s+([^\s#]+)/g)) expect(match[1]).toMatch(/@[a-f0-9]{40}$/);
});

it('PR 仅运行 Basic，素材凭据限定在可信分支的各自游戏步骤', () => {
  expect(workflow).toContain('pull_request:');
  expect(workflow).not.toMatch(/^\s+(?:pull_request_target|inputs|ref):/m);
  expect(basic).not.toMatch(/secrets\.|ci:real-game/);
  for (const job of [ra2, yr]) {
    expect(job).toContain("github.event_name != 'pull_request'");
    expect(job).toContain("github.ref == 'refs/heads/main'");
    expect(job).toContain("github.ref == 'refs/heads/dev'");
  }
  expect(ra2).toContain('GAME_RA2_URL: ${{ secrets.GAME_RA2_URL }}');
  expect(ra2).toContain('GAME_RA2_SHA256: ${{ secrets.GAME_RA2_SHA256 }}');
  expect(ra2).not.toContain('GAME_RA2_YR');
  expect(yr).toContain('GAME_RA2_YR_URL: ${{ secrets.GAME_RA2_YR_URL }}');
  expect(yr).toContain('GAME_RA2_YR_SHA256: ${{ secrets.GAME_RA2_YR_SHA256 }}');
  expect(workflow).not.toMatch(/upload-artifact@|continue-on-error:|vars\./);
});

it('Basic → RA2 → YR 串行，RA2 失败保留结果且不吞掉 YR 验收', () => {
  expect(ra2).toContain('needs: basic');
  expect(yr).toContain('needs: [basic, ra2]');
  expect(yr).toContain("always() && !cancelled() && needs.basic.result == 'success'");
  expect(yr).not.toContain("needs.ra2.result == 'success'");
  expect(ra2).toContain('pnpm run ci:real-game ra2');
  expect(yr).toContain('pnpm run ci:real-game yr');
  expect(workflow).not.toMatch(/matrix:|flock|RA2_CI_LOCK_FILE/);
});

it('Basic 显式选择无素材目录，有资源入口仍执行原始 EXE 契约', () => {
  const pkg = JSON.parse(read('package.json'));
  expect(pkg.scripts['test:unit']).toContain('vitest run tests/basic packages/relay/tests');
  expect(pkg.scripts['test:e2e']).toContain('--maxWorkers=1');
  expect(readdirSync('tests').filter((file) => file.endsWith('.test.ts'))).toEqual([]);
  expect(read('tests/basic/ra2ShortGame.test.ts')).not.toMatch(/fetch\(|readFile|\.tmp-third-party/);
  const script = read('scripts/ci/run.mts');
  expect(script).toContain("existsSync('game') || existsSync('.tmp-third-party')");
  expect(script).toContain("VM_GAME_DIR: join(roots.game, 'ra2')");
  expect(script).toContain('tests/real-game/ra2/shortGame.test.ts');
  expect(script).toContain('tests/real-game/ra2/nativeLauncher.test.ts');
  expect(script).toContain("await tasks.run('save-load', 14, 'pnpm', [");
  expect(script).toContain('tests/real-game/${gameId}/saveLoad.test.ts');
  for (const gameId of ['ra2', 'yr']) expect(existsSync(`tests/real-game/${gameId}/saveLoad.test.ts`)).toBe(true);
  // Do not inherit local VM_* debug switches; identify missing secret variables instead of falling into a generic download-failure branch.
  expect(script).toMatch(/key\.startsWith\('VM_'\)/);
  expect(script).toContain('缺少 ${prefix}_URL');
  expect(read('scripts/ci/processes.ts')).toContain('--strictPort');
  // Missing game resources fail every entry, so real-game scripts must not carry a skip switch.
  for (const name of ['test:e2e', 'test:vm', 'test:vm:ra2', 'test:vm:yr']) {
    expect(pkg.scripts[name], name).not.toContain('VM_REQUIRE_GAME_RESOURCES');
  }
});

it('keeps public and resource-job caches separate and caches no installations or test results', () => {
  for (const [scope, jobs] of [
    ['basic', [basic]],
    ['real-game', [ra2, yr]],
  ] as const) {
    for (const job of jobs) {
      const cacheSteps = job.split('      - name: ').filter((step) => step.includes('uses: actions/cache@'));
      expect(cacheSteps).toHaveLength(2);
      expect(cacheSteps[0]).toContain(`-${scope}-pnpm-v1-`);
      expect(cacheSteps[0]).toContain("hashFiles('pnpm-lock.yaml', 'package.json')");
      expect(cacheSteps[1]).toContain(`-${scope}-cpu-v1-`);
      expect(cacheSteps[1]).toContain('steps.rust.outputs.cachekey');
      expect(cacheSteps[1]).toContain("'scripts/vm/buildV86.mts', 'scripts/vm/patches/**'");
      for (const step of cacheSteps) expect(step).not.toMatch(/restore-keys:|secrets\.|game\/|screenshots|\.tmp-/);
      expect(cacheSteps[1]).toContain('node_modules/.cache/ra2vm-v86/cpu.wasm');
      expect(cacheSteps[1]).not.toContain('ra2vm-v86/source');
    }
  }
});
