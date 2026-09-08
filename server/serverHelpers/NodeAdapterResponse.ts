import { STATUS_CODES } from 'node:http';
import type {
	IncomingMessage as NodeIncomingMessage,
	OutgoingHttpHeader,
	OutgoingHttpHeaders,
	ServerResponse as NodeServerResponse,
} from 'node:http';
import type { Socket } from 'node:net';
import { PassThrough } from 'node:stream';
import { Headers as ResponseHeaders, applyWriteHeadHeaders } from './Headers.ts';

export interface AdaptedResponse {
	status: number;
	headers: ResponseHeaders;
	body: PassThrough;
}

class HeadersSentError extends Error {
	code = 'ERR_HTTP_HEADERS_SENT';
	constructor(action: string) {
		super(`Cannot ${action} headers after they are sent to the client`);
	}
}

class UnsupportedResponseMethodError extends Error {
	constructor(method: string) {
		super(`${method}() is not supported on a withNodeAdapter() response`);
	}
}

const ignoreError = () => {};

/**
 * The `ServerResponse` a `withNodeAdapter()` handler receives, and the body the adapter resolves with.
 * Headers commit via `this.writeHead` so a `writeHead` that `on-headers` replaced on the instance runs
 * first; the adapter owns the 'error' listener because a destroy right after `writeHead()` emits
 * before the awaiting caller can attach one.
 */
export class NodeAdapterResponse extends PassThrough implements NodeServerResponse {
	statusCode = 200;
	statusMessage = '';
	strictContentLength = false;
	chunkedEncoding = false;
	shouldKeepAlive = true;
	useChunkedEncodingByDefault = true;
	sendDate = true;
	readonly req: NodeIncomingMessage;
	readonly socket: Socket | null;
	#headers = new ResponseHeaders();
	#committedStatus: number | undefined;
	#headerText: string | undefined;
	#nodeResponse: NodeServerResponse | undefined;
	#forwardsTimeout = false;
	#resolve: (response: AdaptedResponse) => void;
	#reject: (reason: unknown) => void;

	constructor(
		req: NodeIncomingMessage,
		nodeResponse: NodeServerResponse | undefined,
		resolve: (response: AdaptedResponse) => void,
		reject: (reason: unknown) => void
	) {
		super();
		this.req = req;
		this.socket = req.socket ?? null;
		this.#nodeResponse = nodeResponse;
		this.#resolve = resolve;
		this.#reject = reject;
		this.on('error', ignoreError);
	}

	get headersSent() {
		return this.#committedStatus !== undefined;
	}
	get finished() {
		return this.writableEnded;
	}
	get connection() {
		return this.socket;
	}
	// `compression` <= 1.7 (the version Next.js vendors) tests `_header` on every write
	get _header(): string | null {
		if (this.#committedStatus === undefined) return null;
		if (this.#headerText === undefined) {
			let text = `HTTP/1.1 ${this.#committedStatus} ${this.statusMessage}\r\n`;
			for (const [name, value] of this.#headers) {
				for (const entry of Array.isArray(value) ? value : [value]) text += `${name}: ${entry}\r\n`;
			}
			this.#headerText = text + '\r\n';
		}
		return this.#headerText;
	}

	setHeader(name: string, value: number | string | readonly string[]) {
		if (this.headersSent) throw new HeadersSentError('set');
		this.#headers.set(name, value);
		return this;
	}
	setHeaders(headers: Headers | Map<string, number | string | readonly string[]>) {
		let cookies: string[] | undefined;
		for (const [name, value] of headers) {
			if (name === 'set-cookie') (cookies ??= []).push(...(Array.isArray(value) ? value : [String(value)]));
			else this.setHeader(name, value);
		}
		if (cookies) this.setHeader('set-cookie', cookies);
		return this;
	}
	appendHeader(name: string, value: string | readonly string[]) {
		if (this.headersSent) throw new HeadersSentError('append');
		if (Array.isArray(value)) for (const entry of value) this.#headers.append(name, entry);
		else this.#headers.append(name, value);
		return this;
	}
	getHeader(name: string) {
		return this.#headers.get(name);
	}
	getHeaders() {
		const headers: OutgoingHttpHeaders = Object.create(null);
		for (const [name, [, value]] of this.#headers.entries()) headers[name] = value;
		return headers;
	}
	getHeaderNames() {
		return [...this.#headers.keys()];
	}
	hasHeader(name: string) {
		return this.#headers.has(name);
	}
	removeHeader(name: string) {
		if (this.headersSent) throw new HeadersSentError('remove');
		this.#headers.delete(name);
	}

	writeHead(statusCode: number, statusMessage?: string, headers?: OutgoingHttpHeaders | OutgoingHttpHeader[]): this;
	writeHead(statusCode: number, headers?: OutgoingHttpHeaders | OutgoingHttpHeader[]): this;
	writeHead(
		statusCode: number,
		statusMessageOrHeaders?: string | OutgoingHttpHeaders | OutgoingHttpHeader[],
		headers?: OutgoingHttpHeaders | OutgoingHttpHeader[]
	) {
		if (this.headersSent) throw new HeadersSentError('write');
		this.statusCode = statusCode;
		if (typeof statusMessageOrHeaders === 'string') this.statusMessage = statusMessageOrHeaders;
		else {
			this.statusMessage ||= STATUS_CODES[statusCode] || 'unknown';
			headers = statusMessageOrHeaders;
		}
		if (headers) applyWriteHeadHeaders(this, headers);
		this.#committedStatus = statusCode;
		this.#resolve({ status: statusCode, headers: this.#headers, body: this });
		return this;
	}
	_implicitHeader() {
		this.writeHead(this.statusCode);
	}
	flushHeaders() {
		if (!this.headersSent) this._implicitHeader();
	}

	write(
		chunk: unknown,
		encoding?: BufferEncoding | ((error?: Error | null) => void),
		callback?: (error?: Error | null) => void
	) {
		if (!this.headersSent) this._implicitHeader();
		return super.write(chunk, encoding as BufferEncoding, callback);
	}
	end(chunk?: unknown, encoding?: BufferEncoding | (() => void), callback?: () => void) {
		if (!this.headersSent) this._implicitHeader();
		return super.end(chunk, encoding as BufferEncoding, callback);
	}
	_destroy(error: Error | null, callback: (error?: Error | null) => void) {
		if (!this.headersSent) this.#reject(error ?? new Error('Response destroyed before headers were sent'));
		callback(error);
	}

	setTimeout(msecs: number, callback?: () => void) {
		if (callback) this.on('timeout', callback);
		const nodeResponse = this.#nodeResponse;
		if (typeof nodeResponse?.setTimeout !== 'function') return this;
		nodeResponse.setTimeout(msecs);
		if (this.#forwardsTimeout) return this;
		this.#forwardsTimeout = true;
		// Node destroys a timed-out socket only when no request, response or server listener handled the
		// event, judged by emit()'s return value, so the forwarder exists exactly while this response has
		// 'timeout' listeners of its own.
		const forward = () => this.emit('timeout');
		let forwarding = false;
		const syncForwarding = (wanted: boolean) => {
			if (wanted === forwarding) return;
			forwarding = wanted;
			if (wanted) nodeResponse.on('timeout', forward);
			else nodeResponse.removeListener('timeout', forward);
		};
		this.on('newListener', (event) => event === 'timeout' && syncForwarding(true));
		this.on('removeListener', (event) => event === 'timeout' && syncForwarding(this.listenerCount('timeout') > 0));
		this.once('close', () => syncForwarding(false));
		syncForwarding(this.listenerCount('timeout') > 0);
		return this;
	}
	// Informational responses go to the real Node response; a Request built without one still gets the
	// callback so a handler awaiting it cannot hang.
	writeContinue(callback?: () => void) {
		if (typeof this.#nodeResponse?.writeContinue === 'function') this.#nodeResponse.writeContinue(callback);
		else callback?.();
	}
	writeProcessing(callback?: () => void) {
		if (typeof this.#nodeResponse?.writeProcessing === 'function') this.#nodeResponse.writeProcessing(callback);
		else callback?.();
	}
	writeEarlyHints(hints: Record<string, string | string[]>, callback?: () => void) {
		if (typeof this.#nodeResponse?.writeEarlyHints === 'function') this.#nodeResponse.writeEarlyHints(hints, callback);
		else callback?.();
	}
	// Trailers need chunked encoding on the wire, which Harper's response layer owns; dropping one silently (a Digest, say) is worse than failing.
	addTrailers(): never {
		throw new UnsupportedResponseMethodError('addTrailers');
	}
	assignSocket(): never {
		throw new UnsupportedResponseMethodError('assignSocket');
	}
	detachSocket(): never {
		throw new UnsupportedResponseMethodError('detachSocket');
	}
}
