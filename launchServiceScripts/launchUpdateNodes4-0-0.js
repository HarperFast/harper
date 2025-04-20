'use strict';

const updateNodes400 = require('../upgrade/nats/updateNodes4-0-0.js');

(async () => {
	try {
		await updateNodes400();
	} catch (err) {
		console.error('Error launching 4.0.0 node update');
		console.error(err);
		process.exit(1);
	}
})();
