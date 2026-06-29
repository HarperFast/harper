'use strict';

const assert = require('node:assert');
const fs = require('fs-extra');
const path = require('node:path');
const os = require('node:os');
const { parse } = require('dotenv');
const env = require('#src/utility/environment/environmentManager');
const { CONFIG_PARAMS } = require('#src/utility/hdbTerms');
const operations = require('#js/components/operations');

// Exercises the env operation handlers end-to-end against a real temporary components root.
// `server.replication.replicateOperation` resolves to a no-op in the unit environment, so set/
// delete go through their full read -> merge -> write path without a cluster.
describe('env operations (handlers)', () => {
	const PROJECT = 'env-ops-app';
	let ROOT;
	const projectDir = () => path.join(ROOT, PROJECT);
	const envPath = () => path.join(projectDir(), '.env');
	const INITIAL = '# secrets\nAPI_KEY=secret123\nDB_URL=postgres://u:p@h/db\n';

	before(() => {
		env.initTestEnvironment();
		ROOT = path.join(os.tmpdir(), `harper-env-ops-${process.pid}`);
		env.setProperty(CONFIG_PARAMS.COMPONENTSROOT, ROOT);
		fs.ensureDirSync(projectDir());
	});

	after(() => {
		fs.removeSync(ROOT);
	});

	beforeEach(() => {
		fs.outputFileSync(envPath(), INITIAL);
	});

	describe('get_env_keys', () => {
		it('returns key names only and never the values', async () => {
			const result = await operations.getEnvKeys({ project: PROJECT, file: '.env' });
			assert.deepEqual(result.keys, ['API_KEY', 'DB_URL']);
			assert.ok(!JSON.stringify(result).includes('secret123'), 'must not leak a value');
		});

		it('defaults to .env when file is omitted', async () => {
			const result = await operations.getEnvKeys({ project: PROJECT });
			assert.equal(result.file, '.env');
			assert.deepEqual(result.keys, ['API_KEY', 'DB_URL']);
		});

		it('rejects a non-.env file', async () => {
			await assert.rejects(() => operations.getEnvKeys({ project: PROJECT, file: 'config.yaml' }), /not a \.env file/);
		});

		it('throws when the file does not exist', async () => {
			await assert.rejects(
				() => operations.getEnvKeys({ project: PROJECT, file: '.env.missing' }),
				/Component file not found/
			);
		});
	});

	describe('get_component_file (masking)', () => {
		it('masks values and exposes only key names for a .env file', async () => {
			const result = await operations.getComponentFile({ project: PROJECT, file: '.env' });
			assert.equal(result.protected, true);
			assert.deepEqual(result.keys, ['API_KEY', 'DB_URL']);
			assert.ok(!result.message.includes('secret123'), 'masked body must not leak a value');
			assert.ok(result.message.includes('API_KEY=********'));
		});
	});

	describe('set_env_value', () => {
		it('overwrites a single key, leaving the others and comments intact', async () => {
			const result = await operations.setEnvValue({ project: PROJECT, key: 'API_KEY', value: 'rotated' });
			const parsed = parse(fs.readFileSync(envPath(), 'utf8'));
			assert.equal(parsed.API_KEY, 'rotated');
			assert.equal(parsed.DB_URL, 'postgres://u:p@h/db'); // untouched
			assert.ok(fs.readFileSync(envPath(), 'utf8').includes('# secrets'), 'comment preserved');
			assert.deepEqual(result.keys, ['API_KEY', 'DB_URL']);
		});

		it('adds new keys without disturbing existing ones', async () => {
			await operations.setEnvValue({ project: PROJECT, values: { NEW_ONE: 'a', NEW_TWO: 'b' } });
			const parsed = parse(fs.readFileSync(envPath(), 'utf8'));
			assert.deepEqual(parsed, { API_KEY: 'secret123', DB_URL: 'postgres://u:p@h/db', NEW_ONE: 'a', NEW_TWO: 'b' });
		});

		it('creates the .env file when the project has none', async () => {
			const freshProject = 'env-ops-fresh';
			await operations.setEnvValue({ project: freshProject, key: 'FIRST', value: '1' });
			const parsed = parse(fs.readFileSync(path.join(ROOT, freshProject, '.env'), 'utf8'));
			assert.deepEqual(parsed, { FIRST: '1' });
		});

		it('round-trips a value with special characters (proves runtime reads the real value)', async () => {
			const secret = 'p@ss w#rd"x';
			await operations.setEnvValue({ project: PROJECT, key: 'API_KEY', value: secret });
			assert.equal(parse(fs.readFileSync(envPath(), 'utf8')).API_KEY, secret);
		});
	});

	describe('delete_env_value', () => {
		it('removes a single key, leaving the rest', async () => {
			await operations.deleteEnvValue({ project: PROJECT, key: 'DB_URL' });
			const parsed = parse(fs.readFileSync(envPath(), 'utf8'));
			assert.deepEqual(parsed, { API_KEY: 'secret123' });
		});

		it('throws when the file does not exist', async () => {
			await assert.rejects(
				() => operations.deleteEnvValue({ project: PROJECT, file: '.env.missing', key: 'A' }),
				/Component file not found/
			);
		});
	});

	describe('set_component_file (blocking)', () => {
		it('refuses to overwrite a .env file and points at set_env_value', async () => {
			await assert.rejects(
				() => operations.setComponentFile({ project: PROJECT, file: '.env', payload: 'API_KEY=********' }),
				/set_env_value/
			);
			// the real values must be untouched by the rejected write
			assert.equal(parse(fs.readFileSync(envPath(), 'utf8')).API_KEY, 'secret123');
		});
	});

	describe('template env files are not protected', () => {
		const EXAMPLE = '# template\nAPI_KEY=your-key-here\nDB_URL=\n';
		const examplePath = () => path.join(projectDir(), '.env.example');

		beforeEach(() => {
			fs.outputFileSync(examplePath(), EXAMPLE);
		});

		it('get_component_file returns the verbatim contents (no masking)', async () => {
			const result = await operations.getComponentFile({ project: PROJECT, file: '.env.example' });
			assert.equal(result.message, EXAMPLE);
			assert.equal(result.protected, undefined);
			assert.equal(result.keys, undefined);
		});

		it('set_component_file may overwrite it like any normal file', async () => {
			const payload = 'API_KEY=your-key-here\nNEW=placeholder\n';
			const result = await operations.setComponentFile({ project: PROJECT, file: '.env.example', payload });
			assert.match(result.message, /Successfully set component: \.env\.example/);
			assert.equal(fs.readFileSync(examplePath(), 'utf8'), payload);
		});
	});
});
