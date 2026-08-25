'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const environment = require('#src/utility/environment/environmentManager');
const hdbTerms = require('#src/utility/hdbTerms');
const { getHdbPid, isProcessRunning } = require('#js/utility/processManagement/processManagement');

describe('process management PID file', () => {
	let originalHdbPath;
	let testHdbPath;

	before(() => {
		originalHdbPath = environment.getHdbBasePath();
		testHdbPath = fs.mkdtempSync(path.join(os.tmpdir(), 'harper-pid-test-'));
		environment.setHdbBasePath(testHdbPath);
	});

	after(() => {
		environment.setHdbBasePath(originalHdbPath);
		fs.rmSync(testHdbPath, { force: true, recursive: true });
	});

	it('treats PID 1 as stale when an init process owns it', () => {
		assert.equal(isProcessRunning(1), true);
		fs.writeFileSync(path.join(testHdbPath, hdbTerms.HDB_PID_FILE), '1\n');
		assert.equal(getHdbPid(), undefined);
	});
});
