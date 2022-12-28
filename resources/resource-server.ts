import { registerServer } from '../server/threads/thread-http-server';
import { createServer, ClientRequest } from 'http';
import { readdir, readFile } from 'fs/promises';
import { join } from 'path';
import { SERVICES } from '../utility/hdbTerms';

const handler_creator_by_type = new Map();
const custom_apps = [];
export function startServer(options: {} = {}) {
	let handlers = new Map();
	async function loadDirectory(directory, web_path) {
		for (let entry of await readdir(directory, { withFileTypes: true })) {
			if (entry.isFile()) {
				let name = entry.name;
				let dot = name.indexOf('.');
				let base = name.slice(0, dot);
				let extension = name.slice(dot);
				let create_handler = handler_creator_by_type.get(extension);
				if (create_handler)
					handlers.set(web_path + '/' + base, create_handler(readFile(join(directory, name), { encoding: 'utf8' })));
				else
					console.warn(`no handler found for ${extension}.`);
			} else {
				await loadDirectory(join(directory, entry.name), web_path + '/' + entry.name);
			}
		}
	}
	loadDirectory('/home/kzyp/hdb', '/');

	let server = createServer(options, (request, response) => {
		let path = request.url;
		do {
			let handler = handlers.get(path);
			if (handler) return handler(request, response);
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
		let Resource = create_resource(content);
		return (request, response) => {
			let path = request.path;
			let method = request.method;
			let read_only = method === 'GET';
			let resource_snapshot = new Resource(request, read_only);
			switch(method) {
				case 'GET':
					if (path) {
						let entry = resource_snapshot.getEntry(request);
						if (entry.version === request.headers['if-modified-since']) {
							response.writeHead(304);
							response.end();
						}
						response.headers['last-modified'] = resource_snapshot.lastAccessTime;
						// TODO: Generic way to handle REST headers
					}
					break;
				case 'PUT':
					resource_snapshot.put(request);
					break;
			}
		};
	});
}