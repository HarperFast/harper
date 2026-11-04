'use strict';

const path = require('path');
const fs = require('fs-extra');

const UNIT_TEST_DIR = __dirname;
const ENV_DIR_PATH = path.join(UNIT_TEST_DIR, 'envDir');
const PID_DIR_PATH = path.join(ENV_DIR_PATH, process.pid.toString());

/**
 * Materializes the per-PID test root — the directory layout config validation expects and
 * harper-config.yaml — idempotently and with no Harper module loaded. Restores the files a
 * mid-run tearDownMockDB() removed; open database handles are NOT restored by this (see
 * ensureSystemTables, which refuses to seed through handles whose files are gone).
 */
function materializePerPidRoot() {
	for (const dir of ['database', 'log', 'components', 'keys']) {
		fs.mkdirSync(path.join(PID_DIR_PATH, dir), { recursive: true });
	}
	// heartbeat for mocha.init.js's stale-root sweep: every suite's setupTestDBPath() lands
	// here, so a live run's root never ages past the sweep's staleness floor, even probed
	// from a PID namespace where this run's PID is not visible
	const now = new Date();
	try {
		fs.utimesSync(PID_DIR_PATH, now, now);
	} catch {}
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

/**
 * Removes this process's per-PID root. Synchronous because it runs from exit handlers,
 * which cannot await — an async removal is scheduled and then dropped by process.exit().
 */
function removePerPidRoot() {
	try {
		fs.removeSync(PID_DIR_PATH);
	} catch {}
}

module.exports = { materializePerPidRoot, removePerPidRoot, ENV_DIR_PATH, PID_DIR_PATH };
