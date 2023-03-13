import { serialize, serializeMessage, getDeserializer } from '../server/serverHelpers/contentTypes';
import { recordRequest } from '../resources/analytics';
import { createServer, ClientRequest, ServerOptions } from 'http';
import { findAndValidateUser } from '../security/user';
import { authentication } from '../security/auth';
import { server } from './Server';
import { Resources } from '../resources/Resources';

interface Response {
	status?: number
	headers?: any
	data?: any
	body?: any
}

const MAX_COMMIT_RETRIES = 10;

async function http(Resource, resource_path, next_path, request) {
	let method = request.method;
	let start = performance.now();
	let request_data;
	try {
		try {
			if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
				let request_binary = await new Promise((resolve, reject) => {
					let buffers = [];
					request.on('data', data => buffers.push(data));
					request.on('end', () => resolve(Buffer.concat(buffers)));
					request.on('error', reject);
				});
				request.data = request.deserialize(request_binary);
			}
		} catch (error) { // TODO: Convert to HDBError
			error.status = 400;
			throw error;
		}

		let resource_result = Resource[method.toLowerCase()](next_path, request);
			//= await execute(Resource, method, next_path, request_data, request);
		let if_modified_since = request.headers['if-modified-since'];
		let status = 200;
		if (if_modified_since && resource_result.updated === Date.parse(if_modified_since)) {
			resource_result.cancel();
			status = 302;
			resource_result.data = undefined;
		}

		let headers = {};
		if (resource_result.updated)
			headers['Last-Modified'] = new Date(resource_result.updated).toUTCString();
		let execution_time = performance.now() - start;
		headers['Server-Timing'] = `db;dur=${execution_time}`;
		recordRequest(resource_path, execution_time);
		let response_object = {
			status,
			headers,
			body: undefined,
		}

		if (resource_result.data !== undefined) {
			response_object.body = serialize(resource_result.data, request, response_object)
		}
		return response_object;
	} catch (error) {
		let execution_time = performance.now() - start;
		recordRequest(resource_path, execution_time);
		// do content negotiation on the error
		console.error(error);
		return {
			status: error.status || 500,// use specified error status, or default to generic server error
			body: serialize(error.toString(), request),
		};
	}
}

let message_count = 0;

async function execute(Resource, method, relative_url, request_data, request, ws?): Response {
	let full_isolation = method === 'POST';
	let resource_snapshot = new Resource(request, full_isolation);
	try {
		let response_data;
		let user = request.user;
		let retries = 0;
		switch (method) {
			case 'GET-SUB':
				if (relative_url !== undefined) {
					let subscription = response_data = resource_snapshot.subscribe(relative_url, {
						callback: request.onUpdate,
					});
				}
				break;
			case 'GET':
				if (relative_url !== undefined) {
					let checked = checkAllowed(resource_snapshot.allowGet?.(user), user, resource_snapshot);
					if (checked?.then) await checked; // fast path to avoid await if not needed
					response_data = await resource_snapshot.get(relative_url);
					if (resource_snapshot.lastModificationTime === Date.parse(request.headers['if-modified-since'])) {
						resource_snapshot.doneReading();
						return {status: 304};
					}
				}
				break;
			case 'POST':
				await checkAllowed(resource_snapshot.allowPost?.(user), user, resource_snapshot);
				response_data = await resource_snapshot.post(relative_url, request_data);
				break;
			case 'PUT':
				await checkAllowed(resource_snapshot.allowPut?.(user), user, resource_snapshot);
				response_data = await resource_snapshot.put(relative_url, request_data);
				break;
			case 'PATCH':
				await checkAllowed(resource_snapshot.allowPatch?.(user), user, resource_snapshot);
				response_data = await resource_snapshot.patch(relative_url, request_data);
				break;
			case 'DELETE':
				await checkAllowed(resource_snapshot.allowDelete?.(user), user, resource_snapshot);
				response_data = await resource_snapshot.delete(relative_url);
				break;
		}
		await resource_snapshot.commit();
		if (response_data) {
			let if_modified_since = request.headers['if-modified-since'];
			if (if_modified_since && resource_snapshot.lastModificationTime === Date.parse(if_modified_since) {
				resource_snapshot.doneReading();
				return {status: 304};
			}
			if (response_data.resolveData) // if it is iterable with onDone, TODO: make a better marker for this
				response_data.onDone = () => resource_snapshot.doneReading();
			else
				resource_snapshot.doneReading();
			let headers = { // TODO: Move this to negotiation in contentType
				'Content-Type': request.responseType,
				Vary: 'Accept',
			};
			if (resource_snapshot.lastModificationTime)
				headers['Last-Modified'] = new Date(resource_snapshot.lastModificationTime).toUTCString();
			return {
				status: 200,
				headers,
				data: response_data,
			};
		} else {
			resource_snapshot.doneReading();
			if ((method === 'GET' || method === 'HEAD')) {
				return {status: 404, data: 'Not found'};
			} else {
				return {status: 204};
			}
		}
	} catch (error) {
		resource_snapshot.abort();
		throw error;
	}
}

async function wsMessage(Resource, resource_path, path, data, request, ws) {
	let method = data.method?.toUpperCase() || 'GET-SUB';
	let request_data = data.body;
	let request_id = data.id;
	try {
		let response = await execute(Resource, method, path, request_data, request, ws);
		let subscription = response.data;
		subscription.listener = () => {
			if (!message_count) {
				setTimeout(() => {
					console.log('message count (in last 10 seconds)', message_count, 'connection_count', connection_count, 'mem', Math.round(process.memoryUsage().heapUsed / 1000000));
					message_count = 0;
				}, 10000);
			}
			message_count++;
			ws.send(serializeMessage({
				path,
				updated: true
			}, request));
		};
		ws.on('close', () => subscription.end());
		//response_data.id = request_id;
		response.id = request_id;
		ws.send(serializeMessage(response, request));
	} catch (error) {
		// do content negotiation
		console.error(error);
		ws.send(serializeMessage({status: 500, id: request_id, data: error.toString()}, request));
	}
}

function checkAllowed(method_allowed, user, resource): void | Promise<void> {
	let allowed = method_allowed ??
		resource.allowAccess?.() ??
		user?.role.permission.super_user; // default permission check
	if (allowed?.then) {
		// handle promises, waiting for them using fast path (not await)
		return allowed.then(() => {
			if (!allowed) checkAllowed(false, user, resource);
		});
	} else if (!allowed) {
		let error
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

export function start(options: ServerOptions & { path: string, port: number, server: any, resources: any }) {
	if (started)
		return;
	started = true;
	resources = options.resources;
	/*	if (!handlers) {
			handlers = new Map();
			loadDirectory(options?.path || process.cwd(), '', handlers);
		}*/
	let remaining_path, resource_path;
	options.server.http(async (request: Request, next_handler) => {
		await startRequest(request);
		let entry = resources.getMatch(request.url);
		if (entry) {
			return http(entry.Resource, entry.path, resources.remainingPath, request);
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
		ws.on('error', console.error);
		ws.on('message', function message(body) {
			// await chain_completion;
			let data = request.deserialize(body);
			let entry = resources.getMatch(request.url + '/' + (data.path ?? ''));
			if (entry) {
				return wsMessage(entry.Resource, entry.path, resources.remainingPath, data, request, ws);
			}
			console.error('no handler: %s', data);
		});
		ws.on('close', () => connection_count--);
	});

	function startRequest(request) {
		// TODO: check rate limiting here?
		let url = request.url;
		let dot_index = url.lastIndexOf('.');
		if (dot_index > -1) {
			// we can use .extensions to force the Accept header
			let ext = url.slice(dot_index + 1);
			let accept = EXTENSION_TYPES[ext];
			if (accept)
				request.headers.accept = accept;
		}
		if (request.headers.accept === 'text/event-stream') {
			request.method = 'GET-SUB';
		}
		let content_type = request.headers['content-type'];
		if (content_type) {
			request.deserialize = getDeserializer(content_type);
		}
	}
}

const EXTENSION_TYPES = {
	json: 'application/json',
	cbor: 'application/cbor',
	msgpack: 'application/x-msgpack',
	csv: 'text/csv',
}
