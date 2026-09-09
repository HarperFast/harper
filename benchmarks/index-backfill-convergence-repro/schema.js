'use strict';
// Table shape for the backfill-convergence repro: an `id` primary key plus `attrs` low-cardinality
// secondary attributes (attr0..attrN-1), each indexed once the backfill under test runs. Low
// cardinality (8 distinct values per attribute) makes an indexed-search-vs-full-scan gate check
// cheap: expected count is always rows/8.
const { table } = require('#src/resources/databases');

const CARDINALITY = 8;

function pad(i) {
	return String(i).padStart(9, '0');
}

function defineTable({ database, tableName, numAttrs, indexed }) {
	const attributes = [{ name: 'id', isPrimaryKey: true }];
	for (let a = 0; a < numAttrs; a++) {
		attributes.push({ name: `attr${a}`, indexed: Boolean(indexed) });
	}
	return table({ table: tableName, database, attributes });
}

function generateRow(i, numAttrs) {
	const row = { id: 'id-' + pad(i) };
	for (let a = 0; a < numAttrs; a++) {
		// vary the modulus per attribute so attributes aren't perfectly correlated
		row[`attr${a}`] = 'v-' + ((i + a * 97) % CARDINALITY);
	}
	return row;
}

module.exports = { defineTable, generateRow, pad, CARDINALITY };
