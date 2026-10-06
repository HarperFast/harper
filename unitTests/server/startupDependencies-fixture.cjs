'use strict';

// Runs in a fresh process so nothing another test loaded is already in the require cache.
const modules = [
	'#src/resources/databases',
	'#src/resources/auditStore',
	'#src/resources/RocksTransactionLogStore',
	'#src/resources/replayLogs',
	'#src/resources/Table',
	'#src/resources/roles',
	'#src/bin/copyDb',
	'#src/config/configUtils',
	'#src/config/harperConfigEnvVars',
	'#src/components/OptionsWatcher',
	'#src/security/keys',
	'#src/security/user',
	'#src/security/certificateVerification/index',
	'#src/utility/common_utils',
	'#src/utility/environment/systemInformation',
	'#src/utility/lmdb/environmentUtility',
	'#src/dataLayer/delete',
	'#src/dataLayer/harperBridge/lmdbBridge/lmdbMethods/lmdbGetBackup',
	'#src/server/jobs/jobs',
	'#src/validation/readLogValidator',
	'#src/validation/searchValidator',
];
for (const module of modules) require(module);
const packages = new Set();
for (const path of Object.keys(require.cache)) {
	const match = path.match(/\/node_modules\/((?:@[^/]+\/)?[^/]+)\/(.*)$/);
	if (match) packages.add(match[2] === 'lodash.js' ? 'lodash (full build)' : match[1]);
}
process.stdout.write(JSON.stringify([...packages]));
process.exit(0);
