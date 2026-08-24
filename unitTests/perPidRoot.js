'use strict';

const path = require('path');
const fs = require('fs-extra');

const UNIT_TEST_DIR = __dirname;
const ENV_DIR_PATH = path.join(UNIT_TEST_DIR, 'envDir');
const PID_DIR_PATH = path.join(ENV_DIR_PATH, process.pid.toString());

/**
 * Materializes the per-PID test root — the directory layout config validation expects and
 * harper-config.yaml — idempotently and with no Harper module loaded. A mid-run
 * tearDownMockDB() removes the whole root, so seeding re-runs this before touching config.
 */
function materializePerPidRoot() {
	for (const dir of ['database', 'log', 'components', 'keys']) {
		fs.mkdirSync(path.join(PID_DIR_PATH, dir), { recursive: true });
	}
	const configFilePath = path.join(PID_DIR_PATH, 'harper-config.yaml');
	if (!fs.existsSync(configFilePath)) {
		const YAML = require('yaml');
		const configDoc = YAML.parseDocument(
			fs.readFileSync(path.join(UNIT_TEST_DIR, '../static/defaultConfig.yaml'), 'utf8')
		);
		configDoc.setIn(['rootPath'], PID_DIR_PATH);
		// resolve the path fields the installer's config validation would otherwise fill in
		configDoc.setIn(['componentsRoot'], 'components');
		configDoc.setIn(['logging', 'root'], 'log');
		configDoc.setIn(['logging', 'rotation', 'path'], 'log');
		configDoc.setIn(['storage', 'path'], 'database');
		fs.writeFileSync(configFilePath, configDoc.toString());
	}
	return PID_DIR_PATH;
}

module.exports = { materializePerPidRoot, ENV_DIR_PATH, PID_DIR_PATH };
