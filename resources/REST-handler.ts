const MAX_COMMIT_RETRIES = 10;
export function restHandler(Resource) {
	return async (next_path, request, response) => {
		let method = request.method;
		let request_data;
		if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
			let request_binary = await new Promise((resolve, reject) => {
				let buffers = [];
				request.on('data', data => buffers.push(data));
				request.on('end', () => resolve(Buffer.concat(buffers)));
				request.on('error', reject);
			});
			// TODO: Handle different content types
			request_data = JSON.parse(request_binary.toString());
		}
		let full_isolation = method === 'POST';
		try {
			let resource_snapshot = new Resource(request, full_isolation);
			try {
				let response_data;
				let typed_key;
				if (next_path) {
					typed_key = +next_path;
					if (!(typed_key >= 0)) {
						typed_key = next_path;
					}
				}
				let retries = 0;
				do {
					switch (method) {
						case 'GET':
							if (typed_key !== undefined) {
								response_data = await resource_snapshot.get(typed_key);
								if (resource_snapshot.lastAccessTime === Date.parse(request.headers['if-modified-since'])) {
									response.writeHead(304);
									response.end();
									return;
								}
							}
							break;
						case 'POST':
							response_data = await resource_snapshot.post(typed_key, request_data);
							break;
						case 'PUT':
							response_data = await resource_snapshot.put(typed_key, request_data);
							break;
						case 'PATCH':
							response_data = await resource_snapshot.patch(typed_key, request_data);
							break;
						case 'DELETE':
							response_data = await resource_snapshot.delete(typed_key);
							break;
					}
					if (await resource_snapshot.commit())
						break; // if commit succeeds, break out of retry loop, we are done
					else if (retries++ >= MAX_COMMIT_RETRIES) { // else keep retrying
						response.writeHead(503);
						response.end('Maximum number of commit retries was exceeded, please try again later');
						return;
					}
				} while (true); // execute again if the commit requires a retry
				if (resource_snapshot.lastAccessTime)
					response.setHeader('last-modified', new Date(resource_snapshot.lastAccessTime).toUTCString());
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
			} catch (error) {
				resource_snapshot.abort();
				throw error;
			}
		} catch (error) {
			response.writeHead(400);
			// do content negotiation
			console.error(error);
			response.end(JSON.stringify(error.toString()));
		}
	}
}