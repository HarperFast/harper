'use strict';

require('../bin/dev.js');
const fs = require('fs');
const path = require('path');
const installer = require('../server/nats/utility/installNATSServer.js');

(async () => {
	try {
		await installer.installer();
	} catch (err) {
		console.error(err);
	}
})();
