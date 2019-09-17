'use strict';

module.exports = returnObject;

/**
 * constructs return object for insert and update.
 * @param action
 * @param written_hashes
 * @param object
 * @param skipped
 * @returns {{skipped_hashes: *, update_hashes: *, message: string}}
 */
function returnObject(action, written_hashes, object, skipped, insert_action) {
    let return_object = {
        message: `${action} ${written_hashes.length} of ${object.records.length} records`,
        skipped_hashes: skipped
    };

    if (action === insert_action) {
        return_object.inserted_hashes = written_hashes;
        return return_object;
    }

    return_object.update_hashes = written_hashes;
    return return_object;
}
