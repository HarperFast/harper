import { registerServer } from '../server/threads/thread-http-server';
import { createServer, ClientRequest, ServerOptions } from 'http';
import { readdir, readFile } from 'fs/promises';
import { join } from 'path';
import { SERVICES } from '../utility/hdbTerms';
import { restHandler } from './REST-handler';
import { findAndValidateUser } from '../security/user';

const handler_creator_by_type = new Map();
const custom_apps = [];
export function start(options: ServerOptions & { path: string } = { path: process.cwd() }) {
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
						let file_path = join(directory, name);
						let path_handlers = await create_handler(await readFile(file_path, {encoding: 'utf8'}), file_path);
						if (path_handlers instanceof Map) {
							for (let [ key, handler ] of path_handlers)
								handlers.set(web_path + (key !== 'default' ? '/' + key : ''), handler);
						} else
							handlers.set(web_path, path_handlers);
					}
					else
						console.warn(`no handler found for ${extension}.`);
				} catch(error) {
					console.warn(`failed to load ${name} due to`, error.stack);
				}
			} else {
				await loadDirectory(join(directory, entry.name), web_path + '/' + entry.name);
			}
		}
	}
	loadDirectory(options.path || process.cwd(), '');

	let server = createServer(options, async (request, response) => {
		let path = request.url;
		await authentication(request);
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
			server.emit('unhandled', request, response);
		}
	}
}
export function registerResourceType(extension, create_resource) {
	handler_creator_by_type.set(extension, create_resource);
}

async function authentication(request) {
	let authorization = request.headers.authorization;
	if (authorization) {
		let [ strategy, credentials ] = authorization.split(' ');
		switch (strategy) {
			case 'Basic':
				let [ username, password ] = atob(credentials).split(':');
				request.user = await findAndValidateUser(username, password);
		}
	}
}