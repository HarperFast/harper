const util = require('util');
const exec = util.promisify(require('child_process').exec);

(async function () {
	// need prebuildify-ci for the downloads to run
	let output = await exec('npm install -g prebuildify-ci');
	console.error(output.stderr);
	console.log(output.stdout);
	// download lmdb (and msgpackr-extract) binaries
	output = await exec('download-lmdb-prebuilds');
	console.error(output.stderr);
	console.log(output.stdout);
})();
