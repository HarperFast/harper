/**
 * uWebSockets.js HTTP server adapter (SPIKE — github.com/HarperFast/harper issue #914).
 *
 * Creates a non-SSL uWS App on a Unix domain socket and bridges each request through
 * Harper's existing request pipeline: it builds a {@link UwsRequest} (the same duck-typed
 * shape as BunRequest), invokes the supplied `handler` (i.e. `httpChain[port]`), and
 * serializes the returned Harper response descriptor back onto the uWS HttpResponse.
 *
 * Intended for the plaintext-UDS-behind-symphony topology: TLS/mTLS/HTTP-2 are terminated
 * by symphony upstream, the real client IP arrives via X-Forwarded-For, so this server only
 * speaks plaintext HTTP/1.1 and never touches certificates.
 *
 * NOTE: this is the adapter core only. Wiring it into getUwsHTTPServer()/threadServer.js
 * (alongside the Node and Bun UDS paths) and adding `uWebSockets.js` as an optional
 * dependency is the remaining productionization step. The request-construction and
 * response-serialization paths here are exercised by the spike benchmark in ~/dev/tmp/uws-poc.
 */
import { UwsRequest } from './Request.ts';
import { Headers } from './Headers.ts';

// uWS has no npm package; it's installed from a GitHub tag and is platform/ABI-specific.
// Imported lazily so harper builds/loads on platforms without a uWS binary.
type UwsApp = any;
type UwsResponse = any;
type UwsRequestRaw = any;

export interface UwsServerOptions {
	socketPath: string;
	secure?: boolean;
	/** httpChain[port]-style handler: (request) => Harper response descriptor (or undefined). */
	handler: (request: UwsRequest) => Promise<HarperResponse | undefined> | HarperResponse | undefined;
	/** Max bytes to buffer for a request body before rejecting (default 100 MiB, matching ws maxPayload). */
	maxBodyBytes?: number;
}

export interface HarperResponse {
	status?: number;
	headers?: Headers | Record<string, string | string[]>;
	body?: string | Buffer | Uint8Array | Iterable<any> | AsyncIterable<any> | { pipe?: any } | null;
	handlesHeaders?: boolean;
	wasCacheMiss?: boolean;
}

const STATUS_TEXT: Record<number, string> = {
	200: '200 OK',
	201: '201 Created',
	204: '204 No Content',
	301: '301 Moved Permanently',
	302: '302 Found',
	304: '304 Not Modified',
	400: '400 Bad Request',
	401: '401 Unauthorized',
	403: '403 Forbidden',
	404: '404 Not Found',
	500: '500 Internal Server Error',
};
const statusText = (s: number) => STATUS_TEXT[s] ?? `${s} `;

export async function createUwsServer(options: UwsServerOptions): Promise<{ app: UwsApp; close: () => void }> {
	const { default: uWS } = await import('uWebSockets.js' as any);
	const { socketPath, secure = false, handler, maxBodyBytes = 100 * 1024 * 1024 } = options;
	const app: UwsApp = uWS.App();

	const onRequest = (res: UwsResponse, req: UwsRequestRaw, hasBody: boolean) => {
		// uWS HttpRequest is only valid synchronously inside this callback — copy everything now.
		const method = req.getMethod().toUpperCase();
		const query = req.getQuery();
		const url = req.getUrl() + (query ? '?' + query : '');
		const headers: Record<string, string | string[]> = {};
		req.forEach((k: string, v: string) => {
			headers[k] = v;
		});

		const ac = new AbortController();
		res.onAborted(() => ac.abort());

		const dispatch = (bodyBuffer?: Buffer) => {
			const request = new UwsRequest({ method, url, headers, secure, bodyBuffer, signal: ac.signal });
			Promise.resolve(handler(request))
				.then((response) => {
					if (ac.signal.aborted) return;
					writeResponse(res, ac, response);
				})
				.catch((error) => {
					if (ac.signal.aborted) return;
					const status = (error && error.statusCode) || 500;
					res.cork(() => {
						res.writeStatus(statusText(status));
						res.writeHeader('content-type', 'text/plain');
						res.end(String((error && error.message) || error));
					});
				});
		};

		if (hasBody) {
			let buf: Buffer | null = null;
			let total = 0;
			res.onData((chunk: ArrayBuffer, isLast: boolean) => {
				total += chunk.byteLength;
				if (total > maxBodyBytes) {
					if (!ac.signal.aborted) res.cork(() => res.writeStatus('413 Payload Too Large').end());
					ac.abort();
					return;
				}
				const part = Buffer.from(chunk); // copy: uWS neuters the ArrayBuffer on return
				buf = buf ? Buffer.concat([buf, part]) : part;
				if (isLast) dispatch(buf ?? undefined);
			});
		} else {
			dispatch(undefined);
		}
	};

	app.get('/*', (res: UwsResponse, req: UwsRequestRaw) => onRequest(res, req, false));
	app.head('/*', (res: UwsResponse, req: UwsRequestRaw) => onRequest(res, req, false));
	app.any('/*', (res: UwsResponse, req: UwsRequestRaw) => onRequest(res, req, true));

	await new Promise<void>((resolve, reject) => {
		app.listen_unix((listenSocket: unknown) => {
			if (listenSocket) resolve();
			else reject(new Error(`uWS failed to bind unix socket ${socketPath}`));
		}, socketPath);
	});

	return {
		app,
		close: () => app.close(),
	};
}

function writeResponse(res: UwsResponse, ac: AbortController, response: HarperResponse | undefined): void {
	if (!response) {
		res.cork(() => res.writeStatus('404 Not Found').end('Not found\n'));
		return;
	}
	const status = response.status || 200;
	let body = response.body;

	// Normalize headers to a Harper Headers instance so we can iterate uniformly.
	const headers =
		response.headers instanceof Headers ? response.headers : new Headers(response.headers as any);

	if (!response.handlesHeaders) {
		if (!body) {
			headers.set('Content-Length', '0');
		} else if (typeof body === 'string') {
			headers.set('Content-Length', String(Buffer.byteLength(body)));
		} else if ((body as Buffer | Uint8Array).length >= 0) {
			headers.set('Content-Length', String((body as Buffer | Uint8Array).length));
		}
	}

	res.cork(() => {
		res.writeStatus(statusText(status));
		for (const [name, value] of headers) {
			// uWS derives Content-Length from end(body); writing it explicitly would duplicate it.
			if ((name as string).toLowerCase() === 'content-length') continue;
			if (Array.isArray(value)) for (const v of value) res.writeHeader(name, String(v));
			else if (value != null) res.writeHeader(name, String(value));
		}
		if (body == null) res.end();
		else if (typeof body === 'string' || Buffer.isBuffer(body) || body instanceof Uint8Array) res.end(body as any);
		else res.end(); // streaming bodies (pipe/iterables) not handled in the spike adapter
	});
}
