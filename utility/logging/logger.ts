/** Like harperLogger, but conditionally exports functions based on the log level. */
import harperLogger from './harper_logger.js';

export const logger: Logger = {};

for (let level of ['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'notify']) {
	if (harperLogger.logsAtLevel(level)) {
		logger[level] = harperLogger[level];
	}
}

export function loggerWithTag(tag: string): Logger {
	return harperLogger.loggerWithTag(tag, true) as Logger;
}

export interface Logger {
	notify?: (...args: any[]) => void;
	fatal?: (...args: any[]) => void;
	error?: (...args: any[]) => void;
	warn?: (...args: any[]) => void;
	info?: (...args: any[]) => void;
	debug?: (...args: any[]) => void;
	trace?: (...args: any[]) => void;
}
