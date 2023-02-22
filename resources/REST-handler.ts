import { findBestSerializer, getDeserializer } from '../server/serverHelpers/contentTypes';
import { recordRequest } from './analytics';
import { createServer, ClientRequest, ServerOptions } from 'http';
import { WebSocketServer } from 'ws';
import { resources, plugins } from '../index';
import { findAndValidateUser } from '../security/user';

const MAX_COMMIT_RETRIES = 10;
async function http(Resource, next_path, request, response) {
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
				request_data = request.deserialize(request_binary);
			}
		} catch (error) {
			error.status = 400;
			throw error;
		}
		let response_object = await execute(Resource, method, next_path, request_data, request, response);
		let execution_time = performance.now() - start;
		response.setHeader('Server-Timing', `db;dur=${execution_time}`);
		recordRequest(this.path, execution_time);
		if (response_object.status)
			response.writeHead(response_object.status);
		if (response_object.data === undefined)
			response.end();
		else {
			let serializer = request.serializer;
			if (serializer.serializeStream)
				serializer.serializeStream(response_object.data).pipe(response);
			else
				response.end(serializer.serialize(response_object.data));
		}
	} catch (error) {
		let execution_time = performance.now() - start;
		recordRequest(this.path, execution_time);
		response.writeHead(error.status || 500); // use specified error status, or default to generic server error
		// do content negotiation
		console.error(error);
		response.end(request.serializer.serialize(error.toString()));
	}
}
async function execute(Resource, method, path, request_data, request, response?) {
	let full_isolation = method === 'POST';
	let resource_snapshot = new Resource(request, full_isolation);
	try {
		let response_data;
		let typed_key;
		if (path) {
			typed_key = +path;
			if (!(typed_key >= 0)) {
				typed_key = path;
			}
		}
		let user = request.user;
		let retries = 0;
		do {
			switch (method) {
				case 'GET-SUB':
					if (typed_key !== undefined) {
						let subscription = resource_snapshot.subscribe(typed_key, {
							callback() {
								response.send(request.serializer.serialize({
									path,
									updated: true
								}));
							}
						});
						response.on('close', () => subscription.end());
					}
					// fall-through
				case 'GET':
					if (typed_key !== undefined) {
						let checked = checkAllowed(resource_snapshot.allowGet?.(user), user, resource_snapshot);
						if (checked?.then) await checked; // fast path to avoid await if not needed
						response_data = await resource_snapshot.get(typed_key);
						if (resource_snapshot.lastModificationTime === Date.parse(request.headers['if-modified-since'])) {
							resource_snapshot.doneReading();
							return { status: 304 };
						}
					}
					break;
				case 'POST':
					await checkAllowed(resource_snapshot.allowPost?.(user), user, resource_snapshot);
					response_data = await resource_snapshot.post(typed_key, request_data);
					break;
				case 'PUT':
					await checkAllowed(resource_snapshot.allowPut?.(user), user, resource_snapshot);
					response_data = await resource_snapshot.put(typed_key, request_data);
					break;
				case 'PATCH':
					await checkAllowed(resource_snapshot.allowPatch?.(user), user, resource_snapshot);
					response_data = await resource_snapshot.patch(typed_key, request_data);
					break;
				case 'DELETE':
					await checkAllowed(resource_snapshot.allowDelete?.(user), user, resource_snapshot);
					response_data = await resource_snapshot.delete(typed_key);
					break;
			}
			if (await resource_snapshot.commit())
				break; // if commit succeeds, break out of retry loop, we are done
			else if (retries++ >= MAX_COMMIT_RETRIES) { // else keep retrying
				return {
					status: 503, data: 'Maximum number of commit retries was exceeded, please try again later'
				};
			}
		} while (true); // execute again if the commit requires a retry
		if (resource_snapshot.lastModificationTime && response.setHeader)
			response.setHeader('last-modified', new Date(resource_snapshot.lastModificationTime).toUTCString());
		if (response_data) {
			if (response_data.resolveData) // if it is iterable with onDone, TODO: make a better marker for this
				response_data.onDone = () => resource_snapshot.doneReading();
			else
				resource_snapshot.doneReading();
			if (request.responseType && response.setHeader)
				response.setHeader('content-type', request.responseType);
			return {
				status: 200,
				// do content negotiation
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
async function wsMessage(Resource, path, data, request, ws) {
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
			if (!allowed) checkAllowed(false, resource);
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
export function start(options: ServerOptions & { path: string, port: number }) {
	started = true;
	/*	if (!handlers) {
			handlers = new Map();
			loadDirectory(options?.path || process.cwd(), '', handlers);
		}*/
	options.keepAlive = true;
	let remaining_path;
	let server = createServer(options, async (request, response) => {
		await startRequest(request);
		let resource = findResource(request.url);
		if (resource) return http(resource, remaining_path, request, response).finally(() => {})
		nextAppHandler(request, response)
	});
	let wss = new WebSocketServer({ server });
	wss.on('connection', (ws, request) => {
		startRequest(request);
		ws.on('error', console.error);
		ws.on('message', function message(body) {
			let data = request.deserialize(body);
			let resource = findResource(request.url + '/' + data.path);
			if (resource) return wsMessage(resource, remaining_path, data, request, ws);
			console.error('no handler: %s', data);
		});
//		ws.on('close', () => console.log('close'));
	});
	function startRequest(request) {
		// TODO: check rate limiting here?
		let client_id = request.socket.ip;

		const { serializer, type } = findBestSerializer(request);
		request.serializer = serializer;
		if (serializer.isSubscription)
			request.method = 'GET-SUB';
		let content_type = request.headers['content-type'];
		if (content_type) {
			request.deserialize = getDeserializer(content_type);
		}
		request.responseType = type;
		return authentication(request);
	}
	function findResource(full_path) {
		let path = full_path;
		do {
			let resource = resources.get(path);
			if (resource) {
				remaining_path = full_path.slice(path.length + 1)
				return resource;
			}
			let last_slash = path.lastIndexOf('/');
			if (last_slash === -1) break;
			path = path.slice(0, last_slash);
		} while(true);

	}
	plugins.customFunctionHandler(server);
	async function nextAppHandler(request, response) {
		server.emit('unhandled', request, response);
	}
}


let authorization_cache = new Map();
const AUTHORIZATION_TTL = 5000;
// TODO: Add this a component plugin, with a pre-request handler hook
// TODO: Make this not return a promise if it can be fulfilled synchronously (from cache)
async function authentication(request) {
	let authorization = request.headers.authorization;
	if (authorization) {
		let user = authorization_cache.get(authorization);
		if (!user) {
			let [ strategy, credentials ] = authorization.split(' ');
			switch (strategy) {
				case 'Basic':
					let [ username, password ] = atob(credentials).split(':');
					user = await findAndValidateUser(username, password);

			}
			authorization_cache.set(authorization, user);
		}
		request.user = user;
	}
}
// keep it cleaned out periodically
setInterval(() => { authorization_cache = new Map() }, AUTHORIZATION_TTL);
