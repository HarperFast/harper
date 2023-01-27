'use strict';

const update_nodes_4_0_0 = require('../upgrade/nats/updateNodes4-0-0');

(async () => {
	try {
		await update_nodes_4_0_0();
	} catch (err) {
		console.error('Error launching 4.0.0 node update');
		console.error(err);
		process.exit(1);
	}
})();
