'use strict';

const assert = require('node:assert');
const { deploymentSource, attestedSource } = require('#src/components/deploymentSource');

describe("a deployment's source (harper#3061)", () => {
	const attested = attestedSource('my-app-prod', {
		repository: 'HarperFast/my-app',
		sha: 'a'.repeat(40),
		run_id: 99,
		sub: 'repo:HarperFast/my-app:environment:production',
	});

	it('records what an OIDC exchange attested, and nothing else the token carried', () => {
		assert.deepStrictEqual(deploymentSource(attested, { sha: 'b'.repeat(40), dirty: true }), {
			via: 'oidc',
			policy: 'my-app-prod',
			repository: 'HarperFast/my-app',
			sha: 'a'.repeat(40),
			run_id: '99',
		});
	});

	it('records what a client declared as declared, even when it claims otherwise', () => {
		assert.deepStrictEqual(
			deploymentSource(undefined, { via: 'oidc', policy: 'forged', sha: 'b'.repeat(40), dirty: false, extra: 1 }),
			{ via: 'declared', sha: 'b'.repeat(40), dirty: false }
		);
	});

	it('records nothing when there is nothing to say, or what is said is not a source', () => {
		for (const declared of [undefined, null, 'abc', [], {}, { extra: 'x' }]) {
			assert.strictEqual(deploymentSource(undefined, declared), null, JSON.stringify(declared));
		}
		assert.strictEqual(deploymentSource({ via: 'declared', policy: 'p' }, undefined), null);
	});

	it('bounds each field', () => {
		assert.strictEqual(deploymentSource(undefined, { ref: 'x'.repeat(10_000) }).ref.length, 512);
	});
});
