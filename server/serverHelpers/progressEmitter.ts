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
	// Prime the stream with an SSE comment line so the response body is non-empty by the time
	// Fastify starts piping. Without this, Fastify buffers the PassThrough's internal queue
	// until its end and only flushes the final chunk to the wire — making intermediate
	// progress events invisible to the client. The comment ": ..." is a valid SSE record
	// that consumers ignore, so it's safe filler.
	stream.write(`: stream open\n\n`);

	let active = true;
	const unsubscribe = emitter.subscribe((event) => {
		if (active) writeSSE(stream, event);
	});

	const cleanup = () => {
		if (active) {
			active = false;
			unsubscribe();
		}
	};

	// If the client disconnects (Ctrl-C, network drop) stop writing to the stream and
	// release the emitter subscription so it doesn't accumulate for the operation lifetime.
	stream.on('close', cleanup);
	stream.on('end', cleanup);

	operation()
		.then((result) => {
			if (active) writeSSE(stream, { event: 'done', data: { result } });
		})
		.catch((err) => {
			if (active) {
				writeSSE(stream, {
					event: 'error',
					data: {
						message: err?.message ?? String(err),
						code: err?.statusCode ?? err?.code,
					},
				});
			}
		})
		.finally(() => {
			cleanup();
			stream.end();
		});

	return stream;
}

function writeSSE(stream: PassThrough, event: ProgressEvent): void {
	const data = typeof event.data === 'string' ? event.data : JSON.stringify(event.data);
	stream.write(`event: ${event.event}\n`);
	for (const line of data.split(/\r?\n/)) {
		stream.write(`data: ${line}\n`);
	}
	stream.write('\n');
}
