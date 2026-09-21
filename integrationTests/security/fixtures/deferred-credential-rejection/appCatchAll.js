export function handleApplication(scope) {
	scope.server.http(
		async (request) => {
			if (request.pathname === '/mint-session') {
				const user = new URL(request.url, 'http://localhost').searchParams.get('user');
				await request.session.update({ user });
				return { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ user }) };
			}
			// throws from middleware, so the error reaches the terminal HTTP handler rather than
			// REST's resource-error mapping
			if (request.pathname === '/throw-from-middleware') {
				const error = new Error('deliberate middleware failure');
				error.statusCode = 503;
				throw error;
			}
			return {
				status: 200,
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					servedBy: 'application-catch-all',
					authorization: request.headers.get('authorization') ?? null,
					harperUser: request.user?.username ?? null,
					pathname: request.pathname,
				}),
			};
		},
		{ port: 'all', after: 'rest' }
	);
}
