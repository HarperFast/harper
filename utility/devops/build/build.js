const esbuild = require('esbuild');
const fg = require('fast-glob');
const fs = require('fs-extra');
const path = require('path');
const util = require('util');
const { PACKAGE_ROOT } = require('../../hdbTerms');
const { spawnSync, exec } = require('child_process');
let cwd_path = path.resolve(__dirname, '../../../');
process.chdir(cwd_path);
// we define externals to ensure that we don't load packages (from node_modules)
// we also explicitly define index as an external so that it can be preserved as an independent
// module that users can load and will have the correct exports injected into it.
let external = ['@*', './index'];
// any module id that starts with a lower case character is considered an external dependency/package
// (all our modules are relative ids, starting with a dot)
for (let i = 97; i < 123; i++) {
	external.push(String.fromCharCode(i) + '*');
}
let entry_modules = [
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
for (let entry_module of entry_modules) {
	let outfile = path.join('npm_pack', entry_module);
	esbuild
		.build({
			entryPoints: [entry_module],
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
	await fs.ensureDir('npm_pack/json');
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
	])) {
		let target = path.join('npm_pack', filename);
		await fs.copy(filename, target);
	}
})();
fs.copy('index.js', 'npm_pack/index.js');

/* This seems like it would be better, but the exec is working
spawnSync(
	process.argv[0],
	[
		path.join(PACKAGE_ROOT, 'node_modules/.bin/tsc'),
		'--outFile',
		'npm_pack/index.d.ts',
		'--declaration',
		'--emitDeclarationOnly',
	],
	{ cwd: PACKAGE_ROOT }
);*/
let result = exec('tsc entry.ts --outDir npm_pack --declaration --emitDeclarationOnly', async (error, result) => {
	if (error) {
		if (error.code !== 2) console.error(error);
	} else {
		if (result.stdout.length) console.log(result.stdout.toString());
		if (result.stderr.length) console.log(result.stderr.toString());
	}
	await fs.copy('npm_pack/entry.d.ts', 'npm_pack/index.d.ts');
	fs.unlink('npm_pack/entry.d.ts');
});
