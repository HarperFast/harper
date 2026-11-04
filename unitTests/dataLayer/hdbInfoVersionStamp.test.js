'use strict';

const assert = require('node:assert');

const { assertVersionRecorded, VersionStampNotRecordedError } = require('#src/dataLayer/hdbInfoController');

const NEW_ID = 4;
const NEW_VERSION = '5.2.0';

const isStampError = (error) => {
	assert.ok(error instanceof VersionStampNotRecordedError, `expected VersionStampNotRecordedError, got ${error}`);
	assert.strictEqual(error.statusCode, 500);
	assert.ok(error.message.includes(NEW_VERSION), 'message names the version that was not recorded');
	assert.ok(error.message.includes(String(NEW_ID)), 'message names the info_id that was attempted');
	return true;
};

describe('hdb_info version stamp verification', () => {
	it('accepts an insert that reports the expected info_id as inserted', () => {
		assertVersionRecorded({ inserted_hashes: [NEW_ID], skipped_hashes: [] }, NEW_ID, NEW_VERSION);
	});

	it('rejects an insert whose key already existed and was skipped', () => {
		assert.throws(
			() => assertVersionRecorded({ inserted_hashes: [], skipped_hashes: [NEW_ID] }, NEW_ID, NEW_VERSION),
			isStampError
		);
	});

	it('rejects an insert that reports nothing at all', () => {
		assert.throws(
			() => assertVersionRecorded({ inserted_hashes: [], skipped_hashes: [] }, NEW_ID, NEW_VERSION),
			isStampError
		);
		assert.throws(() => assertVersionRecorded({}, NEW_ID, NEW_VERSION), isStampError);
		assert.throws(() => assertVersionRecorded(undefined, NEW_ID, NEW_VERSION), isStampError);
	});

	it('accepts an expected info_id the storage layer handed back as a string', () => {
		assertVersionRecorded({ inserted_hashes: [String(NEW_ID)], skipped_hashes: [] }, NEW_ID, NEW_VERSION);
	});

	it('rejects an insert that recorded a different info_id than the one derived for this upgrade', () => {
		assert.throws(
			() => assertVersionRecorded({ inserted_hashes: [NEW_ID + 1], skipped_hashes: [] }, NEW_ID, NEW_VERSION),
			isStampError
		);
	});
});
