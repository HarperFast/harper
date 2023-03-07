import { registerServer } from '../server/threads/thread-http-server';
import { threadId } from 'worker_threads';
import { createServer, ClientRequest, ServerOptions } from 'http';
import { readdir, readFile } from 'fs/promises';
import { join } from 'path';
import { SERVICES } from '../utility/hdbTerms';
import { watchDir } from '../server/threads/manageThreads';
import { findAndValidateUser } from '../security/user';
import { WebSocketServer } from 'ws';
import { findBestSerializer, getDeserializer } from '../server/serverHelpers/contentTypes';
import { plugins } from '../index';
import './analytics';

const handler_creator_by_type = new Map();
const custom_apps = [];
let handlers = new Map();

async function loadDirectory(directory: string, web_path: string, handlers) {
	for (let entry of await readdir(directory, { withFileTypes: true })) {
		if (entry.isFile()) {
			let name = entry.name;
			let dot = name.indexOf('.');
			if (dot === -1) continue;
			let base = name.slice(0, dot);
			let extension = name.slice(dot + 1);
			let create_handler = handler_creator_by_type.get(extension);
			try {
				if (create_handler) {
					let file_path = join(directory, name);
					let path_handlers = await create_handler(await readFile(file_path, {encoding: 'utf8'}), file_path);
					if (path_handlers instanceof Map) {
						for (let [ key, handler ] of path_handlers) {
							let path = web_path + (key !== 'default' ? '/' + key : '');
							handler.path = path;
							handlers.set(path, handler);
						}
					} else {
						path_handlers.path = web_path;
						handlers.set(web_path, path_handlers);
					}
				}
			} catch(error) {
				console.warn(`failed to load ${name} due to`, error.stack);
			}
		} else if (entry.name !== 'node_modules') {
			await loadDirectory(join(directory, entry.name), web_path + '/' + entry.name, handlers);
		}
	}
}
let started;
export function registerHandler(path, handler) {
	handlers.set(path, handler);
	if (!started) {
		start({});
	}
}


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
		let handler = findHandler(request.url);
		if (handler) return handler.http(remaining_path, request, response).finally(() => {})
		nextAppHandler(request, response)
	});
	let wss = new WebSocketServer({ server });
	wss.on('connection', (ws, request) => {
		startRequest(request);
		ws.on('error', console.error);
		ws.on('message', function message(body) {
			let data = request.deserialize(body);
			let handler = findHandler(request.url + '/' + data.path);
			if (handler) return handler.ws(remaining_path, data, request, ws);
			console.error('no handler: %s', data);
		});
//		ws.on('close', () => console.log('close'));
	});
	function startRequest(request) {
		// TODO: check rate limiting here?
		let client_id = request.socket.ip;

		const { serializer, type } = findBestSerializer(request);
		request.serializer = serializer;
		let content_type = request.headers['content-type'];
		if (content_type) {
			request.deserialize = getDeserializer(content_type);
		}
		request.responseType = type;
		return authentication(request);
	}
	function findHandler(full_path) {
		let path = full_path;
		do {
			let handler = handlers.get(path);
			if (handler) {
				remaining_path = full_path.slice(path.length + 1)
				return handler;
			}
			let last_slash = path.lastIndexOf('/');
			if (last_slash === -1) break;
			path = path.slice(0, last_slash);
		} while(true);

	}
	plugins.customFunctionHandler(server);
	async function nextAppHandler(request, response) {
		if (custom_apps[0])
			await custom_apps[0](request, response);
		else {
			server.emit('unhandled', request, response);
		}
	}
}
export function registerResourceType(extension, create_resource) {
	handler_creator_by_type.set(extension, create_resource);
}

export async function startOnMainThread(options) {
	let path = options?.path || process.cwd();
	// load all the resource (with dummy webpath/map) so that we can ensure all tables are created
	// before the worker threads start
	await loadDirectory(path, '', new Map());
	watchDir(path, () => {
		// reload the directory on every restart
		return loadDirectory(path, '', new Map());
	});
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
