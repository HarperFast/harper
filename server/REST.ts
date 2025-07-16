import { serialize, serializeMessage, getDeserializer } from '../server/serverHelpers/contentTypes';
import { addAnalyticsListener, recordAction, recordActionBinary } from '../resources/analytics';
import * as harper_logger from '../utility/logging/harper_logger';
import { ServerOptions } from 'http';
import { ServerError, ClientError } from '../utility/errors/hdbError';
import { Resources } from '../resources/Resources';
import { parseQuery } from '../resources/search';
import { IterableEventQueue } from '../resources/IterableEventQueue';
import { transaction } from '../resources/transaction';
import { Headers, mergeHeaders } from '../server/serverHelpers/Headers';
import { generateJsonApi } from '../resources/openApi';
import { SimpleURLQuery } from '../resources/search';
import { Context } from '../resources/ResourceInterface';
import { Request } from '../server/serverHelpers/Request';
interface Response {
	status?: number;
	headers?: any;
	data?: any;
	body?: any;
}
const etag_bytes = new Uint8Array(8);
const etag_float = new Float64Array(etag_bytes.buffer, 0, 1);
let http_options = {};

const OPENAPI_DOMAIN = 'openapi';

async function http(request: Context & Request, next_handler) {
	const headers_object = request.headers.asObject;
	const is_sse = headers_object.accept === 'text/event-stream';
	const method = is_sse ? 'CONNECT' : request.method;
	if (request.search) parseQuery(request);
	const headers = new Headers();
	try {
		request.responseHeaders = headers;
		const url = request.url.slice(1);

		let resource_request;
		let resource: typeof Resource;
		if (url !== OPENAPI_DOMAIN) {
			const entry = resources.getMatch(url, is_sse ? 'sse' : 'rest');
			if (!entry) return next_handler(request); // no resource handler found
			request.handlerPath = entry.path;
			resource_request = new SimpleURLQuery(entry.relativeURL); // TODO: We don't want to have to remove the forward slash and then re-add it
			resource_request.async = true;
			resource = entry.Resource;
		}
		if (resource?.isCaching) {
			const cache_control = headers_object['cache-control'];
			if (cache_control) {
				const cache_control_parts = parseHeaderValue(cache_control);
				for (const part of cache_control_parts) {
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
		const replicate_to = headers_object['x-replicate-to'];
		if (replicate_to) {
			const parsed = parseHeaderValue(replicate_to).map((node: { name: string }) => {
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
		const replicate_from = headers_object['x-replicate-from'];
		if (replicate_from === 'none') {
			request.replicateFrom = false;
		}
		let response_data = await transaction(request, () => {
			if (headers_object['content-length'] || headers_object['transfer-encoding']) {
				// TODO: Support cancellation (if the request otherwise fails or takes too many bytes)
				try {
					request.data = getDeserializer(headers_object['content-type'], true)(request.body, request.headers);
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
					return resource.get(resource_request, request);
				case 'POST':
					return resource.post(resource_request, request.data, request);
				case 'PUT':
					return resource.put(resource_request, request.data, request);
				case 'DELETE':
					return resource.delete(resource_request, request);
				case 'PATCH':
					return resource.patch(resource_request, request.data, request);
				case 'OPTIONS': // used primarily for CORS
					headers.setIfNone('Allow', 'GET, HEAD, POST, PUT, DELETE, PATCH, OPTIONS, TRACE, QUERY, COPY, MOVE');
					return;
				case 'CONNECT':
					// websockets? and event-stream
					return resource.connect(resource_request, null, request);
				case 'TRACE':
					return 'HarperDB is the terminating server';
				case 'QUERY':
					return resource.query(resource_request, request.data, request);
				case 'COPY': // methods suggested from webdav RFC 4918
					return resource.copy(resource_request, headers_object.destination, request);
				case 'MOVE':
					return resource.move(resource_request, headers_object.destination, request);
				case 'BREW': // RFC 2324
					throw new ClientError("HarperDB is short and stout and can't brew coffee", 418);
				default:
					throw new ServerError(`Method ${method} is not recognized`, 501);
			}
		});
		let status = 200;
		let last_modification;
		if (response_data == undefined) {
			status = method === 'GET' || method === 'HEAD' ? 404 : 204;
			// deleted entries can have a timestamp of when they were deleted
			if (http_options.lastModified && request.lastModified)
				headers.setIfNone('Last-Modified', new Date(request.lastModified).toUTCString());
		} else if (response_data.status > 0 && response_data.headers) {
			// if response is a Response object, use it as the response
			// merge headers from response
			const response_headers = mergeHeaders(response_data.headers, headers);
			if (response_data.headers !== response_headers)
				// if we rebuilt the headers, reassign it, but we don't want to assign to a Response object (which should already
				// have a valid Headers object) or it will throw an error
				response_data.headers = response_headers;
			// if data is provided, serialize it
			if (response_data.data !== undefined) response_data.body = serialize(response_data.data, request, response_data);
			return response_data;
		} else if ((last_modification = request.lastModified)) {
			etag_float[0] = last_modification;
			// base64 encoding of the 64-bit float encoding of the date in ms (with quotes)
			// very fast and efficient
			const etag = String.fromCharCode(
				34,
				(etag_bytes[0] & 0x3f) + 62,
				(etag_bytes[0] >> 6) + ((etag_bytes[1] << 2) & 0x3f) + 62,
				(etag_bytes[1] >> 4) + ((etag_bytes[2] << 4) & 0x3f) + 62,
				(etag_bytes[2] >> 2) + 62,
				(etag_bytes[3] & 0x3f) + 62,
				(etag_bytes[3] >> 6) + ((etag_bytes[4] << 2) & 0x3f) + 62,
				(etag_bytes[4] >> 4) + ((etag_bytes[5] << 4) & 0x3f) + 62,
				(etag_bytes[5] >> 2) + 62,
				(etag_bytes[6] & 0x3f) + 62,
				(etag_bytes[6] >> 6) + ((etag_bytes[7] << 2) & 0x3f) + 62,
				34
			);
			const last_etag = headers_object['if-none-match'];
			if (last_etag && etag == last_etag) {
				if (response_data?.onDone) response_data.onDone();
				status = 304;
				response_data = undefined;
			} else {
				headers.setIfNone('ETag', etag);
			}
			if (http_options.lastModified) headers.setIfNone('Last-Modified', new Date(last_modification).toUTCString());
		}
		if (request.createdResource) status = 201;
		if (request.newLocation) headers.setIfNone('Location', request.newLocation);

		const response_object = {
			status,
			headers,
			body: undefined,
		};
		const loaded_from_source = response_data?.wasLoadedFromSource?.();
		if (loaded_from_source !== undefined) {
			// this appears to be a caching table with a source
			response_object.wasCacheMiss = loaded_from_source; // indicate if it was a missed cache
			if (!loaded_from_source && last_modification) {
				headers.setIfNone('Age', Math.round((Date.now() - (request.lastRefreshed || last_modification)) / 1000));
			}
		}
		// TODO: Handle 201 Created
		if (response_data !== undefined) {
			response_object.body = serialize(response_data, request, response_object);
			if (method === 'HEAD') response_object.body = undefined; // we want everything else to be the same as GET, but then omit the body
		}
		return response_object;
	} catch (error) {
		if (error.statusCode) {
			if (error.statusCode === 500) harper_logger.warn(error);
			else harper_logger.info(error);
		} else harper_logger.error(error);
		if (error.statusCode === 405) {
			if (error.method) error.message += ` to handle HTTP method ${error.method.toUpperCase() || ''}`;
			if (error.allow) {
				error.allow.push('trace', 'head', 'options');
				headers.setIfNone('Allow', error.allow.map((method) => method.toUpperCase()).join(', '));
			}
		}
		const response_object = {
			status: error.statusCode || 500, // use specified error status, or default to generic server error
			headers,
			body: undefined,
		};
		response_object.body = serialize(error.contentType ? error : error.toString(), request, response_object);
		return response_object;
	}
}

let started;
let resources: Resources;
let added_metrics;
let connection_count = 0;

export function start(options: ServerOptions & { path: string; port: number; server: any; resources: any }) {
	http_options = options;
	if (options.includeExpensiveRecordCountEstimates) {
		// If they really want to enable expensive record count estimates
		Request.prototype.includeExpensiveRecordCountEstimates = true;
	}
	if (started) return;
	started = true;
	resources = options.resources;
	options.server.http(async (request: Request, next_handler) => {
		if (request.isWebSocket) return;
		return http(request, next_handler);
	}, options);
	if (options.webSocket === false) return;
	options.server.ws(async (ws, request, chain_completion) => {
		connection_count++;
		const incoming_messages = new IterableEventQueue();
		if (!added_metrics) {
			added_metrics = true;
			addAnalyticsListener((metrics) => {
				if (connection_count > 0)
					metrics.push({
						metric: 'ws-connections',
						connections: connection_count,
						byThread: true,
					});
			});
		}
		// TODO: We should set a lower keep-alive ws.socket.setKeepAlive(600000);
		let has_error;
		ws.on('error', (error) => {
			has_error = true;
			harper_logger.warn(error);
		});
		let deserializer;
		ws.on('message', function message(body) {
			if (!deserializer)
				deserializer = getDeserializer(request.requestedContentType ?? request.headers.asObject['content-type'], false);
			const data = deserializer(body);
			recordAction(body.length, 'bytes-received', request.handlerPath, 'message', 'ws');
			incoming_messages.push(data);
		});
		let iterator;
		ws.on('close', () => {
			connection_count--;
			recordActionBinary(!has_error, 'connection', 'ws', 'disconnect');
			incoming_messages.emit('close');
			if (iterator) iterator.return();
		});
		try {
			await chain_completion;
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
						total: connection_count,
					}),
					'connections',
					request.handlerPath,
					'connect',
					'ws'
				);
				request.authorize = true;
				const resource_request = new SimpleURLQuery(entry.relativeURL); // TODO: We don't want to have to remove the forward slash and then re-add it
				const resource = entry.Resource;
				const response_stream = await transaction(request, () => {
					return resource.connect(resource_request, incoming_messages, request);
				});
				iterator = response_stream[Symbol.asyncIterator]();

				let result;
				while (!(result = await iterator.next()).done) {
					const message_binary = await serializeMessage(result.value, request);
					ws.send(message_binary);
					recordAction(message_binary.length, 'bytes-sent', request.handlerPath, 'message', 'ws');
					if (ws._socket.writableNeedDrain) {
						await new Promise((resolve) => ws._socket.once('drain', resolve));
					}
				}
			}
		} catch (error) {
			if (error.statusCode) {
				if (error.statusCode === 500) harper_logger.warn(error);
				else harper_logger.info(error);
			} else harper_logger.error(error);
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
