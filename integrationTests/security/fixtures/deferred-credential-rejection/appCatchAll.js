// The application's own middleware, mounted after `rest` so Harper's route ownership gets first
// refusal. It claims whatever reaches it and reports the Authorization header it received, which is
// how the test proves the header arrived byte-for-byte and that no Harper principal was attached.
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
