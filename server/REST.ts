import { serialize, serializeMessage, getDeserializer } from '../server/serverHelpers/contentTypes';
import { addAnalyticsListener, recordAction, recordActionBinary } from '../resources/analytics';
import * as harper_logger from '../utility/logging/harper_logger';
import { ServerOptions } from 'http';
import { ServerError, ClientError } from '../utility/errors/hdbError';
import { Resources } from '../resources/Resources';
import { parseQuery } from '../resources/search';
import { IterableEventQueue } from '../resources/IterableEventQueue';
import { transaction } from '../resources/transaction';
import { Headers } from '../server/serverHelpers/Headers';

interface Response {
	status?: number;
	headers?: any;
	data?: any;
	body?: any;
}
const etag_bytes = new Uint8Array(8);
const etag_float = new Float64Array(etag_bytes.buffer, 0, 1);
let http_options = {};

async function http(request, next_handler) {
	const headers_object = request.headers.asObject;
	const method = headers_object.accept === 'text/event-stream' ? 'CONNECT' : request.method;
	if (request.search) parseQuery(request);
	const headers = new Headers();
	try {
		request.responseHeaders = headers;
		const url = request.url.slice(1);
		const entry = resources.getMatch(url);
		if (!entry) return next_handler(request); // no resource handler found
		request.handlerPath = entry.path;
		const resource_request = { url: entry.relativeURL, async: true }; // TODO: We don't want to have to remove the forward slash and then re-add it
		const resource = entry.Resource;
		let cache_control = headers_object['cache-control'];
		if (cache_control) {
			cache_control = cache_control.toLowerCase();
			const max_age = cache_control.match(/max-age=(\d+)/)?.[1];
			if (max_age) request.expiresAt = max_age * 1000 + Date.now();
			if (cache_control.includes('only-if-cached')) request.onlyIfCached = true;
			if (cache_control.includes('no-cache')) request.noCache = true;
			if (cache_control.includes('no-store')) request.noCacheStore = true;
			if (cache_control.includes('stale-if-error')) request.staleIfError = true;
			if (cache_control.includes('must-revalidate')) request.mustRevalidate = true;
		}
		let response_data = await transaction(request, () => {
			if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'QUERY') {
				// TODO: Support cancellation (if the request otherwise fails or takes too many bytes)
				try {
					request.data = getDeserializer(headers_object['content-type'], true)(request.body);
				} catch (error) {
					throw new ClientError(error, 400);
				}
			}
			request.authorize = true;

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
	if (started) return;
	started = true;
	resources = options.resources;
	options.server.http(async (request: Request, next_handler) => {
		if (request.isWebSocket) return;
		return http(request, next_handler);
	});
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
			if (!deserializer) deserializer = getDeserializer(request.headers.asObject['content-type']);
			const data = deserializer(body);
			incoming_messages.push(data);
		});
		let iterator;
		ws.on('close', () => {
			connection_count--;
			recordActionBinary(!has_error, 'connection', 'ws', 'disconnect');
			incoming_messages.emit('close');
			if (iterator) iterator.return();
		});
		await chain_completion;
		const url = request.url.slice(1);
		const entry = resources.getMatch(url);
		recordActionBinary(Boolean(entry), 'connection', 'ws', 'connect');
		if (!entry) {
			ws.send(serializeMessage(`No resource was found to handle ${request.pathname}`, request));
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

			const resource_request = { url: entry.relativeURL, async: true }; // TODO: We don't want to have to remove the forward slash and then re-add it
			const resource = entry.Resource;
			const response_stream = await transaction(request, () => {
				return resource.connect(resource_request, incoming_messages, request);
			});
			iterator = response_stream[Symbol.asyncIterator]();

			let result;
			while (!(result = await iterator.next()).done) {
				const message_binary = serializeMessage(result.value, request);
				ws.send(message_binary);
				recordAction(message_binary.length, 'bytes-sent', request.handlerPath, 'message', 'ws');
			}
		}
		ws.close();
	});
}
