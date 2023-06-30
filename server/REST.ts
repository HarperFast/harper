import { serialize, serializeMessage, getDeserializer } from '../server/serverHelpers/contentTypes';
import { recordAction, recordActionBinary } from '../resources/analytics';
import { ServerOptions } from 'http';
import { ServerError, ClientError } from '../utility/errors/hdbError';
import { Resources } from '../resources/Resources';
import { LAST_MODIFICATION_PROPERTY } from '../resources/Resource';
import { IterableEventQueue } from '../resources/IterableEventQueue';

interface Response {
	status?: number;
	headers?: any;
	data?: any;
	body?: any;
}

async function http(request, next_handler) {
	const method = request.method;
	const start = performance.now();
	let resource_path;
	try {
		const headers = {};
		let resource;
		let response_data = await resources.call(request.pathname.slice(1), request, (resource, path) => {
			resource_path = path;
			if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'QUERY') {
				// TODO: Support cancelation (if the request otherwise fails or takes too many bytes)
				try {
					request.data = getDeserializer(request.headers['content-type'], true)(request.body);
				} catch (error) {
					throw new ClientError(error, 400);
				}
			}

			switch (method) {
				case 'GET':
				case 'HEAD':
					return resource.get(request);
				case 'POST':
					return resource.post(request);
				case 'PUT':
					return resource.put(request);
				case 'DELETE':
					return resource.delete(request);
				case 'PATCH':
					return resource.patch(request);
				case 'OPTIONS': // used primarily for CORS
					headers.Allow = 'GET, HEAD, POST, PUT, DELETE, PATCH, OPTIONS, TRACe, QUERY, COPY, MOVE';
					return;
				case 'CONNECT':
					// websockets? and event-stream
					return resource.connect(request);
				case 'TRACE':
					return 'HarperDB is the terminating server';
				case 'QUERY':
					return resource.query(request);
				case 'COPY': // methods suggested from webdav RFC 4918
					return resource.copy(request.headers.destination);
				case 'MOVE':
					return resource.move(request.headers.destination);
				default:
					throw new ServerError('Method not available', 501);
			}
		});
		if (resource_path === undefined) return next_handler(request); // no resource handler found
		const execution_time = performance.now() - start;
		let status = 200;
		let lastModification;
		if (response_data == undefined) {
			status = method === 'GET' || method === 'HEAD' ? 404 : 204;
		} else if ((lastModification = resource[LAST_MODIFICATION_PROPERTY])) {
			const if_match = request.headers['if-match'];
			if (if_match && (lastModification * 1000).toString(36) == if_match) {
				//resource_result.cancel();
				status = 304;
				response_data = undefined;
			} else {
				headers['ETag'] = (lastModification * 1000).toString(36);
				headers['Last-Modified'] = new Date(lastModification).toUTCString();
			}
		}
		const response_object = {
			status,
			headers,
			body: undefined,
		};
		headers['Server-Timing'] = `db;dur=${execution_time.toFixed(2)}`;
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
		return {
			status: error.http_resp_code || 500, // use specified error status, or default to generic server error
			headers: {},
			body: serializeMessage(error.toString(), request),
		};
	}
}

let message_count = 0;

async function wsMessage(Resource, resource_path, path, data, request, ws) {
	const method = data.method?.toUpperCase() || 'GET-SUB';
	const request_data = data.body;
	const request_id = data.id;
	try {
		const response = await execute(Resource, method, path, request_data, request, ws);
		const subscription = response.data;
		subscription.listener = () => {
			if (!message_count) {
				setTimeout(() => {
					console.log(
						'message count (in last 10 seconds)',
						message_count,
						'connection_count',
						connection_count,
						'mem',
						Math.round(process.memoryUsage().heapUsed / 1000000)
					);
					message_count = 0;
				}, 10000);
			}
			message_count++;
			ws.send(
				serializeMessage(
					{
						path,
						updated: true,
					},
					request
				)
			);
		};
		ws.on('close', () => subscription.end());
		//response_data.id = request_id;
		response.id = request_id;
		ws.send(serializeMessage(response, request));
	} catch (error) {
		// do content negotiation
		console.error(error);
		ws.send(serializeMessage({ status: 500, id: request_id, data: error.toString() }, request));
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
		startRequest(request);
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
		if (request.headers.accept === 'text/event-stream') {
			request.method = 'CONNECT';
		}
	}
}

const EXTENSION_TYPES = {
	json: 'application/json',
	cbor: 'application/cbor',
	msgpack: 'application/x-msgpack',
	csv: 'text/csv',
};
