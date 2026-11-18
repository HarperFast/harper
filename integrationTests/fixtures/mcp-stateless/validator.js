// Built-in components (HARPER_BUILTIN_COMPONENTS) load via native import() on the main thread too;
// importing the root 'harper' entry here would evaluate threadServer.js on the main thread.
export const RESOURCE_METADATA = 'https://auth.example.test/.well-known/oauth-protected-resource/mcp';
export const VALID_TOKEN = 'stateless-valid';

export function handleApplication(scope) {
	scope.server.registerBearerValidator(
		async (token) =>
			token === VALID_TOKEN ? { username: 'admin', authExpiresAt: Math.floor(Date.now() / 1000) + 300 } : undefined,
		{ challenge: { resourceMetadata: RESOURCE_METADATA } }
	);
}
