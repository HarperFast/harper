/** Like harperLogger, but conditionally exports functions based on the log level. */
import harperLogger from './harper_logger.ts';

export const logger: Logger = harperLogger.conditional;

export function loggerWithTag(tag: string): Logger {
	return harperLogger.loggerWithTag(tag, true) as Logger;
}

export interface StatusOptions {
	/** A key identifying the problem. Sets/updates a status entry at this key. */
	problem?: string;
	/** A key to resolve. Clears the status entry at this key back to healthy. */
	resolves?: string;
	/** Positive finite seconds until auto-clear, with `problem`; invalid/nonpositive values leave it persistent. */
	expires?: number;
	/** Status level for status-only calls (no chained log method). Defaults to 'error'. */
	level?: string;
}

export interface StatusLogger {
	notify: (...args: any[]) => void;
	fatal: (...args: any[]) => void;
	error: (...args: any[]) => void;
	warn: (...args: any[]) => void;
	info: (...args: any[]) => void;
	debug: (...args: any[]) => void;
	trace: (...args: any[]) => void;
}

export interface Logger {
	notify?: (...args: any[]) => void;
	fatal?: (...args: any[]) => void;
	error?: (...args: any[]) => void;
	warn?: (...args: any[]) => void;
	info?: (...args: any[]) => void;
	debug?: (...args: any[]) => void;
	trace?: (...args: any[]) => void;
	status?: (options: StatusOptions) => StatusLogger;
}
