const esbuild = require('esbuild');
const fg = require('fast-glob');
const fs = require('fs-extra');
const path = require('path');
const { exec } = require('child_process');

let cwdPath = path.resolve(__dirname, '../../../');
process.chdir(cwdPath);
// we define externals to ensure that we don't load packages (from nodeModules)
// we also explicitly define index as an external so that it can be preserved as an independent
// module that users can load and will have the correct exports injected into it.
let external = ['@*', './index'];
// any module id that starts with a lower case character is considered an external dependency/package
// (all our modules are relative ids, starting with a dot)
for (let i = 97; i < 123; i++) {
	external.push(String.fromCharCode(i) + '*');
}
let entryModules = [
	'bin/harperdb.js',
	'bin/lite.js',
	'launchServiceScripts/launchInstallNATSServer.js',
	'launchServiceScripts/launchNatsIngestService.js',
	'launchServiceScripts/launchNatsReplyService.js',
	'launchServiceScripts/launchUpdateNodes4-0-0.js',
	'server/jobs/jobProcess.js',
	'server/threads/threadServer.js',
	'utility/scripts/restartHdb.js',
];
for (let entryModule of entryModules) {
	let outfile = path.join('npm_pack', entryModule);
	esbuild
		.build({
			entryPoints: [entryModule],
			bundle: true,
			platform: 'node',
			minify: true,
			keepNames: true,
			external,
			outfile,
		})
		.then(() => {
			fs.writeFileSync(outfile, fs.readFileSync(outfile, 'utf8').replaceAll('../../index', '../index'));
		});
}

(async () => {
	fs.ensureDirSync('npm_pack/json');
	for (let filename of await fg([
		'package.json',
		'json/*.json',
		'utility/install/ascii_logo.txt',
		'utility/install/harperdb-config.yaml',
		'utility/install/README.md',
		'config/yaml/*',
		'dependencies/**',
		'README.md',
		'docs/**',
		'logs/*',
		'studio/**',
		'index.d.ts',
	])) {
		let target = path.join('npm_pack', filename);
		fs.copySync(filename, target);
	}
})();
fs.copySync('index.js', 'npm_pack/index.js');
