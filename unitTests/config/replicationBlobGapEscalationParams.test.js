'use strict';

// `env.get` resolves only names registered in CONFIG_PARAMS; an unregistered param reads as undefined
// forever and its compiled-in default silently applies (harper-pro#734).

const assert = require('node:assert');
const { CONFIG_PARAMS, CONFIG_PARAM_MAP } = require('#src/utility/hdbTerms');

describe('replication blob-gap escalation param registration (harper-pro#432)', () => {
	it('registers both bounds in CONFIG_PARAMS so env.get can resolve them', () => {
		assert.strictEqual(CONFIG_PARAMS.REPLICATION_BLOBGAPESCALATIONCYCLES, 'replication_blobGapEscalationCycles');
		assert.strictEqual(CONFIG_PARAMS.REPLICATION_BLOBGAPESCALATIONMS, 'replication_blobGapEscalationMs');
	});

	it('reaches both through CONFIG_PARAM_MAP, so set_configuration accepts them', () => {
		assert.strictEqual(CONFIG_PARAM_MAP['replication_blobgapescalationcycles'], 'replication_blobGapEscalationCycles');
		assert.strictEqual(CONFIG_PARAM_MAP['replication_blobgapescalationms'], 'replication_blobGapEscalationMs');
	});
});
