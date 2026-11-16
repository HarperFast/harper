'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const commonUtils = require('#src/utility/common_utils');
const configUtils = require('#src/config/configUtils');
const env = require('#src/utility/environment/environmentManager');

describe('environmentManager reloadSync()', function () {
	let originalRootPath;
	let rootPath;
	let configFilePath;
	let validConfig;

	beforeEach(function () {
		originalRootPath = process.env.ROOTPATH;
		rootPath = fs.mkdtempSync(path.join(os.tmpdir(), 'harper-reload-sync-'));
		configFilePath = path.join(rootPath, 'harperdb-config.yaml');
		validConfig = fs
			.readFileSync(path.join(__dirname, '../../../static/defaultConfig.yaml'), 'utf8')
			.replace(/^rootPath: null$/m, `rootPath: ${JSON.stringify(rootPath)}`);
		fs.writeFileSync(configFilePath, validConfig);
		process.env.ROOTPATH = rootPath;
		commonUtils.resetNoBootFileCache();
		env.reloadSync();
	});

	afterEach(function () {
		// initSync(true) below exits the process on a config it cannot read
		if (rootPath && validConfig) fs.writeFileSync(configFilePath, validConfig);
		if (originalRootPath === undefined) delete process.env.ROOTPATH;
		else process.env.ROOTPATH = originalRootPath;
		commonUtils.resetNoBootFileCache();
		env.initSync(true);
		if (rootPath) fs.rmSync(rootPath, { recursive: true, force: true });
	});

	it('adopts a component entry another thread wrote to the file', function () {
		assert.strictEqual(configUtils.getConfigObj()['late-isolated'], undefined);
		fs.writeFileSync(configFilePath, `${validConfig}\nlate-isolated:\n  package: late-isolated\n`);

		env.reloadSync();

		assert.deepStrictEqual(configUtils.getConfigObj()['late-isolated'], { package: 'late-isolated' });
	});

	it('throws on a file it cannot parse, keeping the config the thread had', function () {
		const active = configUtils.getConfigObj();
		fs.writeFileSync(configFilePath, `${validConfig}\nlate-isolated:\n  package: late-isolated\ninvalid: [\n`);

		assert.throws(() => env.reloadSync(), /Error parsing/);
		assert.strictEqual(configUtils.getConfigObj(), active);
	});

	it('throws when the file is missing, where initConfig would return without reading anything', function () {
		const active = configUtils.getConfigObj();
		fs.rmSync(configFilePath);

		assert.throws(() => env.reloadSync(), /does not exist/);
		assert.strictEqual(configUtils.getConfigObj(), active);
	});
});
