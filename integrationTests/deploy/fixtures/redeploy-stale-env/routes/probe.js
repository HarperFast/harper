export default async (server) => {
	server.route({
		url: '/redeploy-env-fastify-probe',
		method: 'GET',
		handler: (request, reply) => {
			reply.send({
				codeVersion: 1,
				changedKey: process.env.REDEPLOY_ENV_CHANGED_KEY ?? null,
				newKey: process.env.REDEPLOY_ENV_NEW_KEY ?? null,
			});
		},
	});
};
