'use strict';

const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs/promises');
const os = require('node:os');
const testUtils = require('../testUtils.js');
testUtils.preTestPrep();

const operations = require('#js/components/operations');
const { updateConfigValue } = require('#src/config/configUtils');
const env = require('#src/utility/environment/environmentManager');
const { CONFIG_PARAMS } = require('#src/utility/hdbTerms');

describe('get_components and package URL credentials', () => {
	const COMPONENT = 'redact3985';
	const SECRET = 'npm_unique_secret_3985';
	const PACKAGE = `https://deploy:${SECRET}@registry.example.com/app.tgz`;
	let root;
	let previousRoot;

	before(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), 'package-credentials-'));
		previousRoot = env.get(CONFIG_PARAMS.COMPONENTSROOT);
		env.setProperty(CONFIG_PARAMS.COMPONENTSROOT, root);
		await fs.mkdir(path.join(root, COMPONENT));
		await fs.writeFile(path.join(root, COMPONENT, 'resources.js'), '');
		updateConfigValue(`${COMPONENT}_package`, PACKAGE, undefined, false, false, true);
	});
	after(async () => {
		updateConfigValue(COMPONENT, null, undefined, false, false, true);
		env.setProperty(CONFIG_PARAMS.COMPONENTSROOT, previousRoot);
		await fs.rm(root, { recursive: true, force: true });
	});

	async function packageSeenBy(hdbUser) {
		const { entries } = await operations.getComponents({ hdb_user: hdbUser });
		return entries.find((entry) => entry.name === COMPONENT).package;
	}

	it('hides the credential from a caller who is not a super user', async () => {
		const redacted = 'https://[REDACTED]@registry.example.com/app.tgz';
		assert.strictEqual(await packageSeenBy({ role: { permission: { super_user: false } } }), redacted);
		assert.strictEqual(await packageSeenBy(undefined), redacted);
	});

	it('returns the package as deployed to a super user', async () => {
		assert.strictEqual(await packageSeenBy({ role: { permission: { super_user: true } } }), PACKAGE);
	});
});
