import { findBestSerializer, getDeserializer } from '../server/serverHelpers/contentTypes';
import { recordRequest } from './analytics';
import { createServer, ClientRequest, ServerOptions } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { findAndValidateUser } from '../security/user';
import { server } from '../index';

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
	let headers = new Headers();
	try {
		try {
			if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
				let request_binary = await new Promise((resolve, reject) => {
					let buffers = [];
					request.on('data', data => buffers.push(data));
					request.on('end', () => resolve(Buffer.concat(buffers)));
					request.on('error', reject);
				});
				request_data = request.deserialize(request_binary);
			}
		} catch (error) {
			error.status = 400;
			throw error;
		}
		let response_object = await execute(Resource, method, next_path, request_data, request);
		let execution_time = performance.now() - start;
		response_object.headers['Server-Timing'] = `db;dur=${execution_time}`;
		recordRequest(resource_path, execution_time);
		if (response_object.data !== undefined) {
			let serializer = request.serializer;
			if (serializer.serializeStream)
				response_object.body = serializer.serializeStream(response_object.data);
			else
				response_object.body = serializer.serialize(response_object.data);
		}
		return response_object;
	} catch (error) {
		let execution_time = performance.now() - start;
		recordRequest(resource_path, execution_time);
		// do content negotiation on the error
		console.error(error);
		return new Response(request.serializer.serialize(error.toString()), {
			status: error.status || 500// use specified error status, or default to generic server error
		});
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
					let subscription = resource_snapshot.subscribe(relative_url, {
						callback() {
							if (!message_count) {
								setTimeout(() => {
									console.log('message count (in last 10 seconds)', message_count, 'connection_count', connection_count, 'mem', Math.round(process.memoryUsage().heapUsed / 1000000));
									message_count = 0;
								}, 10000);
							}
							message_count++;

							ws.send(request.serializer.serialize({
								path: relative_url,
								updated: true
							}));
						}
					});
					ws.on('close', () => subscription.end());
				}
				// fall-through
			case 'GET':
				if (relative_url !== undefined) {
					let checked = checkAllowed(resource_snapshot.allowGet?.(user), user, resource_snapshot);
					if (checked?.then) await checked; // fast path to avoid await if not needed
					response_data = await resource_snapshot.get(relative_url);
					if (resource_snapshot.lastModificationTime === Date.parse(request.headers._asObject['if-modified-since'])) {
						resource_snapshot.doneReading();
						return { status: 304 };
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
				return { status: 404, data: 'Not found' };
			} else {
				return { status: 204 };
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
		//response_data.id = request_id;
		response.id = request_id;
		ws.send(request.serializer.serialize(response));
	} catch (error) {
		// do content negotiation
		console.error(error);
		ws.send(request.serializer.serialize({status: 500, id: request_id, data: error.toString()}));
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
let resources = new Map();
export function loadedResources(loaded_resources) {
	resources = loaded_resources;
}
let connection_count = 0;
let printing_connection_count;

export function start(options: ServerOptions & { path: string, port: number }) {
	if (started)
		return;
	started = true;
	/*	if (!handlers) {
			handlers = new Map();
			loadDirectory(options?.path || process.cwd(), '', handlers);
		}*/
	options.keepAlive = true;
	let remaining_path, resource_path;
	let http_server = server.http(async (request, next_handler) => {
		await startRequest(request);
		let resource = findResource(request.url);
		if (resource) return http(resource, resource_path, remaining_path, request);
		return next_handler(request);
	});
	let wss = new WebSocketServer({ server: http_server });
	wss.on('connection', (ws, request) => {
		connection_count++;
		if (!printing_connection_count) {
			setTimeout(() => {
				console.log('connection count', connection_count,'mem', Math.round(process.memoryUsage().heapUsed / 1000000));
				printing_connection_count = false;
			}, 1000);
			printing_connection_count = true;
		}

		startRequest(request);
		ws.on('error', console.error);
		ws.on('message', function message(body) {
			let data = request.deserialize(body);
			let resource = findResource(request.url + '/' + (data.path ?? ''));
			if (resource) return wsMessage(resource, resource_path, remaining_path, data, request, ws);
			console.error('no handler: %s', data);
		});
		ws.on('close', () => connection_count--);
	});
	function startRequest(request) {
		// TODO: check rate limiting here?
		const { serializer, type } = findBestSerializer(request);
		request.serializer = serializer;
		if (serializer.isSubscription)
			request.method = 'GET-SUB';
		let content_type = request.headers._asObject['content-type'];
		if (content_type) {
			request.deserialize = getDeserializer(content_type);
		}
		request.responseType = type;
	}
	function findResource(full_path) {
		let path = full_path;
		do { // TODO: I think it would be faster to go forward through paths rather than reverse
			let resource = resources.get(path);
			if (resource) {
				remaining_path = full_path.slice(path.length + 1);
				resource_path = path;
				return resource;
			}
			let last_slash = path.lastIndexOf('/');
			if (last_slash === -1) break;
			path = path.slice(0, last_slash);
		} while (true);
	}
	async function nextAppHandler(request, response) {
		http_server.emit('unhandled', request, response);
	}
}


