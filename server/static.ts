import send from 'send';
import { realpathSync } from 'fs';
import serve_static from 'serve-static';
const paths = new Map<string, string>();
let started;
export function start(options: {
	path: string;
	root: string;
	files: string;
	port: number;
	server: any;
	resources: any;
}) {
	return {
		handleDirectory(url_path, dir_path) {
			if (url_path === '/') {
				const serve_dir = serve_static(dir_path, options);
				options.server.http(async (request: Request, next_handler) => {
					if (!request.isWebSocket) {
						return new Promise((resolve) =>
							serve_dir(request._nodeRequest, request._nodeResponse, () => {
								resolve(next_handler(request));
							})
						);
					}
				});
				return true;
			}
		},
		handleFile(contents, url_path, file_path) {
			if (!started) {
				// don't start until we actually have a file to handle
				started = true;
				options.server.http(
					async (request: Request, next_handler) => {
						if (!request.isWebSocket) {
							const file_path = paths.get(request.pathname);
							if (file_path) {
								return {
									handlesHeaders: true,
									body: send(request, realpathSync(file_path)),
								};
							}
						}
						return next_handler(request);
					},
					{ runFirst: true }
				);
			}
			paths.set(url_path, file_path);
		},
	};
}
