'use strict';

const assert = require('node:assert');
const path = require('node:path');
const { packageCandidates } = require('#src/components/packageCandidates');

describe('packageCandidates', () => {
	const root = path.parse(process.cwd()).root;
	const at = (...segments) => path.join(root, ...segments);

	it('walks up from the component to the filesystem root when the component is outside Harper', () => {
		assert.deepStrictEqual(
			[...packageCandidates(at('work', 'app'), '@scope/plugin', at('harper'))],
			[
				at('work', 'app', 'node_modules', '@scope', 'plugin'),
				at('work', 'node_modules', '@scope', 'plugin'),
				at('node_modules', '@scope', 'plugin'),
			]
		);
	});

	it('stops at the Harper root for a component inside it', () => {
		assert.deepStrictEqual(
			[...packageCandidates(at('harper', 'components', 'app'), 'plugin', at('harper'))],
			[
				at('harper', 'components', 'app', 'node_modules', 'plugin'),
				at('harper', 'components', 'node_modules', 'plugin'),
				at('harper', 'node_modules', 'plugin'),
			]
		);
	});

	it('does not count a sibling directory that shares the Harper root as a prefix as inside it', () => {
		assert.deepStrictEqual(
			[...packageCandidates(at('harper-dev', 'app'), 'plugin', at('harper'))],
			[
				at('harper-dev', 'app', 'node_modules', 'plugin'),
				at('harper-dev', 'node_modules', 'plugin'),
				at('node_modules', 'plugin'),
			]
		);
	});
});
