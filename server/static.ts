import send from 'send';
import { realpathSync } from 'fs';
import serveStatic from 'serve-static';
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
		handleDirectory(urlPath, dirPath) {
			if (urlPath === '/') {
				const serveDir = serveStatic(dirPath, options);
				options.server.http(async (request: Request, nextHandler) => {
					if (!request.isWebSocket) {
						return new Promise((resolve) =>
							serveDir(request._nodeRequest, request._nodeResponse, () => {
								resolve(nextHandler(request));
							})
						);
					}
				});
				return true;
			}
		},
		handleFile(contents, urlPath, filePath) {
			if (!started) {
				// don't start until we actually have a file to handle
				started = true;
				options.server.http(
					async (request: Request, nextHandler) => {
						if (!request.isWebSocket) {
							const filePath = paths.get(request.pathname);
							if (filePath) {
								return {
									handlesHeaders: true,
									body: send(request, realpathSync(filePath)),
								};
							}
						}
						return nextHandler(request);
					},
					{ runFirst: true }
				);
			}
			paths.set(urlPath, filePath);
		},
	};
}
