import busboy from 'busboy';
import type { FastifyRequest } from 'fastify';
import type { Readable } from 'node:stream';
import { ClientError } from '../../utility/errors/hdbError.ts';
import { logger } from '../../utility/logging/logger.ts';

interface MultipartBody {
	[key: string]: unknown;
	payload?: Readable;
}

const FIELD_SIZE_LIMIT = 1024 * 1024; // 1 MB per non-file field — generous for JSON params
const MAX_FIELDS = 64;
// Operation handlers stream the file part directly into extraction (gunzip + tar-fs),
// so there is no separate filesize cap to enforce here. Backpressure flows through busboy
// → the file Readable → the consumer, bounded by disk space rather than memory.

/**
 * Parse a multipart/form-data request body for the operations API.
 *
 * Field parts populate properties on the returned body object; values that look like JSON
 * (`{...}`, `[...]`, numbers, booleans, null) are decoded so the operations API sees the
 * same shape it would from a JSON/CBOR body. The (optional) file part — by convention the
 * last part, named `payload` — is exposed as a Readable on `body.payload` and streamed
 * lazily by the operation handler; this lets us deploy components larger than the Node.js
 * 2 GB Buffer cap.
 *
 * The CLI must place the file part LAST so all dispatching fields (`operation`, auth-
 * relevant flags, etc.) have arrived by the time the route handler runs.
 */
export function parseMultipartRequest(
	request: FastifyRequest,
	rawStream: Readable,
	done: (err: Error | null, body?: MultipartBody) => void
): void {
	const contentType = request.headers['content-type'];
	if (!contentType) {
		done(new ClientError('Missing Content-Type header', 400));
		return;
	}

	let bb: ReturnType<typeof busboy>;
	try {
		bb = busboy({
			headers: { 'content-type': contentType },
			limits: {
				fieldSize: FIELD_SIZE_LIMIT,
				fields: MAX_FIELDS,
				files: 1,
			},
		});
	} catch (err) {
		done(toClientError(err, 'Invalid multipart request'));
		return;
	}

	const body: MultipartBody = {};
	let fileSeen = false;
	let doneCalled = false;

	const callDone = (err: Error | null, value?: MultipartBody) => {
		if (doneCalled) return;
		doneCalled = true;
		done(err, value);
	};

	bb.on('field', (name, value) => {
		if (fileSeen) {
			// Fields after the file part are out-of-order and ignored. We can't propagate them
			// to the route handler — by the time busboy emits the event, `done` has already
			// fired and the file stream has typically ended too. The CLI always sends fields
			// first; this branch only fires on malformed/hand-crafted clients.
			logger.warn?.(`Multipart field "${name}" arrived after the file part; ignoring`);
			return;
		}
		body[name] = decodeFieldValue(value);
	});

	bb.on('file', (name, fileStream) => {
		fileSeen = true;
		if (name !== 'payload') {
			// We only consume a single field named `payload`. Other file fields are an error
			// rather than silently consumed — the CLI never sends them and accepting them
			// would mask client bugs.
			fileStream.resume(); // drain so busboy can finish
			callDone(new ClientError(`Unexpected file field "${name}"; expected "payload"`, 400));
			return;
		}
		body.payload = fileStream;
		// Hand control to the route handler immediately — the file stream is now wired
		// into body.payload and will be drained by extraction. busboy keeps pumping data
		// out of rawStream as the consumer reads, providing natural backpressure.
		callDone(null, body);
	});

	bb.on('error', (err) => {
		callDone(toClientError(err, 'Malformed multipart body'));
	});

	bb.on('close', () => {
		// If the request had no file part, the handler still needs to dispatch on the fields
		// we collected (e.g. an operation that doesn't need a payload at all).
		if (!doneCalled) callDone(null, body);
	});

	rawStream.on('error', (err) => {
		const clientErr = toClientError(err, 'Request stream error');
		// If `done` hasn't fired yet, the route handler hasn't started and this surfaces as a
		// dispatch error. If it has — i.e. the file part is mid-stream — `callDone` is a no-op
		// but the file Readable already handed out as `body.payload` is its own object that
		// `bb.destroy()` does NOT propagate to. We have to destroy it explicitly, otherwise
		// the consumer (`pipeline(tarball, gunzip(), extract(...))` in Application.ts) hangs
		// until TCP keepalives close the socket. Node's `.pipe()` doesn't forward errors from
		// source to destination either, hence we don't rely on it here.
		callDone(clientErr);
		const payload = body.payload as (Readable & { destroyed?: boolean }) | undefined;
		if (payload && !payload.destroyed) payload.destroy(clientErr);
		bb.destroy(clientErr);
	});

	rawStream.pipe(bb);
}

function decodeFieldValue(raw: string): unknown {
	if (raw === '') return raw;
	const first = raw.charCodeAt(0);
	// Only attempt JSON parse for values that begin with a JSON sentinel — otherwise the
	// overwhelming common case of a plain string identifier ("my-project") needlessly
	// goes through a try/catch.
	const looksLikeJson =
		first === 0x7b /* { */ ||
		first === 0x5b /* [ */ ||
		first === 0x22 /* " */ ||
		first === 0x2d /* - */ ||
		(first >= 0x30 && first <= 0x39) /* 0-9 */ ||
		raw === 'true' ||
		raw === 'false' ||
		raw === 'null';
	if (!looksLikeJson) return raw;
	try {
		return JSON.parse(raw);
	} catch {
		return raw;
	}
}

function toClientError(err: unknown, fallbackMessage: string): ClientError {
	if (err instanceof ClientError) return err;
	const message = err instanceof Error ? err.message : fallbackMessage;
	logger.debug?.('Multipart parse error: ' + message);
	return new ClientError(message || fallbackMessage, 400);
}
