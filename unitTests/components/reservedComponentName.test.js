'use strict';

const assert = require('node:assert');
const fs = require('fs-extra');
const path = require('node:path');
const os = require('node:os');
const env = require('#src/utility/environment/environmentManager');
const { CONFIG_PARAMS } = require('#src/utility/hdbTerms');
const validator = require('#js/components/operationsValidation');
const operations = require('#js/components/operations');
const { isReservedComponentName } = require('#src/utility/componentNames');

// The validators return undefined when valid and an Error when invalid.
describe('reserved component names', () => {
	let ROOT;

	before(() => {
		env.initTestEnvironment();
		ROOT = path.join(os.tmpdir(), `harper-reserved-names-${process.pid}`);
		env.setProperty(CONFIG_PARAMS.COMPONENTSROOT, ROOT);
		fs.ensureDirSync(ROOT);
	});

	after(() => {
		fs.removeSync(ROOT);
	});

	it("reserves 'sql', the root config key that configures the SQL engine", () => {
		assert.ok(isReservedComponentName('sql'));
		assert.ok(!isReservedComponentName('sql-tools'));
		assert.ok(!isReservedComponentName('mysql'));
		// The reserved thing is the YAML root key, which is case-sensitive: `SQL:` is a different
		// entry and collides with nothing.
		assert.ok(!isReservedComponentName('SQL'));
	});

	it('add_component refuses to create a project under a reserved name', () => {
		const error = validator.addComponentValidator({ project: 'sql' });
		assert.ok(error);
		assert.match(error.message, /Component name 'sql' is reserved/);
	});

	it('add_component does not refuse a name that merely contains a reserved one', () => {
		const error = validator.addComponentValidator({ project: 'sql-tools' });
		// May still be rejected for already existing; only the reservation is under test.
		if (error) assert.doesNotMatch(error.message, /is reserved/);
	});

	describe('the file writers, which create the project directory by writing into it', () => {
		const setComponentFile = { project: 'sql', file: 'resources.js', payload: '' };
		const setEnvValue = { project: 'sql', key: 'A', value: 'b' };

		afterEach(() => {
			fs.removeSync(path.join(ROOT, 'sql'));
		});

		it('refuse to bring a reserved-name project into existence', () => {
			for (const error of [
				validator.setComponentFileValidator(setComponentFile),
				validator.setEnvValueValidator(setEnvValue),
			]) {
				assert.ok(error);
				assert.match(error.message, /Component name 'sql' is reserved/);
			}
		});

		it('still write to an application that already holds the name, so it can be migrated', () => {
			fs.ensureDirSync(path.join(ROOT, 'sql'));
			assert.strictEqual(validator.setComponentFileValidator(setComponentFile), undefined);
			assert.strictEqual(validator.setEnvValueValidator(setEnvValue), undefined);
		});
	});

	// The handler derives `project` (canonicalized, or from `package`) before it validates, so each
	// of these is a distinct way to reach the reserved name — all refused before the deploy writes
	// config, ingests credentials, stages a payload, or records a deployment.
	const deployRequests = [
		['an explicit project name', { project: 'sql', package: '@org/sql-app' }],
		['a canonicalized project name', { project: 'sql.tgz', package: '@org/sql-app' }],
		['a project name derived from the package', { package: 'sql' }],
		['a payload deploy, which writes no root config entry', { project: 'sql', payload: 'ZmFrZQ==' }],
		['force, which cannot buy a reserved name', { project: 'sql', package: '@org/sql-app', force: true }],
	];

	for (const [description, request] of deployRequests) {
		it(`deploy_component rejects ${description}`, async () => {
			await assert.rejects(operations.deployComponent(request), (error) => {
				assert.match(error.message, /Component name 'sql' is reserved/);
				assert.strictEqual(error.statusCode, 400);
				return true;
			});
		});
	}
});
