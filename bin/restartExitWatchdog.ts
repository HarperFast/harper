import { spawn, type ChildProcess } from 'node:child_process';

import hdbLogger from '../utility/logging/harper_logger.ts';

// Every way the script below can give up is a silent `exit 0` — an unreadable procfs (a sandbox that
// does not mount /proc) or a base image without `sleep`. Reporting the watchdog armed in exactly
// those environments would replace the operator's one signal that teardown is unbounded with a claim
// that it is not, so arming waits for the script to prove both facilities before it says so.
export const WATCHDOG_READY_TOKEN = 'harper-restart-exit-watchdog-ready';
const WATCHDOG_READY_TIMEOUT_MS = 5000;

export const WATCHDOG_SCRIPT = `
parent_pid=$1
delay_seconds=$2
[ "$parent_pid" -gt 1 ] || exit 0
command -v sleep > /dev/null 2>&1 || exit 0
# Shell PPID variables are snapshots; procfs reflects reparenting after Harper exits.
read -r _ _ _ current_parent _ < "/proc/$$/stat" || exit 0
[ "$current_parent" = "$parent_pid" ] || exit 0
echo "${WATCHDOG_READY_TOKEN}"
sleep "$delay_seconds" || exit 0
read -r _ _ _ current_parent _ < "/proc/$$/stat" || exit 0
[ "$current_parent" = "$parent_pid" ] || exit 0
echo "harper: restart exit watchdog force-killing pid $parent_pid after $delay_seconds seconds" >&2
kill -KILL "$parent_pid"
`;

export async function armRestartExitWatchdog(timeoutMs: number) {
	if (process.platform !== 'linux') {
		hdbLogger.warn('Restart exit watchdog is only available on Linux');
		return false;
	}
	if (process.pid <= 1) {
		hdbLogger.warn('Restart exit watchdog requires Harper to run below a container init process');
		return false;
	}
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
		hdbLogger.warn('Restart exit watchdog requires a positive finite timeout');
		return false;
	}

	try {
		const timeoutSeconds = Math.max(1, Math.ceil(timeoutMs / 1000));
		const watchdogPath = ['/usr/bin', '/bin', process.env.PATH].filter(Boolean).join(':');
		const watchdog = spawn(
			'/bin/sh',
			['-c', WATCHDOG_SCRIPT, 'harper-restart-exit-watchdog', String(process.pid), String(timeoutSeconds)],
			{
				env: { PATH: watchdogPath },
				stdio: ['ignore', 'pipe', 'inherit'],
				windowsHide: true,
			}
		);
		// Before the pid check: a spawn failure (EMFILE on the very wedged process this bounds) emits
		// 'error' asynchronously, and an unhandled one becomes an uncaughtException mid-teardown.
		watchdog.once('error', (error) => hdbLogger.warn('Restart exit watchdog failed', error));
		if (watchdog.pid === undefined) {
			hdbLogger.warn('Restart exit watchdog failed to start');
			return false;
		}
		watchdog.unref();

		const ready = await waitForWatchdogReady(watchdog);
		// The token is the last thing the script writes to stdout; the force-kill diagnostic goes to the
		// inherited stderr so it survives a wedged Harper event loop.
		watchdog.stdout.destroy();
		if (!ready) {
			watchdog.kill('SIGKILL');
			hdbLogger.warn('Restart exit watchdog could not confirm it was armed');
			return false;
		}
		hdbLogger.info(`Restart exit watchdog armed for ${timeoutSeconds} seconds`);
		return true;
	} catch (error) {
		hdbLogger.warn('Restart exit watchdog failed to start', error);
		return false;
	}
}

export function waitForWatchdogReady(watchdog: ChildProcess, timeoutMs = WATCHDOG_READY_TIMEOUT_MS) {
	return new Promise<boolean>((resolve) => {
		let settled = false;
		const settle = (value: boolean) => {
			if (settled) return;
			settled = true;
			clearTimeout(readyTimer);
			resolve(value);
		};
		const readyTimer = setTimeout(() => settle(false), timeoutMs);
		readyTimer.unref();
		let output = '';
		watchdog.stdout?.on('data', (chunk) => {
			output += chunk;
			if (output.includes(WATCHDOG_READY_TOKEN)) settle(true);
		});
		watchdog.once('error', () => settle(false));
		watchdog.once('exit', () => settle(false));
	});
}
