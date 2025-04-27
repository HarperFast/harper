import { serialize, serializeMessage, getDeserializer } from '../server/serverHelpers/contentTypes.ts';
import { addAnalyticsListener, recordAction, recordActionBinary } from '../resources/analytics/write.ts';
import * as harperLogger from '../utility/logging/harper_logger.js';
import { ServerOptions } from 'http';
import { ServerError, ClientError } from '../utility/errors/hdbError.js';
import { Resources } from '../resources/Resources.ts';
import { parseQuery } from '../resources/search.ts';
import { IterableEventQueue } from '../resources/IterableEventQueue.ts';
import { transaction } from '../resources/transaction.ts';
import { Headers, mergeHeaders } from '../server/serverHelpers/Headers.ts';
import { generateJsonApi } from '../resources/openApi.ts';
import { SimpleURLQuery } from '../resources/search.ts';
import type { Context } from '../resources/ResourceInterface.ts';
import { Request } from '../server/serverHelpers/Request.ts';
interface Response {
	status?: number;
	headers?: any;
	data?: any;
	body?: any;
}
const etagBytes = new Uint8Array(8);
const etagFloat = new Float64Array(etagBytes.buffer, 0, 1);
let httpOptions = {};

const OPENAPI_DOMAIN = 'openapi';

async function http(request: Context & Request, nextHandler) {
	const headersObject = request.headers.asObject;
	const isSse = headersObject.accept === 'text/event-stream';
	const method = isSse ? 'CONNECT' : request.method;
	if (request.search) parseQuery(request);
	const headers = new Headers();
	try {
		request.responseHeaders = headers;
		const url = request.url.slice(1);

		let resourceRequest;
		let resource: typeof Resource;
		if (url !== OPENAPI_DOMAIN) {
			const entry = resources.getMatch(url, isSse ? 'sse' : 'rest');
			if (!entry) return nextHandler(request); // no resource handler found
			request.handlerPath = entry.path;
			resourceRequest = new SimpleURLQuery(entry.relativeURL); // TODO: We don't want to have to remove the forward slash and then re-add it
			resourceRequest.async = true;
			resource = entry.Resource;
		}
		if (resource?.isCaching) {
			const cacheControl = headersObject['cache-control'];
			if (cacheControl) {
				const cacheControlParts = parseHeaderValue(cacheControl);
				for (const part of cacheControlParts) {
					switch (part.name) {
						case 'max-age':
							request.expiresAt = part.value * 1000 + Date.now();
							break;
						case 'only-if-cached':
							request.onlyIfCached = true;
							break;
						case 'no-cache':
							request.noCache = true;
							break;
						case 'no-store':
							request.noCacheStore = true;
							break;
						case 'stale-if-error':
							request.staleIfError = true;
							break;
						case 'must-revalidate':
							request.mustRevalidate = true;
							break;
					}
				}
			}
		}
		const replicateTo = headersObject['x-replicate-to'];
		if (replicateTo) {
			const parsed = parseHeaderValue(replicateTo).map((node: { name: string }) => {
				// we can use a component argument to indicate that number that should be confirmed
				// for example, to replicate to three nodes and wait for confirmation from two: X-Replicate-To: 3;confirm=2
				// or to specify nodes with confirm: X-Replicate-To: node-1, node-2, node-3;confirm=2
				if (node.next?.name === 'confirm' && node.next.value >= 0) {
					request.replicatedConfirmation = +node.next.value;
				}
				return node.name;
			});
			request.replicateTo =
				parsed.length === 1 && +parsed[0] >= 0 ? +parsed[0] : parsed[0] === '*' ? undefined : parsed;
		}
		const replicateFrom = headersObject['x-replicate-from'];
		if (replicateFrom === 'none') {
			request.replicateFrom = false;
		}
		let responseData = await transaction(request, () => {
			if (headersObject['content-length'] || headersObject['transfer-encoding']) {
				// TODO: Support cancellation (if the request otherwise fails or takes too many bytes)
				try {
					request.data = getDeserializer(headersObject['content-type'], true)(request.body, request.headers);
				} catch (error) {
					throw new ClientError(error, 400);
				}
			}
			request.authorize = true;

			if (url === OPENAPI_DOMAIN && method === 'GET') {
				if (request?.user?.role?.permission?.super_user) {
					return generateJsonApi(resources);
				} else {
					throw new ServerError(`Forbidden`, 403);
				}
			}

			switch (method) {
				case 'GET':
				case 'HEAD':
					return resource.get(resourceRequest, request);
				case 'POST':
					return resource.post(resourceRequest, request.data, request);
				case 'PUT':
					return resource.put(resourceRequest, request.data, request);
				case 'DELETE':
					return resource.delete(resourceRequest, request);
				case 'PATCH':
					return resource.patch(resourceRequest, request.data, request);
				case 'OPTIONS': // used primarily for CORS
					headers.setIfNone('Allow', 'GET, HEAD, POST, PUT, DELETE, PATCH, OPTIONS, TRACE, QUERY, COPY, MOVE');
					return;
				case 'CONNECT':
					// websockets? and event-stream
					return resource.connect(resourceRequest, null, request);
				case 'TRACE':
					return 'HarperDB is the terminating server';
				case 'QUERY':
					return resource.query(resourceRequest, request.data, request);
				case 'COPY': // methods suggested from webdav RFC 4918
					return resource.copy(resourceRequest, headersObject.destination, request);
				case 'MOVE':
					return resource.move(resourceRequest, headersObject.destination, request);
				case 'BREW': // RFC 2324
					throw new ClientError("HarperDB is short and stout and can't brew coffee", 418);
				default:
					throw new ServerError(`Method ${method} is not recognized`, 501);
			}
		});
		let status = 200;
		let lastModification;
		if (responseData == undefined) {
			status = method === 'GET' || method === 'HEAD' ? 404 : 204;
			// deleted entries can have a timestamp of when they were deleted
			if (httpOptions.lastModified && request.lastModified)
				headers.setIfNone('Last-Modified', new Date(request.lastModified).toUTCString());
		} else if (responseData.status > 0 && responseData.headers) {
			// if response is a Response object, use it as the response
			// merge headers from response
			const responseHeaders = mergeHeaders(responseData.headers, headers);
			if (responseData.headers !== responseHeaders)
				// if we rebuilt the headers, reassign it, but we don't want to assign to a Response object (which should already
				// have a valid Headers object) or it will throw an error
				responseData.headers = responseHeaders;
			// if data is provided, serialize it
			if (responseData.data !== undefined) responseData.body = serialize(responseData.data, request, responseData);
			return responseData;
		} else if ((lastModification = request.lastModified)) {
			etagFloat[0] = lastModification;
			// base64 encoding of the 64-bit float encoding of the date in ms (with quotes)
			// very fast and efficient
			const etag = String.fromCharCode(
				34,
				(etagBytes[0] & 0x3f) + 62,
				(etagBytes[0] >> 6) + ((etagBytes[1] << 2) & 0x3f) + 62,
				(etagBytes[1] >> 4) + ((etagBytes[2] << 4) & 0x3f) + 62,
				(etagBytes[2] >> 2) + 62,
				(etagBytes[3] & 0x3f) + 62,
				(etagBytes[3] >> 6) + ((etagBytes[4] << 2) & 0x3f) + 62,
				(etagBytes[4] >> 4) + ((etagBytes[5] << 4) & 0x3f) + 62,
				(etagBytes[5] >> 2) + 62,
				(etagBytes[6] & 0x3f) + 62,
				(etagBytes[6] >> 6) + ((etagBytes[7] << 2) & 0x3f) + 62,
				34
			);
			const lastEtag = headersObject['if-none-match'];
			if (lastEtag && etag == lastEtag) {
				if (responseData?.onDone) responseData.onDone();
				status = 304;
				responseData = undefined;
			} else {
				headers.setIfNone('ETag', etag);
			}
			if (httpOptions.lastModified) headers.setIfNone('Last-Modified', new Date(lastModification).toUTCString());
		}
		if (request.createdResource) status = 201;
		if (request.newLocation) headers.setIfNone('Location', request.newLocation);

		const responseObject = {
			status,
			headers,
			body: undefined,
		};
		const loadedFromSource = request.loadedFromSource ?? responseData?.wasLoadedFromSource?.();
		if (loadedFromSource !== undefined) {
			// this appears to be a caching table with a source
			responseObject.wasCacheMiss = loadedFromSource; // indicate if it was a missed cache
			if (!loadedFromSource && lastModification) {
				headers.setIfNone('Age', Math.round((Date.now() - (request.lastRefreshed || lastModification)) / 1000));
			}
		}
		// TODO: Handle 201 Created
		if (responseData !== undefined) {
			responseObject.body = serialize(responseData, request, responseObject);
			if (method === 'HEAD') responseObject.body = undefined; // we want everything else to be the same as GET, but then omit the body
		}
		return responseObject;
	} catch (error) {
		if (error.statusCode) {
			if (error.statusCode === 500) harperLogger.warn(error);
			else harperLogger.info(error);
		} else harperLogger.error(error);
		if (error.statusCode === 405) {
			if (error.method) error.message += ` to handle HTTP method ${error.method.toUpperCase() || ''}`;
			if (error.allow) {
				error.allow.push('trace', 'head', 'options');
				headers.setIfNone('Allow', error.allow.map((method) => method.toUpperCase()).join(', '));
			}
		}
		const responseObject = {
			status: error.statusCode || 500, // use specified error status, or default to generic server error
			headers,
			body: undefined,
		};
		responseObject.body = serialize(error.contentType ? error : error.toString(), request, responseObject);
		return responseObject;
	}
}

let started;
let resources: Resources;
let addedMetrics;
let connectionCount = 0;

export function start(options: ServerOptions & { path: string; port: number; server: any; resources: any }) {
	httpOptions = options;
	if (started) return;
	started = true;
	if (options.includeExpensiveRecordCountEstimates) {
		// If they really want to enable expensive record count estimates
		Request.prototype.includeExpensiveRecordCountEstimates = true;
	}
	resources = options.resources;
	options.server.http(async (request: Request, nextHandler) => {
		if (request.isWebSocket) return;
		return http(request, nextHandler);
	}, options);
	if (options.webSocket === false) return;
	options.server.ws(async (ws, request, chainCompletion) => {
		connectionCount++;
		const incomingMessages = new IterableEventQueue();
		if (!addedMetrics) {
			addedMetrics = true;
			addAnalyticsListener((metrics) => {
				if (connectionCount > 0)
					metrics.push({
						metric: 'ws-connections',
						connections: connectionCount,
						byThread: true,
					});
			});
		}
		// TODO: We should set a lower keep-alive ws.socket.setKeepAlive(600000);
		let hasError;
		ws.on('error', (error) => {
			hasError = true;
			harperLogger.warn(error);
		});
		let deserializer;
		ws.on('message', function message(body) {
			if (!deserializer)
				deserializer = getDeserializer(request.requestedContentType ?? request.headers.asObject['content-type'], false);
			const data = deserializer(body);
			recordAction(body.length, 'bytes-received', request.handlerPath, 'message', 'ws');
			incomingMessages.push(data);
		});
		let iterator;
		ws.on('close', () => {
			connectionCount--;
			recordActionBinary(!hasError, 'connection', 'ws', 'disconnect');
			incomingMessages.emit('close');
			if (iterator) iterator.return();
		});
		try {
			await chainCompletion;
			const url = request.url.slice(1);
			const entry = resources.getMatch(url, 'ws');
			recordActionBinary(Boolean(entry), 'connection', 'ws', 'connect');
			if (!entry) {
				// TODO: Ideally we would like to have a 404 response before upgrading to WebSocket protocol, probably
				return ws.close(1011, `No resource was found to handle ${request.pathname}`);
			} else {
				request.handlerPath = entry.path;
				recordAction(
					(action) => ({
						count: action.count,
						total: connectionCount,
					}),
					'connections',
					request.handlerPath,
					'connect',
					'ws'
				);
				request.authorize = true;
				const resourceRequest = new SimpleURLQuery(entry.relativeURL); // TODO: We don't want to have to remove the forward slash and then re-add it
				const resource = entry.Resource;
				const responseStream = await transaction(request, () => {
					return resource.connect(resourceRequest, incomingMessages, request);
				});
				iterator = responseStream[Symbol.asyncIterator]();

				let result;
				while (!(result = await iterator.next()).done) {
					const messageBinary = await serializeMessage(result.value, request);
					ws.send(messageBinary);
					recordAction(messageBinary.length, 'bytes-sent', request.handlerPath, 'message', 'ws');
					if (ws._socket.writableNeedDrain) {
						await new Promise((resolve) => ws._socket.once('drain', resolve));
					}
				}
			}
		} catch (error) {
			if (error.statusCode) {
				if (error.statusCode === 500) harperLogger.warn(error);
				else harperLogger.info(error);
			} else harperLogger.error(error);
			ws.close(
				HTTP_TO_WEBSOCKET_CLOSE_CODES[error.statusCode] || // try to return a helpful code
					1011, // otherwise generic internal error
				error.toString()
			);
		}
		ws.close();
	}, options);
}
const HTTP_TO_WEBSOCKET_CLOSE_CODES = {
	401: 3000,
	403: 3003,
};

/**
 * This parser is used to parse header values.
 *
 * It is used within this file for parsing the `Cache-Control` and `X-Replicate-To` headers.
 *
 * @param value
 */
export function parseHeaderValue(value: string) {
	return value
		.trim()
		.split(',')
		.map((part) => {
			let parsed;
			const components = part.trim().split(';');
			let component;
			while ((component = components.pop())) {
				if (component.includes('=')) {
					let [name, value] = component.trim().split('=');
					name = name.trim();
					if (value) value = value.trim();
					parsed = {
						name: name.toLowerCase(),
						value,
						next: parsed,
					};
				} else {
					parsed = {
						name: component.toLowerCase(),
						next: parsed,
					};
				}
			}
			return parsed;
		});
}
