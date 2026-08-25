import { spawn } from 'node:child_process';

import hdbLogger from '../utility/logging/harper_logger.ts';

const WATCHDOG_SCRIPT = `
parent_pid=$1
delay_seconds=$2
[ "$parent_pid" -gt 1 ] || exit 0
[ "$PPID" -eq "$parent_pid" ] || exit 0
sleep "$delay_seconds"
[ "$PPID" -eq "$parent_pid" ] || exit 0
kill -KILL "$parent_pid"
`;

export function armRestartExitWatchdog(timeoutMs: number) {
	if (process.platform === 'win32') {
		hdbLogger.warn('Restart exit watchdog is unavailable on Windows');
		return false;
	}
	if (process.pid <= 1) {
		hdbLogger.warn('Restart exit watchdog requires Harper to run below a container init process');
		return false;
	}

	try {
		const timeoutSeconds = Math.max(1, Math.ceil(timeoutMs / 1000));
		const watchdog = spawn(
			'/bin/sh',
			['-c', WATCHDOG_SCRIPT, 'harper-restart-exit-watchdog', String(process.pid), String(timeoutSeconds)],
			{
				detached: true,
				env: { PATH: '/usr/bin:/bin' },
				stdio: 'ignore',
				windowsHide: true,
			}
		);
		watchdog.once('error', (error) => hdbLogger.warn('Restart exit watchdog failed', error));
		if (watchdog.pid === undefined) {
			hdbLogger.warn('Restart exit watchdog failed to start');
			return false;
		}
		watchdog.unref();
		hdbLogger.info(`Restart exit watchdog armed for ${timeoutSeconds} seconds`);
		return true;
	} catch (error) {
		hdbLogger.warn('Restart exit watchdog failed to start', error);
		return false;
	}
}
