'use strict';
// Redirect-shaped table: a URL-ish indexed string attribute (`url`) plus a second indexed
// attribute (`status`) so a multi-condition AND query is possible.
const { table } = require('#src/resources/databases');

function defineRedirectTable() {
	return table({
		table: 'Redirect',
		database: 'test',
		attributes: [
			{ name: 'id', isPrimaryKey: true },
			{ name: 'url', indexed: true },
			{ name: 'status', indexed: true },
		],
	});
}

// Deterministic per-row PRNG (xorshift-ish, same recipe unitTests/resources/query.test.js uses,
// but re-seeded from (seed, i) each call) so any row's data can be recomputed standalone --
// without replaying every earlier row -- which lets query.js pick a real existing url/id to
// search for without first loading the whole table.
function makeRandom(seed) {
	return function rowRandom(i) {
		let x = (seed >>> 0 || 532532) ^ (i * 2654435761);
		x >>>= 0;
		return function random(max) {
			x = (x * 16843009 + 3014898611) >>> 0;
			return x % max;
		};
	};
}

const STATUSES = ['active', 'inactive', 'pending', 'expired'];
const HOSTS = ['shop.example.com', 'docs.example.com', 'cdn.example.com', 'app.example.com', 'go.example.com'];

// Generates the Nth row deterministically. `makeRow` is `makeRandom(seed)`.
function generateRow(i, makeRow) {
	const random = makeRow(i);
	const host = HOSTS[i % HOSTS.length];
	return {
		id: i,
		url: `https://${host}/r/${i}/${random(1000000)}`,
		status: STATUSES[random(STATUSES.length)],
	};
}

module.exports = { defineRedirectTable, makeRandom, generateRow, STATUSES, HOSTS };
