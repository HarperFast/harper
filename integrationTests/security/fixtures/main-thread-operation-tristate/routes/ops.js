import { threadId, isMainThread } from 'node:worker_threads';

// The application port's legacy operations route, dispatched on this worker thread.
export default async (server, { hdbCore }) => {
	server.route({
		url: '/ops',
		method: 'POST',
		preValidation: hdbCore.preValidation,
		handler: async (request, reply) => {
			reply.header('x-operation-thread', `${threadId}:${isMainThread ? 'main' : 'worker'}`);
			return hdbCore.request(request, reply);
		},
	});
};
