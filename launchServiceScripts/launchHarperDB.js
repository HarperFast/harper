'use strict';

const is_compiled = process.env.HDB_COMPILED === 'true';
if (is_compiled) {
	require('bytenode');
	require('../server/harperdb/hdbServer.jsc');
} else {
	require('../server/harperdb/hdbServer');
}
