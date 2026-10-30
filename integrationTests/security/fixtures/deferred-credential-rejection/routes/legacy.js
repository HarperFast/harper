export default async (server, { hdbCore }) => {
	server.route({
		url: '/legacy-auth',
		method: 'POST',
		preValidation: hdbCore.preValidation,
		handler: (request) => ({ servedBy: 'legacy-route', harperUser: request.body.hdb_user?.username ?? null }),
	});
};
