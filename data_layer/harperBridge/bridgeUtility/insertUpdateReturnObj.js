'use strict';

module.exports = returnObject;

const INSERT_ACTION = 'inserted';

/**
 * constructs return object for insert and update.
 * @param action
 * @param written_hashes
 * @param object
 * @param skipped
 * @returns {{skipped_hashes: *, update_hashes: *, message: string}}
 */
function returnObject(action, written_hashes, object, skipped) {
	let return_object = {
		message: `${action} ${written_hashes.length} of ${object.records.length} records`,
		skipped_hashes: skipped,
	};

	if (action === INSERT_ACTION) {
		return_object.inserted_hashes = written_hashes;
		return return_object;
	}

	return_object.update_hashes = written_hashes;
	return return_object;
}
