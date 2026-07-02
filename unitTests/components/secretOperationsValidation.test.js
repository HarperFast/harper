'use strict';

const assert = require('node:assert');
const validator = require('#js/components/operationsValidation');

// validateBySchema returns undefined when valid and an Error when invalid.
const valid = (res) => res === undefined;

// A syntactically valid envelope operand: enc:v1: + base64url body.
const ENVELOPE = 'enc:v1:' + Buffer.from(JSON.stringify({ k: 'a', iv: 'b', ct: 'c', tag: 'd' })).toString('base64url');

describe('secret operation validators', () => {
	describe('setSecretValidator', () => {
		it('accepts name + value', () => {
			assert.ok(valid(validator.setSecretValidator({ name: 'API_KEY', value: 'x' })));
		});

		it('accepts an empty string value', () => {
			assert.ok(valid(validator.setSecretValidator({ name: 'API_KEY', value: '' })));
		});

		it('accepts name + envelope, with metadata and grants', () => {
			assert.ok(
				valid(
					validator.setSecretValidator({
						name: 'API_KEY',
						envelope: ENVELOPE,
						metadata: { env: 'prod' },
						grants: ['my-app'],
					})
				)
			);
		});

		it('rejects both value and envelope together', () => {
			assert.ok(!valid(validator.setSecretValidator({ name: 'A', value: 'x', envelope: ENVELOPE })));
		});

		it('rejects neither value nor envelope', () => {
			assert.ok(!valid(validator.setSecretValidator({ name: 'A' })));
		});

		it('rejects a missing name', () => {
			assert.ok(!valid(validator.setSecretValidator({ value: 'x' })));
		});

		it('rejects a name outside the env-key character set', () => {
			assert.ok(!valid(validator.setSecretValidator({ name: 'A B', value: 'x' })));
			assert.ok(!valid(validator.setSecretValidator({ name: 'A\nB=evil', value: 'x' })));
			assert.ok(!valid(validator.setSecretValidator({ name: 'A=B', value: 'x' })));
		});

		it('rejects an envelope without the enc:v1: marker or with non-base64url body', () => {
			assert.ok(!valid(validator.setSecretValidator({ name: 'A', envelope: 'plaintext' })));
			assert.ok(!valid(validator.setSecretValidator({ name: 'A', envelope: 'enc:v1:{not-base64url}' })));
			assert.ok(!valid(validator.setSecretValidator({ name: 'A', envelope: 'enc:v2:Zm9v' })));
		});

		it('tolerates trailing padding on the base64url envelope body (browser encoders)', () => {
			assert.ok(valid(validator.setSecretValidator({ name: 'A', envelope: ENVELOPE + '=' })));
			assert.ok(valid(validator.setSecretValidator({ name: 'A', envelope: ENVELOPE + '==' })));
			assert.ok(!valid(validator.setSecretValidator({ name: 'A', envelope: ENVELOPE + '===' })));
			assert.ok(!valid(validator.setSecretValidator({ name: 'A', envelope: 'enc:v1:=' })), 'padding-only body');
		});

		it('rejects value/envelope over the 256KiB cap, accepts at the cap', () => {
			const cap = 256 * 1024;
			assert.ok(!valid(validator.setSecretValidator({ name: 'A', value: 'a'.repeat(cap + 1) })));
			assert.ok(!valid(validator.setSecretValidator({ name: 'A', envelope: 'enc:v1:' + 'a'.repeat(cap) })));
			assert.ok(valid(validator.setSecretValidator({ name: 'A', value: 'a'.repeat(cap) })));
		});

		it('rejects non-object metadata and non-array grants', () => {
			assert.ok(!valid(validator.setSecretValidator({ name: 'A', value: 'x', metadata: 'notes' })));
			assert.ok(!valid(validator.setSecretValidator({ name: 'A', value: 'x', grants: 'my-app' })));
			assert.ok(!valid(validator.setSecretValidator({ name: 'A', value: 'x', grants: [''] })));
		});

		it('rejects duplicate grants, >100 grants, and >100 metadata keys', () => {
			assert.ok(!valid(validator.setSecretValidator({ name: 'A', value: 'x', grants: ['web', 'web'] })));
			const many = Array.from({ length: 101 }, (_, i) => `app${i}`);
			assert.ok(!valid(validator.setSecretValidator({ name: 'A', value: 'x', grants: many })));
			const bigMeta = Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`k${i}`, i]));
			assert.ok(!valid(validator.setSecretValidator({ name: 'A', value: 'x', metadata: bigMeta })));
			// ...at the caps passes.
			assert.ok(valid(validator.setSecretValidator({ name: 'A', value: 'x', grants: many.slice(0, 100) })));
		});
	});

	describe('grantSecretValidator (grant_secret / revoke_secret)', () => {
		it('accepts name + component', () => {
			assert.ok(valid(validator.grantSecretValidator({ name: 'API_KEY', component: 'my-app' })));
		});

		it('rejects a missing component', () => {
			assert.ok(!valid(validator.grantSecretValidator({ name: 'API_KEY' })));
		});

		it('rejects an empty component', () => {
			assert.ok(!valid(validator.grantSecretValidator({ name: 'API_KEY', component: '' })));
		});

		it('rejects a bad name', () => {
			assert.ok(!valid(validator.grantSecretValidator({ name: 'A B', component: 'my-app' })));
		});
	});

	describe('deleteSecretValidator', () => {
		it('accepts a valid name', () => {
			assert.ok(valid(validator.deleteSecretValidator({ name: 'API_KEY' })));
		});

		it('rejects a missing or bad name', () => {
			assert.ok(!valid(validator.deleteSecretValidator({})));
			assert.ok(!valid(validator.deleteSecretValidator({ name: 'A B' })));
		});
	});
});
