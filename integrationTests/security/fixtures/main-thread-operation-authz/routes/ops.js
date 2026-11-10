import { threadId, isMainThread } from 'node:worker_threads';

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
