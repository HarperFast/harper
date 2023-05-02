import { serialize, serializeMessage, getDeserializer } from '../server/serverHelpers/contentTypes';
import { recordAction } from '../resources/analytics';
import { ServerOptions } from 'http';
import { ServerError, ClientError } from '../utility/errors/hdbError';
import { Resources } from '../resources/Resources';
import { IterableEventQueue } from '../resources/IterableEventQueue';

interface Response {
	status?: number;
	headers?: any;
	data?: any;
	body?: any;
}

async function http(resource, resource_path, next_path, request) {
	const method = request.method;
	const start = performance.now();
	try {
		try {
			if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
				// TODO: Support convert to async iterator in some cases?
				// TODO: Support cancelation (if the request otherwise fails or takes too many bytes)
				request.data = new Promise((resolve, reject) => {
					const buffers = [];
					request.body.on('data', (data) => buffers.push(data));
					request.body.on('end', () => resolve(Buffer.concat(buffers)));
					request.body.on('error', reject);
				}).then((body) => {
					try {
						return getDeserializer(request.headers['content-type'], body)(body);
					} catch (error) {
						throw new ClientError(error, 400);
					}
				});
			}
		} catch (error) {
			// TODO: Convert to HDBError
			error.status = 400;
			throw error;
		}

		const updated_resource = await resource.accessInTransaction(request, (resource_access) => {
			switch (method) {
				case 'GET':
					return resource_access.get();
				case 'POST':
					return resource_access.post(request.data);
				case 'PUT':
					return resource_access.put(request.data);
				case 'DELETE':
					return resource_access.delete();
				case 'PATCH':
					return resource_access.patch(request.data);
				case 'HEAD':
					resource_access.patch(request.data);
					return;
				case 'OPTIONS':
					return; // used primarily for CORS, could return all methods
				case 'CONNECT':
					// websockets? and event-stream
					return resource_access.connect();
				default:
					throw new ServerError('Method not available', 501);
			}
		});
		let response_data = updated_resource.result;
		//= await execute(Resource, method, next_path, request_data, request);
		const if_match = request.headers['if-match'];
		let status = 200;
		if (if_match && (updated_resource.lastModificationTime * 1000).toString(36) == if_match) {
			//resource_result.cancel();
			status = 304;
			response_data = undefined;
		}

		const headers = {};
		if (updated_resource.lastModificationTime) {
			headers['ETag'] = (updated_resource.lastModificationTime * 1000).toString(36);
			headers['Last-Modified'] = new Date(updated_resource.lastModificationTime).toUTCString();
		}
		const execution_time = performance.now() - start;
		headers['Server-Timing'] = `db;dur=${execution_time.toFixed(2)}`;
		recordAction(resource_path, execution_time);
		const response_object = {
			status,
			headers,
			body: undefined,
		};
		// TODO: Handle 201 Created

		if (response_data === undefined) {
			if (response_object.status === 200) response_object.status = updated_resource.updated ? 204 : 404;
		} else {
			response_object.body = serialize(response_data, request, response_object);
		}
		return response_object;
	} catch (error) {
		const execution_time = performance.now() - start;
		recordAction(resource_path, execution_time);
		if (!error.http_resp_code) console.error(error);
		// TODO: do content negotiation on the error
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
		const resource = resources.getResource(request.pathname.slice(1), { request });
		if (resource) {
			return http(resource, resource.path, resource.remainingPath, request);
		}
		return next_handler(request);
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
		const resource = resources.getResource(request.pathname.slice(1), { request });
		if (!resource) ws.send(serializeMessage(`No resource was found to handle ${request.pathname}`, request));
		const incoming_messages = new IterableEventQueue();
		// TODO: We should set a lower keep-alive ws.socket.setKeepAlive(600000);
		ws.on('error', console.error);
		let deserializer;
		ws.on('message', function message(body) {
			if (!deserializer) deserializer = getDeserializer(request.headers['content-type'], body);
			const data = deserializer(body);
			incoming_messages.emit('data', data);
		});
		let iterator;
		ws.on('close', () => {
			//connection_count--
			incoming_messages.emit('close');
			if (iterator) iterator.return();
		});
		await chain_completion;
		const updated_resource = await resource.accessInTransaction(request, (resource_access) => {
			const stream = resource_access.connect(incoming_messages);
			console.log({ stream });
			return stream;
		});
		iterator = updated_resource.result[Symbol.asyncIterator]();

		let result;
		while (!(result = await iterator.next()).done) {
			ws.send(serializeMessage(result.value, request));
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
