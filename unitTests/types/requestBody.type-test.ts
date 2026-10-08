import type { ResourceBody } from '../../dist/index.js';
import type { HttpListener } from '../../dist/server/Server.js';
import type { Request } from '../../dist/server/serverHelpers/Request.js';
import { getDeserializer } from '../../dist/server/serverHelpers/contentTypes.js';

export const middleware: HttpListener = async (request) => {
	const data = await request.data;
	data.title;
};

export function formBody(request: Request<{ title: string }>): ResourceBody<{ title: string }> | undefined {
	return request.data;
}

export function typedBodyIsNotAny(request: Request<{ title: string }>): string {
	// @ts-expect-error A typed body may be a record, promise or iterable, rather than any.
	return request.data;
}

export function decoderDefaults(streaming: boolean, optionalStreaming?: boolean) {
	getDeserializer();
	getDeserializer('application/json');
	getDeserializer(undefined, false);
	getDeserializer(undefined, true);
	getDeserializer('application/json', streaming);
	getDeserializer('application/json', optionalStreaming);
	getDeserializer(undefined, optionalStreaming);
}
