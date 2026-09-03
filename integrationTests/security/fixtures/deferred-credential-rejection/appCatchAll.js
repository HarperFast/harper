export function handleApplication(scope) {
	scope.server.http(
		async (request) => ({
			status: 200,
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				servedBy: 'application-catch-all',
				authorization: request.headers.get('authorization') ?? null,
				harperUser: request.user?.username ?? null,
				pathname: request.pathname,
			}),
		}),
		{ port: 'all', after: 'rest' }
	);
}
