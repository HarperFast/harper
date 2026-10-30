'use strict';

const assert = require('node:assert');

const { formatDeploymentProvenance, parseDeploymentProvenance } = require('#src/components/deploymentProvenance');

describe('deployment provenance', () => {
	it('reads back the id it wrote, for the component it wrote it for', () => {
		assert.strictEqual(parseDeploymentProvenance(formatDeploymentProvenance('web', 'd1'), 'web'), 'd1');
	});

	it('records nothing usable for a different component, version, or shape', () => {
		const cases = {
			'another component': [formatDeploymentProvenance('api', 'd1'), 'web'],
			'another version': [JSON.stringify({ v: 2, component: 'web', deploymentId: 'd1' }), 'web'],
			'no id': [JSON.stringify({ v: 1, component: 'web' }), 'web'],
			'a non-string id': [JSON.stringify({ v: 1, component: 'web', deploymentId: 7 }), 'web'],
			'not JSON': ['{"v":1,', 'web'],
			'not an object': ['null', 'web'],
		};
		for (const [label, [raw, component]] of Object.entries(cases)) {
			assert.strictEqual(parseDeploymentProvenance(raw, component), undefined, label);
		}
	});

	it('refuses an id that is not a single path segment, or that could name a claim or other staging entry', () => {
		// The id becomes `.deploy-staging/<id>`: a separator or a traversal would reach outside it, and a dot-prefixed
		// name is one of the staging root's own entries.
		for (const deploymentId of ['', '../escape', 'a/b', '.', '..', '.claiming-x-web']) {
			const raw = JSON.stringify({ v: 1, component: 'web', deploymentId });
			assert.strictEqual(parseDeploymentProvenance(raw, 'web'), undefined, JSON.stringify(deploymentId));
		}
	});
});
