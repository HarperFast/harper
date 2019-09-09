'use strict';

const log = require('../../../../utility/logging/harper_logger');
const moment = require('moment');

module.exports = deleteRecordsBefore;

async function deleteRecordsBefore(delete_obj) {
    let dir_path = common_utils.buildFolderPath(BASE_PATH, schema, table);
    let parsed_date = moment(delete_obj.date, moment.ISO_8601);

    await deleteFilesInPath(delete_obj.schema, delete_obj.table, dir_path, parsed_date).catch(function caughtError(err) {
        log.error(`There was an error deleting files by date: ${err}`);
        throw new Error(`There was an error deleting files by date: ${err}`);
    });


}