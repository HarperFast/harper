'use strict';

const is_compiled = process.env.HDB_COMPILED === 'true';
let update_nodes_4_0_0;
if (is_compiled) {
	require('bytenode');
	update_nodes_4_0_0 = require('../upgrade/nats/updateNodes4-0-0.jsc');
} else {
	update_nodes_4_0_0 = require('../upgrade/nats/updateNodes4-0-0');
}

(async () => {
	try {
		await update_nodes_4_0_0();
	} catch (err) {
		console.error('Error launching 4.0.0 node update');
		console.error(err);
		process.exit(1);
	}
})();
