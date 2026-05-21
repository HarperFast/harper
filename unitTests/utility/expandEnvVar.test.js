'use strict';

const assert = require('node:assert/strict');
const { expandEnvVar, expandEnvVarsDeep, isUnresolvedEnvVarPlaceholder } = require('#src/utility/expandEnvVar');

describe('expandEnvVar', () => {
	const SET_VAR = '__HARPER_TEST_EXPAND_SET__';
	const UNSET_VAR = '__HARPER_TEST_EXPAND_UNSET__';

	before(() => {
		process.env[SET_VAR] = 'expanded-value';
		delete process.env[UNSET_VAR];
	});
	after(() => {
		delete process.env[SET_VAR];
	});

	describe('expandEnvVar (single value)', () => {
		it(`resolves \${${SET_VAR}} to the env value`, () => {
			assert.strictEqual(expandEnvVar(`\${${SET_VAR}}`), 'expanded-value');
		});

		it('returns the original string when the env var is unset', () => {
			assert.strictEqual(expandEnvVar(`\${${UNSET_VAR}}`), `\${${UNSET_VAR}}`);
		});

		it('returns plain strings unchanged', () => {
			assert.strictEqual(expandEnvVar('literal-string'), 'literal-string');
		});

		it('does NOT expand partial-string placeholders (whole-string only)', () => {
			assert.strictEqual(expandEnvVar(`http://\${${SET_VAR}}:9926`), `http://\${${SET_VAR}}:9926`);
		});

		it('treats placeholders with internal whitespace as literals (not lookups)', () => {
			// Env var names can't contain whitespace; treat such strings as
			// literal values rather than failed lookups that confuse downstream
			// "is this an unresolved placeholder?" checks.
			assert.strictEqual(expandEnvVar('${MY KEY}'), '${MY KEY}');
		});

		it('returns non-string values unchanged', () => {
			assert.strictEqual(expandEnvVar(123), 123);
			assert.strictEqual(expandEnvVar(true), true);
			assert.strictEqual(expandEnvVar(null), null);
			assert.strictEqual(expandEnvVar(undefined), undefined);
		});

		it('uses env value even when it is the empty string (operator may want empty default)', () => {
			process.env[SET_VAR] = '';
			try {
				assert.strictEqual(expandEnvVar(`\${${SET_VAR}}`), '');
			} finally {
				process.env[SET_VAR] = 'expanded-value';
			}
		});
	});

	describe('expandEnvVarsDeep (recursive)', () => {
		// Helper: deep value-equal comparison that ignores prototype shape.
		// `expandEnvVarsDeep` returns null-prototype objects (anti-pollution
		// defense); JSON.parse(JSON.stringify(...)) round-trips to plain
		// objects for assertion convenience without leaking prototype-pollution
		// gadgets (JSON parses don't honor `__proto__` setters either).
		const plain = (value) => JSON.parse(JSON.stringify(value));

		it('walks plain objects, expanding string leaves', () => {
			const input = {
				backend: 'openai',
				apiKey: `\${${SET_VAR}}`,
				nested: { model: 'gpt-4o', baseUrl: 'https://api.openai.com/v1' },
			};
			assert.deepStrictEqual(plain(expandEnvVarsDeep(input)), {
				backend: 'openai',
				apiKey: 'expanded-value',
				nested: { model: 'gpt-4o', baseUrl: 'https://api.openai.com/v1' },
			});
		});

		it('walks arrays, expanding each element', () => {
			const input = [`\${${SET_VAR}}`, 'literal', { a: `\${${SET_VAR}}` }];
			assert.deepStrictEqual(plain(expandEnvVarsDeep(input)), ['expanded-value', 'literal', { a: 'expanded-value' }]);
		});

		it('leaves placeholders pointing at unset env vars unchanged', () => {
			const input = { apiKey: `\${${UNSET_VAR}}`, model: 'gpt-4o' };
			assert.deepStrictEqual(plain(expandEnvVarsDeep(input)), {
				apiKey: `\${${UNSET_VAR}}`,
				model: 'gpt-4o',
			});
		});

		it('passes through scalars unchanged', () => {
			assert.strictEqual(expandEnvVarsDeep(42), 42);
			assert.strictEqual(expandEnvVarsDeep(true), true);
			assert.strictEqual(expandEnvVarsDeep(null), null);
		});

		it('does not introduce shared references between input and output (object case)', () => {
			const input = { apiKey: `\${${SET_VAR}}`, nested: { x: 1 } };
			const output = expandEnvVarsDeep(input);
			assert.notStrictEqual(output, input);
			assert.notStrictEqual(output.nested, input.nested);
		});

		it('does not pollute Object.prototype via __proto__ keys in input', () => {
			// The reusable framing of this util invites callers to feed it
			// untrusted-source objects (e.g., JSON-from-HTTP). Defending here
			// keeps that future caller safe.
			const malicious = JSON.parse('{"__proto__": {"polluted": true}, "ok": "fine"}');
			const output = expandEnvVarsDeep(malicious);
			// Walk the prototype chain explicitly: nothing should have been
			// added to Object.prototype.
			assert.strictEqual({}.polluted, undefined);
			// The key is still preserved as an own property on the output
			// (since we used Object.create(null), no prototype-setter shenanigans).
			assert.ok(Object.prototype.hasOwnProperty.call(output, '__proto__'));
			assert.strictEqual(output.ok, 'fine');
		});
	});

	describe('isUnresolvedEnvVarPlaceholder', () => {
		it('returns true for a literal ${VAR_NAME} string', () => {
			assert.strictEqual(isUnresolvedEnvVarPlaceholder('${OPENAI_API_KEY}'), true);
		});

		it('returns false for a real string value', () => {
			assert.strictEqual(isUnresolvedEnvVarPlaceholder('sk-real-key'), false);
		});

		it('returns false for partial-string placeholders (not what expandEnvVar matches)', () => {
			assert.strictEqual(isUnresolvedEnvVarPlaceholder('http://${HOST}:9926'), false);
		});

		it('returns false for non-string values', () => {
			assert.strictEqual(isUnresolvedEnvVarPlaceholder(undefined), false);
			assert.strictEqual(isUnresolvedEnvVarPlaceholder(null), false);
			assert.strictEqual(isUnresolvedEnvVarPlaceholder(123), false);
		});

		it('returns false for placeholders containing a space (not a valid env var name)', () => {
			assert.strictEqual(isUnresolvedEnvVarPlaceholder('${VAR NAME}'), false);
		});
	});
});
