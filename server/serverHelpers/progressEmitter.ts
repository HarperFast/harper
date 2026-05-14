import { PassThrough, Readable } from 'node:stream';

export interface ProgressEvent {
	event: string;
	data: unknown;
}

export type ProgressListener = (event: ProgressEvent) => void;

/**
 * Lightweight pub-sub used to report phase/install/replicate events from a long-running
 * operation back to the HTTP layer. We deliberately don't use Node's EventEmitter here:
 * we only need broadcast semantics for a small set of event types, and we want the
 * `emit(event, data)` shape that matches the SSE wire format directly.
 */
export class ProgressEmitter {
	private listeners: ProgressListener[] = [];

	emit(event: string, data: unknown): void {
		// Snapshot before iteration so a listener that unsubscribes itself during dispatch
		// doesn't shift indexes underneath us.
		const snapshot = this.listeners.slice();
		for (const listener of snapshot) {
			try {
				listener({ event, data });
			} catch {
				// A buggy listener must never break the operation. Swallow and continue.
			}
		}
	}

	subscribe(listener: ProgressListener): () => void {
		this.listeners.push(listener);
		return () => {
			const i = this.listeners.indexOf(listener);
			if (i !== -1) this.listeners.splice(i, 1);
		};
	}
}

/**
 * Wrap a long-running operation so its progress events stream back as Server-Sent Events.
 *
 * The returned Readable emits one SSE message per `emitter.emit(...)` call, then a final
 * `done` (or `error`) event with the operation's result, then ends. The caller is
 * expected to set Content-Type: text/event-stream on the response.
 */
export function createSSEResponseStream(emitter: ProgressEmitter, operation: () => Promise<unknown>): Readable {
	const stream = new PassThrough();

	const unsubscribe = emitter.subscribe((event) => {
		writeSSE(stream, event);
	});

	operation()
		.then((result) => {
			writeSSE(stream, { event: 'done', data: { result } });
		})
		.catch((err) => {
			writeSSE(stream, {
				event: 'error',
				data: {
					message: err?.message ?? String(err),
					code: err?.statusCode ?? err?.code,
				},
			});
		})
		.finally(() => {
			unsubscribe();
			stream.end();
		});

	return stream;
}

function writeSSE(stream: PassThrough, event: ProgressEvent): void {
	const data = typeof event.data === 'string' ? event.data : JSON.stringify(event.data);
	stream.write(`event: ${event.event}\ndata: ${data}\n\n`);
}
