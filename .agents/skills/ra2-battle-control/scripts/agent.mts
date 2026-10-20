import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { ControlClient } from './client';
import { CONTROL_PORT, CHANNEL_PATTERN } from './protocol';

const root = fileURLToPath(new URL('../', import.meta.url));
const { values } = parseArgs({
  options: {
    agent: { type: 'string', default: 'codex' },
    channel: { type: 'string' },
    port: { type: 'string', default: String(CONTROL_PORT) },
    model: { type: 'string' },
    'quick-start': { type: 'boolean', default: false },
    'dry-run': { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h' },
  },
});

try {
  if (values.help) {
    console.log(
      'Usage: pnpm ra2agent --agent codex|claude --channel NAME [--port PORT] [--model MODEL] [--quick-start] [--dry-run]',
    );
  } else {
    const agent = values.agent!;
    if (agent !== 'codex' && agent !== 'claude') throw new Error('--agent must be codex or claude');
    const channel = values.channel ?? '';
    if (!CHANNEL_PATTERN.test(channel)) throw new Error('--channel is required (1..64 letters, digits, _ or -)');
    const port = Number(values.port);
    const client = new ControlClient(port, channel);
    const guidance = [
      `\n--- ra2-battle-control/SKILL.md ---\n${await readFile(new URL('../SKILL.md', import.meta.url), 'utf8')}`,
    ];
    // A separately installed strategy skill adds guidance; control and serve remain self-contained.
    try {
      guidance.unshift(
        `\n--- ra2-strategy/SKILL.md ---\n${await readFile(new URL('../../ra2-strategy/SKILL.md', import.meta.url), 'utf8')}`,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const quotedRoot = "'" + root.replaceAll("'", "'\\''") + "'";
    const prefix = `pnpm --dir ${quotedRoot} ra2ctl --port ${port} --channel ${channel}`;
    const prompt = `Play RA2/YR through the public ra2ctl API on channel ${channel}, port ${port}.
This is a gameplay session, not a coding task. Do not edit the project, inspect guest memory, or run compatibility tests.
Use only this channel and one sequential command writer. Every ra2ctl command must use: ${prefix}
First request ui.status and capabilities. ${values['quick-start'] ? 'If no battle is running and ui.status advertises ui.quickStart, request it once via ra2ctl start and wait for the native battlefield.' : 'Join the existing battle; do not start or replace a match. If none is running, report that and wait for the user.'}
Use compact ctl output and sequential batches; let ctl manage session/frame/receipt IDs, and play until the native result, cancellation, disconnect, session replacement, or an unresolved command failure.
Coordinate production, legal building placement, scouting, defense and combat. Use bounded monitor windows and keep observing and acting; do not stop after a plan or one build order.
Report progress in Chinese. Verify Q/W/E/R switching and command effects. Never infer victory from an empty viewport.
Stop all command writers when interrupted; do not leave background bots. The game and control server are owned separately; do not stop them.
The following shared strategy and battle-control guidance applies. Substitute the exact command prefix above in its examples.
${guidance.join('\n')}`;
    const args = [...(values.model ? ['--model', values.model] : []), prompt];
    if (values['dry-run']) {
      console.log(JSON.stringify({ executable: agent, cwd: root, args }, null, 2));
    } else {
      // Fail before launching a model when the page/channel is unavailable. This request is read-only.
      await client.request('ui.status');
      console.log(
        `Starting ${agent} for channel ${channel} on port ${port}. Use the agent terminal to interrupt or steer play.`,
      );
      // Keep the interactive CLI's own authentication, permissions and terminal UI.
      // No shell interpolation, permission bypass, background process or automatic restart.
      const child = spawn(agent, args, { cwd: root, stdio: 'inherit', shell: false });
      const interrupt = () => {
        child.kill('SIGINT');
      };
      const terminate = () => {
        child.kill('SIGTERM');
      };
      process.on('SIGINT', interrupt);
      process.on('SIGTERM', terminate);
      await new Promise<void>((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (code, signal) => {
          process.exitCode = code ?? (signal === 'SIGINT' ? 130 : 143);
          resolve();
        });
      }).finally(() => {
        process.off('SIGINT', interrupt);
        process.off('SIGTERM', terminate);
      });
    }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
