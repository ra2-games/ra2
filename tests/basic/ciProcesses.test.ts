import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { Processes } from '../../scripts/ci/processes';

it('编排保留失败、强制终止超时进程，只有成功步骤写 PASS', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ci-process-test-'));
  const tasks = new Processes(root, { ...process.env });
  try {
    await tasks.run('success', 1, process.execPath, ['-e', 'console.log("fixture")']);
    await expect(tasks.run('failure', 1, process.execPath, ['-e', 'process.exit(7)'])).rejects.toThrow('7');
    await expect(tasks.run('timeout', 0.002, process.execPath, ['-e', 'setInterval(()=>{},1000)'])).rejects.toThrow();
    expect(await readFile(join(root, 'results.txt'), 'utf8')).toBe('success PASS\n');
    expect(await readFile(join(root, 'success.log'), 'utf8')).toContain('fixture');
    const service = tasks.start('service', process.execPath, ['-e', 'setInterval(()=>{},1000)']);
    await tasks.close();
    await expect(service.done).rejects.toThrow();
    expect(() => process.kill(service.child.pid!, 0)).toThrow();
  } finally {
    await tasks.close();
    await rm(root, { recursive: true, force: true });
  }
});
