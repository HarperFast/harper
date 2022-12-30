import { registerServer } from '../server/threads/thread-http-server';
import { createServer, ClientRequest, ServerOptions } from 'http';
import { readdir, readFile } from 'fs/promises';
import { join } from 'path';
import { SERVICES } from '../utility/hdbTerms';

const handler_creator_by_type = new Map();
const custom_apps = [];
export function startServer(options: ServerOptions & { path: string } = { path: process.cwd() }) {
	let handlers = new Map();
	async function loadDirectory(directory: string, web_path: string) {
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
						let path_handlers = create_handler(await readFile(join(directory, name), {encoding: 'utf8'}));
						if (path_handlers instanceof Map) {
							for (let [ key, handler ] of path_handlers)
								handlers.set(web_path + (key !== 'default' ? '/' + key : ''), handler);
						} else
							handlers.set(web_path, path_handlers);
					}
					else
						console.warn(`no handler found for ${extension}.`);
				} catch(error) {
					console.warn(`failed to load ${name} due to`, error);
				}
			} else {
				await loadDirectory(join(directory, entry.name), web_path + '/' + entry.name);
			}
		}
	}
	loadDirectory(options.path, '');

	let server = createServer(options, (request, response) => {
		let path = request.url;
		do {
			let handler = handlers.get(path);
			if (handler) return handler(request.url.slice(path.length + 1), request, response);
			let last_slash = path.lastIndexOf('/');
			if (last_slash === -1) break;
			path = path.slice(0, last_slash);
		} while(true);
		path = request.url;
		nextAppHandler(request, response)
	});
	registerServer(SERVICES.CUSTOM_FUNCTIONS, server);
	async function nextAppHandler(request, response) {
		if (custom_apps[0])
			await custom_apps[0](request, response);
		else {
			response.writeHead(404);
			response.end('Not found\n');
		}
	}
}
export function registerRESTHandler(extension, create_resource) {
	handler_creator_by_type.set(extension, (content) => {
		let resources = create_resource(content);
		let handler_map = new Map();
		for (let [ sub_path, Resource ] of resources) {
			handler_map.set(sub_path, (next_path, request, response) => {
				let method = request.method;
				let full_isolation = method === 'POST';
				try {
					let resource_snapshot = new Resource(request, full_isolation);
					let response_data;
					switch (method) {
						case 'GET':
							if (next_path) {
								let typed_key = +next_path;
								if (!(typed_key >= 0)) {
									typed_key = next_path;
								}
								response_data = resource_snapshot.get(typed_key);
								if (resource_snapshot.lastAccessTime === request.headers['if-modified-since']) {
									response.writeHead(304);
									response.end();
								}
								response.setHeader('last-modified', new Date(resource_snapshot.lastAccessTime).toUTCString());
								// TODO: Generic way to handle REST headers

							}
							break;
						case 'PUT':
							resource_snapshot.put(request);
							break;
					}
					if (response_data) {
						response.writeHead(200);
						// do content negotiation
						response.end(JSON.stringify(response_data));
					} else if (method === 'GET' || method === 'HEAD') {
						response.writeHead(404);
						response.end('Not found');
					} else {
						response.writeHead(204);
						response.end();
					}
				} catch(error) {
					response.writeHead(400);
					// do content negotiation
					console.error(error);
					response.end(JSON.stringify(error.toString()));
				}
			});
		}
		return handler_map;
	});
}