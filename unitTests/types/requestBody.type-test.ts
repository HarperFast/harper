import type { ResourceBody } from '../../dist/index.js';
import type { HttpListener } from '../../dist/server/Server.js';
import type { Request } from '../../dist/server/serverHelpers/Request.js';

export const middleware: HttpListener = async (request) => {
	const data = await request.data;
	data.title;
};

export function formBody(request: Request<{ title: string }>): ResourceBody<{ title: string }> | undefined {
	return request.data;
}
