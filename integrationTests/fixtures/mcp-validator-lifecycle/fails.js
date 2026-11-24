import { writeFileSync } from 'node:fs';
import { threadId } from 'node:worker_threads';
import { credentialRejectionError } from '../../../dist/security/credentialRejection.js';

export function handleApplication(scope) {
	scope.server.registerBearerValidator(
		async (token) => {
			if (typeof token !== 'string' || !token.startsWith('fails-')) return undefined;
			if (token === 'fails-bad') throw credentialRejectionError('fails.js validator refused the token', 401);
			if (token.startsWith('fails-good-'))
				return { username: token.slice('fails-good-'.length), authExpiresAt: Math.floor(Date.now() / 1000) + 600 };
			return undefined;
		},
		{ challenge: { resourceMetadata: 'https://authf.lifecycle.test/.well-known/oauth-protected-resource/mcp' } }
	);
	writeFileSync(`${process.env.MCP_VALIDATOR_LIFECYCLE_MARKER}-${threadId}`, 'registered');
	throw new Error('mcp-validator-lifecycle fixture: load failed after registering');
}
