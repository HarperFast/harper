'use strict';

module.exports = lmdbDeleteRecordsBefore;

/**
 * Deletes all records in a schema.table that fall behind a passed date.
 * @param delete_obj
 * {
 *     operation: 'delete_files_before' <string>,
 *     date: ISO-8601 format YYYY-MM-DD <string>,
 *     schema: Schema where table resides <string>,
 *     table: Table to delete records from <string>,
 * }
 * @returns {undefined}
 */
function lmdbDeleteRecordsBefore(delete_obj) {

}