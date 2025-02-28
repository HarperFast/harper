'use strict';

require('../bin/dev');
const fs = require('fs');
const path = require('path');
const installer = require('../server/nats/utility/installNATSServer');

(async () => {
	try {
		await installer.installer();
	} catch (err) {
		console.error(err);
	}
})();
