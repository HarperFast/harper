const assert = require('node:assert');
const { redactArgs, redactArgsForTool, maskSessionId, emitAuditEntry } = require('#src/components/mcp/audit');

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

		it('redacts every secret-bearing field for both secret tools', () => {
			const secret = redactArgsForTool(
				{ name: 'API_KEY', value: 'plaintext-secret', envelope: 'enc:v1:abc' },
				'set_secret'
			);
			assert.deepStrictEqual(secret, { name: 'API_KEY', value: '[redacted]', envelope: '[redacted]' });

			const environment = redactArgsForTool(
				{ key: 'DATABASE_URL', value: 'postgres://secret', values: { A: '1' } },
				'set_env_value'
			);
			assert.deepStrictEqual(environment, {
				key: 'DATABASE_URL',
				value: '[redacted]',
				values: '[redacted]',
			});
		});

		// MCP forwards arguments as-is and audits them after the handler, so a field the tool does
		// not declare is still logged even though the operation rejects it.
		it('redacts secret fields the tool does not declare', () => {
			const misdirected = redactArgsForTool({ name: 'API_KEY', values: { A: 'plaintext-secret' } }, 'set_secret');
			assert.deepStrictEqual(misdirected, { name: 'API_KEY', values: '[redacted]' });

			const environment = redactArgsForTool({ project: 'application', envelope: 'enc:v1:abc' }, 'set_env_value');
			assert.deepStrictEqual(environment, { project: 'application', envelope: '[redacted]' });
		});

		it('redacts key for SSH-key tools without hiding generic key fields', () => {
			const privateKey = '-----BEGIN OPENSSH PRIVATE KEY-----';
			const input = { name: 'deploy', key: privateKey, Key: privateKey };

			for (const tool of ['add_ssh_key', 'update_ssh_key']) {
				assert.deepStrictEqual(redactArgsForTool(input, tool), {
					name: 'deploy',
					key: '[redacted]',
					Key: '[redacted]',
				});
			}
			assert.deepStrictEqual(redactArgsForTool(input, 'search_by_value'), input);
			assert.equal(input.key, privateKey, 'redaction must not mutate the caller payload');
		});

		it('handles tool names that collide with object prototype properties', () => {
			const input = { key: 'auditable-identifier' };
			assert.deepStrictEqual(redactArgsForTool(input, 'valueOf'), input);
		});

		it('leaves generic value/values fields auditable for non-secret tools', () => {
			const input = { value: 'a-search-term', values: [1, 2, 3], password: 'p' };
			const out = redactArgsForTool(input, 'search_by_value');
			assert.equal(out.value, 'a-search-term');
			assert.deepEqual(out.values, [1, 2, 3]);
			assert.equal(out.password, '[redacted]', 'credential-named fields are still redacted globally');
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
