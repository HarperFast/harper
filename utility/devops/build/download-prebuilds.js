const util = require('util');
const exec = util.promisify(require('child_process').exec);
const {
	downloadNATSServer,
	ALL_SUPPORTED_PLATFORM_ARCHITECTURES,
} = require('../../../server/nats/utility/installNATSServer.js');

(async function () {
	// need prebuildify-ci for the downloads to run
	let output = await exec('npm install -g prebuildify-ci');
	console.error(output.stderr);
	console.log(output.stdout);
	// download lmdb (and msgpackr-extract) binaries
	output = await exec('download-lmdb-prebuilds');
	console.error(output.stderr);
	console.log(output.stdout);
	// download all the NATS binaries
	for (let [platform, architecture] of ALL_SUPPORTED_PLATFORM_ARCHITECTURES) {
		await downloadNATSServer(platform, architecture);
	}
})();
