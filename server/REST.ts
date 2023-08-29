import { serialize, serializeMessage, getDeserializer } from '../server/serverHelpers/contentTypes';
import { recordAction, recordActionBinary } from '../resources/analytics';
import { ServerOptions } from 'http';
import { ServerError, ClientError } from '../utility/errors/hdbError';
import { Resources } from '../resources/Resources';
import { parseQuery } from '../resources/search';
import { IterableEventQueue } from '../resources/IterableEventQueue';
import { transaction } from '../resources/transaction';

interface Response {
	status?: number;
	headers?: any;
	data?: any;
	body?: any;
}
const etag_bytes = new Uint8Array(8);
const etag_float = new Float64Array(etag_bytes.buffer, 0, 1);

async function http(request, next_handler) {
	const method = request.headers.accept === 'text/event-stream' ? 'CONNECT' : request.method;
	if (request.search) parseQuery(request);
	const start = performance.now();
	let resource_path;
	try {
		const headers = new Headers();
		request.responseHeaders = headers;
		const url = request.url.slice(1);
		const entry = resources.getMatch(url);
		if (!entry) return next_handler(request); // no resource handler found
		const resource_request = { url: entry.relativeURL }; // TODO: We don't want to have to remove the forward slash and then re-add it
		const resource = entry.Resource;
		let response_data = await transaction(request, () => {
			if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'QUERY') {
				// TODO: Support cancelation (if the request otherwise fails or takes too many bytes)
				try {
					request.data = getDeserializer(request.headers['content-type'], true)(request.body);
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
					headers.Allow = 'GET, HEAD, POST, PUT, DELETE, PATCH, OPTIONS, TRACe, QUERY, COPY, MOVE';
					return;
				case 'CONNECT':
					// websockets? and event-stream
					return resource.connect(resource_request, request);
				case 'TRACE':
					return 'HarperDB is the terminating server';
				case 'QUERY':
					return resource.query(resource_request, request.data, request);
				case 'COPY': // methods suggested from webdav RFC 4918
					return resource.copy(resource_request, request.headers.destination, request);
				case 'MOVE':
					return resource.move(resource_request, request.headers.destination, request);
				case 'BREW': // RFC 2324
					throw new ClientError("HarperDB is short and stout and can't brew coffee", 418);
				default:
					throw new ServerError(`Method ${method} is not recognized`, 501);
			}
		});
		const execution_time = performance.now() - start;
		let status = 200;
		let last_modification;
		if (response_data == undefined) {
			status = method === 'GET' || method === 'HEAD' ? 404 : 204;
		} else if ((last_modification = request?.lastModified)) {
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
			const last_etag = request.headers['if-none-match'];
			if (last_etag && etag == last_etag) {
				if (response_data?.onDone) response_data.onDone();
				status = 304;
				response_data = undefined;
			} else {
				headers['ETag'] = etag;
			}
		}
		if (request.createdResource) status = 201;
		if (request.newLocation) headers.Location = request.newLocation;

		const response_object = {
			status,
			headers,
			body: undefined,
		};
		const user_timings = headers['Server-Timing'];
		headers['Server-Timing'] = `${user_timings ? user_timings + ', ' : ''}db;dur=${execution_time.toFixed(2)}`;
		if (response_data?.wasLoadedFromSource?.()) {
			headers['Server-Timing'] += ', miss';
		}
		recordAction(execution_time, 'TTFB', resource_path, method);
		recordActionBinary(status < 400, 'success', resource_path, method);
		// TODO: Handle 201 Created

		if (response_data !== undefined) {
			response_object.body = serialize(response_data, request, response_object);
			if (method === 'HEAD') response_object.body = undefined; // we want everything else to be the same as GET, but then omit the body
		}
		return response_object;
	} catch (error) {
		const execution_time = performance.now() - start;
		recordAction(execution_time, 'TTFB', resource_path, method);
		recordActionBinary(false, 'success', resource_path, method);
		if (!error.http_resp_code) console.error(error);
		const headers = {};
		if (error.http_resp_code === 405) {
			if (error.method) error.message += ` to handle HTTP method ${error.method.toUpperCase() || ''}`;
			if (error.allow) {
				error.allow.push('trace', 'head', 'options');
				headers.Allow = error.allow.map((method) => method.toUpperCase()).join(', ');
			}
		}
		return {
			status: error.http_resp_code || 500, // use specified error status, or default to generic server error
			headers,
			body: serializeMessage(error.toString(), request),
		};
	}
}

function checkAllowed(method_allowed, user, resource): void | Promise<void> {
	const allowed = method_allowed ?? resource.allowAccess?.() ?? user?.role.permission.super_user; // default permission check
	if (allowed?.then) {
		// handle promises, waiting for them using fast path (not await)
		return allowed.then(() => {
			if (!allowed) checkAllowed(false, user, resource);
		});
	} else if (!allowed) {
		let error;
		if (user) {
			error = new Error('Unauthorized access to resource');
			error.status = 403;
		} else {
			error = new Error('Must login');
			error.status = 401;
			// TODO: Optionally allow a Location header to redirect to
		}
		throw error;
	}
}

let started;
let resources: Resources;

let connection_count = 0;
let printing_connection_count;

export function start(options: ServerOptions & { path: string; port: number; server: any; resources: any }) {
	if (started) return;
	started = true;
	resources = options.resources;
	options.server.http(async (request: Request, next_handler) => {
		if (request.isWebSocket) return;
		return http(request, next_handler);
	});
	options.server.ws(async (ws, request, chain_completion) => {
		connection_count++;
		if (!printing_connection_count) {
			setTimeout(() => {
				console.log('connection count', connection_count, 'mem', Math.round(process.memoryUsage().heapUsed / 1000000));
				printing_connection_count = false;
			}, 1000);
			printing_connection_count = true;
		}
		startRequest(request);
		const incoming_messages = new IterableEventQueue();
		// TODO: We should set a lower keep-alive ws.socket.setKeepAlive(600000);
		ws.on('error', console.error);
		let deserializer;
		ws.on('message', function message(body) {
			if (!deserializer) deserializer = getDeserializer(request.headers['content-type']);
			const data = deserializer(body);
			incoming_messages.push(data);
		});
		let iterator;
		ws.on('close', () => {
			//connection_count--
			incoming_messages.emit('close');
			if (iterator) iterator.return();
		});
		await chain_completion;
		let resource_found;
		const response_stream = await resources.call(request.pathname.slice(1), request, (resource, path) => {
			resource_found = true;
			return resource.connect(incoming_messages);
		});
		if (!resource_found) {
			ws.send(serializeMessage(`No resource was found to handle ${request.pathname}`, request));
		} else {
			iterator = response_stream[Symbol.asyncIterator]();

			let result;
			while (!(result = await iterator.next()).done) {
				ws.send(serializeMessage(result.value, request));
			}
		}
		ws.close();
	});

	function startRequest(request) {
		// TODO: check rate limiting here?
		const path = request.pathname;
		const dot_index = path.lastIndexOf('.');
		if (dot_index > -1) {
			// we can use .extensions to force the Accept header
			const ext = path.slice(dot_index + 1);
			const accept = EXTENSION_TYPES[ext];
			if (accept) request.headers.accept = accept;
		}
	}
}

class Headers {
	set(name, value) {
		this[name] = value;
	}
}
