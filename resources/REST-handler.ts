import { findBestSerializer } from '../server/serverHelpers/contentTypes';
const MAX_COMMIT_RETRIES = 10;
export function restHandler(Resource) {
	async function http(next_path, request, response) {
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
		try {
			let response_data = await execute(method, next_path, request_data, request, response);
			if (response_data.status)
				response.writeHead(response_data.status);
			if (typeof response_data.body?.pipe === 'function')
				response_data.body.pipe(response);
			else
				response.end(response_data.body);
		} catch (error) {
			response.writeHead(400);
			// do content negotiation
			console.error(error);
			response.end(JSON.stringify(error.toString()));
		}
	}
	async function execute(method, path, request_data, request, response?) {
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
			let retries = 0;
			do {
				switch (method) {
					case 'GET':
						if (typed_key !== undefined) {
							let p = resource_snapshot.get(typed_key);;
							response_data = await p;
							if (resource_snapshot.lastAccessTime === Date.parse(request.headers['if-modified-since'])) {
								resource_snapshot.doneReading();
								return { status: 304 };
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
					return {
						status: 503, body: 'Maximum number of commit retries was exceeded, please try again later'
					};
				}
			} while (true); // execute again if the commit requires a retry
			if (resource_snapshot.lastAccessTime && response)
				response.setHeader('last-modified', new Date(resource_snapshot.lastAccessTime).toUTCString());
			if (response_data) {
				if (response_data.resolveData) // if it is iterable with onDone, TODO: make a better marker for this
					response_data.onDone = () => resource_snapshot.doneReading();
				else
					resource_snapshot.doneReading();
				if (request.responseType && response)
					response.setHeader('content-type', request.responseType);
				return {
					status: 200,
					// do content negotiation
					body: request.serialize(response_data),
				};
			} else {
				resource_snapshot.doneReading();
				if ((method === 'GET' || method === 'HEAD')) {
					return { status: 404, body: 'Not found' };
				} else {
					return { status: 204 };
				}
			}
		} catch (error) {
			resource_snapshot.abort();
			throw error;
		}
	}
	async function ws(path, data, request, ws) {
		let method = data.method || 'GET';
		let request_data = data.body;
		let request_id = data.id;
		try {
			let response_data = await execute(method, path, request_data, request);
			//response_data.id = request_id;
			ws.send(`{"status":${response_data.status},"id":${request_id},"data":${response_data.body}}`);
		} catch (error) {
			// do content negotiation
			console.error(error);
			ws.send(JSON.stringify({status: 500, id: request_id, body: error.toString()}));
		}
	}
	return { http, ws };
}