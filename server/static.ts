import send from 'send';
const paths = new Map<string, string>();
let started;
export function start(options: { path: string; root: string; port: number; server: any; resources: any }) {
	const root = options.root;
	return {
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
									body: send(request, file_path),
								};
							}
						}
						return next_handler(request);
					},
					{ runFirst: true }
				);
			}
			if (root) {
				if (url_path.startsWith('/' + root)) url_path = url_path.slice(root.length + 1);
				else if (url_path.startsWith(root)) url_path = url_path.slice(root.length);
			}
			paths.set(url_path, file_path);
		},
	};
}
