const assert = require('node:assert');
const { isValidChallengeUrl } = require('#src/security/challengeUrl');

describe('security/challengeUrl isValidChallengeUrl (#4344)', () => {
	it('accepts an https URL and a loopback http URL', () => {
		for (const value of [
			'https://app.example.com/.well-known/oauth-protected-resource/mcp',
			'https://app.example.com:8443/prm?x=1',
			'http://localhost:9926/prm',
			'http://127.0.0.1/prm',
			'http://[::1]:9926/prm',
		]) {
			assert.strictEqual(isValidChallengeUrl(value), true, value);
		}
	});

	it('refuses anything that is not a header-safe https URL', () => {
		for (const value of [
			undefined,
			null,
			42,
			'',
			'/relative',
			'ftp://app.example.com/prm',
			'http://app.example.com/prm',
			'http://127.evil.example/prm',
			'https://app.example.com/prm#fragment',
			'https://app.example.com/prm", error="x',
			'https://app.example.com/a b',
			'https://app.example.com/\\prm',
			'https://app.example.com/prm\r\nSet-Cookie: x=1',
			'https://app.example.com/café',
			`https://app.example.com/${'a'.repeat(2048)}`,
		]) {
			assert.strictEqual(isValidChallengeUrl(value), false, String(value));
		}
	});
});
