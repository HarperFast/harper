import { spawn } from 'node:child_process';

import hdbLogger from '../utility/logging/harper_logger.ts';

const WATCHDOG_SCRIPT = `
parent_pid=$1
delay_seconds=$2
[ "$parent_pid" -gt 1 ] || exit 0
# Shell PPID variables are snapshots; procfs reflects reparenting after Harper exits.
read -r _ _ _ current_parent _ < "/proc/$$/stat" || exit 0
[ "$current_parent" = "$parent_pid" ] || exit 0
sleep "$delay_seconds" || exit 0
read -r _ _ _ current_parent _ < "/proc/$$/stat" || exit 0
[ "$current_parent" = "$parent_pid" ] || exit 0
echo "harper: restart exit watchdog force-killing pid $parent_pid after $delay_seconds seconds" >&2
kill -KILL "$parent_pid"
`;

export function armRestartExitWatchdog(timeoutMs: number) {
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
		const watchdog = spawn(
			'/bin/sh',
			['-c', WATCHDOG_SCRIPT, 'harper-restart-exit-watchdog', String(process.pid), String(timeoutSeconds)],
			{
				env: { PATH: '/usr/bin:/bin' },
				stdio: ['ignore', 'ignore', 'inherit'],
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
