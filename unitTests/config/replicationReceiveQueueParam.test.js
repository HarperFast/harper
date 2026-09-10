'use strict';

// `env.get` resolves a name only if it is present in CONFIG_PARAM_MAP, which is populated from
// CONFIG_PARAMS by lowercased name. An unregistered param therefore reads as `undefined` forever: the
// configured value is silently ignored, its compiled-in default always applies, and set_configuration
// rejects it as unrecognized. That is how `replication_leadingDuplicateSkip` shipped inert
// (harper-pro#395), and several sibling replication params are inert today (harper-pro#734).
//
// harper-pro's receive-queue budget (harper-pro#735) reads this param, and its own suite asserts the
// registration — but only against whatever core its submodule pins. This guards the entry here.

const assert = require('node:assert/strict');
const { CONFIG_PARAMS, CONFIG_PARAM_MAP } = require('#src/utility/hdbTerms');

describe('replication_receiveQueueHighWaterMark registration', () => {
	it('is registered in CONFIG_PARAMS so env.get can resolve it', () => {
		assert.strictEqual(CONFIG_PARAMS.REPLICATION_RECEIVEQUEUEHIGHWATERMARK, 'replication_receiveQueueHighWaterMark');
	});

	it('is reachable through CONFIG_PARAM_MAP, so set_configuration accepts it', () => {
		assert.strictEqual(
			CONFIG_PARAM_MAP['replication_receivequeuehighwatermark'],
			'replication_receiveQueueHighWaterMark'
		);
	});
});
