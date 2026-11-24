// Built-in components load via native import() on the main thread too; importing the root 'harper'
// entry here would evaluate threadServer.js on the main thread.
import { credentialRejectionError } from '../../../dist/security/credentialRejection.js';

export function handleApplication(scope) {
	scope.server.registerBearerValidator(
		async (token) => {
			if (typeof token !== 'string' || !token.startsWith('loads-')) return undefined;
			if (token === 'loads-bad') throw credentialRejectionError('loads.js validator refused the token', 401);
			if (token.startsWith('loads-good-'))
				return { username: token.slice('loads-good-'.length), authExpiresAt: Math.floor(Date.now() / 1000) + 600 };
			return undefined;
		},
		{ challenge: { resourceMetadata: 'https://auth1.lifecycle.test/.well-known/oauth-protected-resource/mcp' } }
	);
}
