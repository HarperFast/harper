'use strict';

const fs = require('fs');
const path = require('path');
const compiled_nats_install_script = path.resolve(__dirname, '../server/nats/utility/installNATSServer.jsc');
let installer;
try {
	fs.accessSync(compiled_nats_install_script);
	require('bytenode');
	installer = require(compiled_nats_install_script);
} catch (e) {
	const nats_install_script = path.resolve(__dirname, '../server/nats/utility/installNATSServer');
	installer = require(nats_install_script);
}

(async () => {
	try {
		await installer.installer();
	} catch (err) {
		console.error(err);
	}
})();
