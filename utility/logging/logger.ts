/** Like harperLogger, but conditionally exports functions based on the log level. */
import harperLogger from './harper_logger.ts';

export const logger: Logger = harperLogger.conditional;

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
