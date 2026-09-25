'use strict';

/**
 * mocha.init.js exports ROOTPATH so that every config and logger resolution in a unit run lands in the per-PID root.
 * A suite that exercises boot-props-based resolution, which that export shadows, clears it for its own scope — and
 * must not then resolve the boot properties an installed Harper left in ~/.harperdb, or getConfigFilePath() answers
 * that install's harper-config.yaml and whatever the scope writes through it rewrites the developer's config. So the
 * scope also gets an empty home directory: boot-props resolution there finds no properties, as on a CI runner, and a
 * test that needs some stubs getPropsFilePath() or writes them into that home.
 */

const fs = require('fs-extra');
const os = require('node:os');
const path = require('node:path');
const commonUtils = require('#src/utility/common_utils');

// os.homedir() reads USERPROFILE on Windows and HOME elsewhere
const HOME_ENV_KEYS = ['HOME', 'USERPROFILE'];

/** Register hooks, inside a `describe`, that clear ROOTPATH and hide the installed boot properties for its scope. */
function clearRootPath() {
	let savedEnv;
	let emptyHome;
	before(() => {
		savedEnv = Object.fromEntries(['ROOTPATH', ...HOME_ENV_KEYS].map((key) => [key, process.env[key]]));
		emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'harper-empty-home-'));
		delete process.env.ROOTPATH;
		for (const key of HOME_ENV_KEYS) process.env[key] = emptyHome;
		commonUtils.resetNoBootFileCache();
	});
	after(() => {
		for (const [key, value] of Object.entries(savedEnv)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		commonUtils.resetNoBootFileCache();
		fs.removeSync(emptyHome);
	});
}

module.exports = { clearRootPath };
