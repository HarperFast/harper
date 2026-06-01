const assert = require('node:assert/strict');
const { redactArgs, maskSessionId, emitAuditEntry } = require('#src/components/mcp/audit');

describe('mcp/audit', () => {
	describe('redactArgs', () => {
		it('replaces values for credential-like keys with [redacted]', () => {
			const input = { username: 'alice', password: 's3cr3t', api_key: 'xyz', authToken: 'abc' };
			const out = redactArgs(input);
			assert.equal(out.username, 'alice');
			assert.equal(out.password, '[redacted]');
			assert.equal(out.api_key, '[redacted]');
			assert.equal(out.authToken, '[redacted]');
		});

		it('recurses into nested objects', () => {
			const input = { user: { name: 'alice', secret: 'hidden' }, list: [{ password: 'p' }] };
			const out = redactArgs(input);
			assert.equal(out.user.name, 'alice');
			assert.equal(out.user.secret, '[redacted]');
			assert.equal(out.list[0].password, '[redacted]');
		});

		it('does not mutate the input', () => {
			const input = { password: 'p' };
			redactArgs(input);
			assert.equal(input.password, 'p');
		});

		it('handles non-object inputs by passing through', () => {
			assert.equal(redactArgs('hello'), 'hello');
			assert.equal(redactArgs(42), 42);
			assert.equal(redactArgs(null), null);
			assert.equal(redactArgs(undefined), undefined);
		});

		it('bounds recursion depth to avoid pathological inputs', () => {
			const a = {};
			a.self = a; // cycle
			// Should not stack-overflow; returns a shallow walk capped at depth.
			const out = redactArgs(a);
			assert.ok(out);
		});

		it('redacts the entire sub-object when depth limit is exceeded', () => {
			// Build a nesting deeper than MAX_REDACTION_DEPTH (10) and embed a
			// credential at the bottom. Naively the depth cap could leak it.
			let leaf = { password: 'should-not-leak' };
			let nest = leaf;
			for (let i = 0; i < 12; i++) nest = { wrap: nest };
			const out = redactArgs(nest);
			// Walk back down: at some point we should hit [redacted] before reaching the password.
			let cursor = out;
			const seen = [];
			while (cursor && typeof cursor === 'object') {
				seen.push(cursor);
				if (cursor === '[redacted]') break;
				cursor = cursor.wrap;
			}
			const flat = JSON.stringify(out);
			assert.ok(!flat.includes('should-not-leak'), 'credential below depth limit must not leak');
			assert.ok(flat.includes('[redacted]'));
		});
	});

	describe('maskSessionId', () => {
		it('keeps the first 8 chars and elides the suffix', () => {
			assert.equal(maskSessionId('1234567890abcdef'), '12345678…');
		});

		it('passes through short strings unchanged', () => {
			assert.equal(maskSessionId('short'), 'short');
		});

		it('passes through non-strings unchanged', () => {
			assert.equal(maskSessionId(undefined), undefined);
			assert.equal(maskSessionId(null), null);
		});
	});

	describe('emitAuditEntry', () => {
		it('does not throw on a well-formed entry', () => {
			assert.doesNotThrow(() =>
				emitAuditEntry({
					timestamp: new Date().toISOString(),
					profile: 'application',
					sessionId: 'abcdefgh-ijkl-mnop',
					tool: 'search_Product',
					user: 'alice',
					args: { limit: 10 },
					status: 'ok',
					durationMs: 15,
				})
			);
		});

		it('does not throw on a rate-limited entry with no errorMessage', () => {
			assert.doesNotThrow(() =>
				emitAuditEntry({
					timestamp: new Date().toISOString(),
					profile: 'operations',
					sessionId: 'xyz',
					tool: 'describe_all',
					user: 'bob',
					args: {},
					status: 'rate_limited',
					durationMs: 0,
				})
			);
		});
	});
});
