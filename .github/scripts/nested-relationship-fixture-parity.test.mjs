import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { verifyPeerFixtures } from '../../integrationTests/resources/nested-relationship-docs/github-fixture-fetch.mjs';

test('paired documentation fixtures stay synchronized across repositories', { timeout: 35_000 }, async () => {
	await verifyPeerFixtures({
		localRoot: fileURLToPath(new URL('../../integrationTests/resources/nested-relationship-docs/', import.meta.url)),
		peerRoot: process.env.HARPER_DOCS_FIXTURE_ROOT,
		repository: 'HarperFast/documentation',
		pull: 736,
		peerPath: 'scripts/fixtures/nested-relationship-docs',
	});
});
