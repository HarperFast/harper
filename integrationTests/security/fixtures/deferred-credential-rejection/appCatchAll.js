export function handleApplication(scope) {
	scope.server.http(
		async (request) => {
			// #2703: mints a real hdb_session row and Set-Cookie for the session-rejection cases, so
			// the test drives the cookie branch of authentication rather than a synthetic stand-in.
			if (request.pathname === '/mint-session') {
				const user = new URL(request.url, 'http://localhost').searchParams.get('user');
				await request.session.update({ user });
				return { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ user }) };
			}
			// #2703: an application middleware that throws, for the client-visible error body.
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
