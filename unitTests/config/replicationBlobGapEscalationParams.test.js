'use strict';

// `env.get` resolves a name only if it is present in CONFIG_PARAM_MAP, which is populated from
// CONFIG_PARAMS by lowercased name; an unregistered param reads as `undefined` forever and its
// compiled-in default silently applies (harper-pro#734). harper-pro's blob-gap escalation budget
// (harper-pro#432) reads these two params, so this guards their registration here.

const assert = require('node:assert/strict');
const { CONFIG_PARAMS, CONFIG_PARAM_MAP } = require('#src/utility/hdbTerms');

describe('replication blob-gap escalation param registration', () => {
	it('registers both bounds in CONFIG_PARAMS so env.get can resolve them', () => {
		assert.strictEqual(CONFIG_PARAMS.REPLICATION_BLOBGAPESCALATIONCYCLES, 'replication_blobGapEscalationCycles');
		assert.strictEqual(CONFIG_PARAMS.REPLICATION_BLOBGAPESCALATIONMS, 'replication_blobGapEscalationMs');
	});

	it('reaches both through CONFIG_PARAM_MAP, so set_configuration accepts them', () => {
		assert.strictEqual(CONFIG_PARAM_MAP['replication_blobgapescalationcycles'], 'replication_blobGapEscalationCycles');
		assert.strictEqual(CONFIG_PARAM_MAP['replication_blobgapescalationms'], 'replication_blobGapEscalationMs');
	});
});
