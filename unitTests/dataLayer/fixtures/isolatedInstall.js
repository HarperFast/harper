'use strict';
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const YAML = require('yaml');

/** Modules a script can load by name: `require(paths.<name>)`. */
const paths = {
	env: require.resolve('#src/utility/environment/environmentManager'),
	mountHdb: require.resolve('#src/utility/mount_hdb'),
	databases: require.resolve('#src/resources/databases'),
	analytics: require.resolve('#src/resources/analytics/write'),
	rocksdbBackup: require.resolve('#src/dataLayer/rocksdbBackup'),
	restoreMarker: require.resolve('#src/dataLayer/restoreMarker'),
	restoreReceipt: require.resolve('#src/dataLayer/restoreReceipt'),
	restoreChildRunner: require.resolve('#src/dataLayer/restoreChildRunner'),
	durableFile: require.resolve('#src/utility/durableFile'),
	fixture: require.resolve('./harperDatabase.js'),
};

/**
 * A Harper install root of its own — config, storage, backups — that only processes spawned through
 * `run` ever open. A test that needs a fresh process (an offline CLI run, a process killed mid-restore)
 * must not share databases with the mocha process: a handle mocha holds, `system` included, is a LOCK
 * the spawned process cannot take, and closing mocha's own `system` strands every module bound to it.
 */
function isolatedInstall() {
	const root = mkdtempSync(join(tmpdir(), 'harper.unit-test.isolated-install-'));
	const scripts = mkdtempSync(join(tmpdir(), 'harper.unit-test.isolated-install-scripts-'));
	for (const dir of ['database', 'log', 'components', 'keys']) mkdirSync(join(root, dir), { recursive: true });
	const config = YAML.parseDocument(readFileSync(join(__dirname, '../../../static/defaultConfig.yaml'), 'utf8'));
	config.setIn(['rootPath'], root);
	config.setIn(['componentsRoot'], 'components');
	config.setIn(['logging', 'root'], 'log');
	config.setIn(['logging', 'rotation', 'path'], 'log');
	config.setIn(['storage', 'path'], 'database');
	writeFileSync(join(root, 'harper-config.yaml'), config.toString());
	let runs = 0;

	/**
	 * Runs `body` — the inside of an async function that can use `paths` and `report(value)` — in a fresh
	 * Node process rooted at this install, from a file (the restore child is forked with its parent's exec
	 * arguments). Resolves with `{ code, signal, report, stderr }` once it exits.
	 */
	async function run(body, { timeout = 60000 } = {}) {
		const label = `run-${++runs}`;
		const script = join(scripts, `${label}.cjs`);
		const resultFile = join(scripts, `${label}.json`);
		writeFileSync(
			script,
			`
			const { writeFileSync } = require('node:fs');
			const paths = ${JSON.stringify(paths)};
			const report = (value) => writeFileSync(${JSON.stringify(resultFile)}, JSON.stringify(value));
			require(paths.env).initSync();
			require(paths.analytics).setAnalyticsEnabled(false);
			(async () => {
				${body}
			})().then(
				() => process.exit(0),
				(error) => {
					console.error(error);
					process.exit(1);
				}
			);
			`
		);
		const env = { ...process.env, ROOTPATH: root };
		delete env.STORAGE_PATH;
		delete env.SCHEMAS_DATA_PATH;
		const child = spawn(process.execPath, [script], { env, timeout });
		let stderr = '';
		child.stderr.on('data', (data) => (stderr += data));
		const [code, signal] = await new Promise((resolve, reject) => {
			child.once('error', reject);
			child.once('exit', (exitCode, exitSignal) => resolve([exitCode, exitSignal]));
		});
		const report = existsSync(resultFile) ? JSON.parse(readFileSync(resultFile, 'utf8')) : undefined;
		return { code, signal, report, stderr };
	}

	/** `run`, for a script that must exit cleanly with a report. */
	async function runToReport(body, options) {
		const { code, signal, report, stderr } = await run(body, options);
		assert.strictEqual(code, 0, `the script exited ${signal ?? code}: ${stderr}`);
		assert.notStrictEqual(report, undefined, `the script reported nothing: ${stderr}`);
		return report;
	}

	function remove() {
		rmSync(root, { recursive: true, force: true });
		rmSync(scripts, { recursive: true, force: true });
	}

	return { root, run, runToReport, remove };
}

module.exports = { isolatedInstall };
