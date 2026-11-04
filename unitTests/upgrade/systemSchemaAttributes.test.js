'use strict';

const assert = require('node:assert');
const testUtils = require('../testUtils.js');
testUtils.preTestPrep();

const { databases } = require('#src/resources/databases');
const directivesController = require('#src/upgrade/directives/directivesController');
const { UpgradeObject } = require('#src/upgrade/UpgradeObjects');

const attributeNames = (Table) => Table.attributes.map((attribute) => attribute.name);

describe('5.4.0 directive: system-table attributes added after the table was created (harper#2659)', () => {
	before(async () => {
		await testUtils.ensureSystemTables();
	});

	it('runs on every upgrade from a release before 5.4.0', () => {
		for (const from of ['5.1.24', '5.2.15', '5.3.3']) {
			assert.ok(directivesController.getVersionsForUpgrade(new UpgradeObject(from, '5.4.0')).includes('5.4.0'), from);
		}
		assert.ok(!directivesController.getVersionsForUpgrade(new UpgradeObject('5.4.0', '5.4.1')).includes('5.4.0'));
	});

	it('registers activated_from on an hdb_deployment table created without it, indexed as a fresh install has it', async () => {
		await databases.system.hdb_deployment.removeAttributes(['activated_from']);
		assert.ok(!attributeNames(databases.system.hdb_deployment).includes('activated_from'));

		const [registerAttributes] = directivesController.getDirectiveByVersion('5.4.0').async_functions;
		const registered = await registerAttributes();

		assert.deepStrictEqual(registered, ['hdb_deployment.activated_from']);
		const Table = databases.system.hdb_deployment;
		const activatedFrom = Table.attributes.find((attribute) => attribute.name === 'activated_from');
		assert.ok(activatedFrom?.indexed, 'indexed, like the legacy-form attribute a fresh install creates');

		const deploymentId = `upgrade-2659-${process.pid}`;
		await Table.put({ deployment_id: deploymentId, project: 'p', activated_from: 'staged-build' });
		const found = [];
		for await (const row of Table.search([{ attribute: 'activated_from', value: 'staged-build' }])) {
			found.push(row.deployment_id);
		}
		assert.deepStrictEqual(found, [deploymentId]);
		await Table.delete(deploymentId);
	});

	it('changes nothing on a table that already has every attribute', async () => {
		const [registerAttributes] = directivesController.getDirectiveByVersion('5.4.0').async_functions;
		assert.deepStrictEqual(await registerAttributes(), []);
	});
});
