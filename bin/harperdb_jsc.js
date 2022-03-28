#!/usr/bin/env node
'use strict';
const check_node = require('../launchServiceScripts/utility/checkNodeVersion');

let node_results = check_node();

if (node_results && node_results.error) {
	console.error(node_results.error);
} else {
	process.env.HDB_COMPILED = 'true';
	const bytenode = require('bytenode');
	require('./harperdb.jsc');
}
