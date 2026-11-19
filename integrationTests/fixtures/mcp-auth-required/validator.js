// Built-in components (HARPER_BUILTIN_COMPONENTS) load via native import() on the main thread too;
// importing the root 'harper' entry here would evaluate threadServer.js on the main thread.
import { credentialRejectionError } from '../../../dist/security/credentialRejection.js';

export const RESOURCE_METADATA = 'https://auth.example.test/.well-known/oauth-protected-resource/mcp';
export const VALID_TOKEN = 'auth-required-valid';
export const REJECTED_TOKEN = 'auth-required-rejected';

export function handleApplication(scope) {
	scope.server.registerBearerValidator(
		async (token) => {
			if (token === VALID_TOKEN) return { username: 'admin', authExpiresAt: Math.floor(Date.now() / 1000) + 300 };
			if (token === REJECTED_TOKEN) throw credentialRejectionError('token expired', 401);
			return undefined;
		},
		{ challenge: { resourceMetadata: RESOURCE_METADATA } }
	);
}
