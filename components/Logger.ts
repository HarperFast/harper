export interface Logger {
	logLevel: string;

	notify: (...args: any[]) => void;
	fatal: (...args: any[]) => void;
	error: (...args: any[]) => void;
	warn: (...args: any[]) => void;
	info: (...args: any[]) => void;
	debug: (...args: any[]) => void;
	trace: (...args: any[]) => void;

	withTag: (tag: string) => Logger;
	loggerWithTag: (tag: string) => Logger;
}
