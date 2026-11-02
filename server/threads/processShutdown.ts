import harperLogger from '../../utility/logging/harper_logger.ts';
import { beginProcessShutdown, stopWorkersForExit, workers } from './manageThreads.ts';

type ThreadShutdown = (exitDeadline: number) => Promise<unknown>;
let mainThreadShutdown: ThreadShutdown | undefined;

/** threadServer registers the main thread's own shutdown when it loads; before that main has no servers or scopes. */
export function registerMainThreadShutdown(shutdown: ThreadShutdown): void {
	mainThreadShutdown = shutdown;
}

/**
 * Stop every worker through its SHUTDOWN sequence and shut the main thread down, by `exitDeadline`. Never
 * rejects. Storage is closed afterwards by the process `exit` listeners.
 */
export function shutdownProcess(exitDeadline: number): Promise<unknown> {
	beginProcessShutdown();
	return Promise.allSettled([
		stopWorkersForExit(exitDeadline),
		Promise.resolve().then(() => mainThreadShutdown?.(exitDeadline)),
	]).then((results) => {
		for (const result of results) {
			if (result.status === 'rejected') harperLogger.error('Error during shutdown', result.reason);
		}
	});
}

/**
 * The SIGINT/SIGQUIT/SIGTERM handler. The first signal runs `shutdown` and exits when it settles or
 * `getTimeoutMs()` passes, whichever is first; a later signal exits at once. `exit` runs exactly once.
 */
export function createTerminationHandler({
	getTimeoutMs,
	shutdown,
	exit,
}: {
	getTimeoutMs: () => number;
	shutdown: (exitDeadline: number) => Promise<unknown>;
	exit: () => void;
}): (signal: string) => void {
	// Exit-time lines use notify: it writes synchronously, and a buffered line would be lost to exit().
	let shuttingDown = false;
	let exited = false;
	const exitOnce = () => {
		if (exited) return;
		exited = true;
		exit();
	};
	return (signal) => {
		if (shuttingDown) {
			harperLogger.notify(`Received ${signal} during shutdown; exiting without waiting for it to finish`);
			return exitOnce();
		}
		shuttingDown = true;
		const timeoutMs = getTimeoutMs();
		if (timeoutMs === 0) return exitOnce();
		const exitDeadline = Date.now() + timeoutMs;
		setTimeout(() => {
			if (exited) return;
			harperLogger.notify(
				`Shutdown did not finish within ${timeoutMs} ms (threads.shutdownTimeout); exiting with ${workers.length} worker thread(s) still running`
			);
			exitOnce();
		}, timeoutMs);
		harperLogger.notify(
			`Received ${signal}; shutting down within ${timeoutMs} ms. Send the signal again to exit immediately.`
		);
		Promise.resolve()
			.then(() => shutdown(exitDeadline))
			.catch((error) => harperLogger.error('Error during shutdown', error))
			.then(() => {
				if (exited) return;
				harperLogger.notify('Shutdown complete');
				exitOnce();
			});
	};
}
