const esbuild = require('esbuild');
const fg = require('fast-glob');
const fs = require('fs-extra');
const path = require('path');
const util = require('util');
const exec = util.promisify(require('child_process').exec);
let cwd_path = path.resolve(__dirname, '../../../');
process.chdir(cwd_path);
let external = ['@*'];
// any module id that starts with a lower case character is considered an external dependency/package
// (all our modules are relative ids, starting with a dot)
for (let i = 97; i < 123; i++) {
	external.push(String.fromCharCode(i) + '*');
}
let entry_modules = [
	'bin/harperdb.js',
	'launchServiceScripts/launchInstallNATSServer.js',
	'launchServiceScripts/launchNatsIngestService.js',
	'launchServiceScripts/launchNatsReplyService.js',
	'server/jobs/jobProcess.js',
	'server/threads/thread-http-server.mjs',
	'utility/scripts/restartHdb.js',
];
for (let entry_module of entry_modules) {
	esbuild.build({
		entryPoints: [entry_module],
		bundle: true,
		platform: 'node',
		minify: true,
		keepNames: true,
		external,
		outfile: path.join('npm_pack', entry_module),
	});
}

(async () => {
	await fs.ensureDir('npm_pack/json');
	for (let filename of await fg([
		'package.json',
		'json/*.json',
		'utility/install/ascii_logo.txt',
		'utility/install/harperdb-config.yaml',
		'config/yaml/*',
		'dependencies/**',
		'README.md',
		'docs/**',
		'logs/*',
	])) {
		let target = path.join('npm_pack', filename);
		await fs.copy(filename, target);
	}
})();
