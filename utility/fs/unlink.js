"use strict";

const fs_unlink = require('fs-extra').unlink;
const fs_rmdir = require('fs-extra').rmdir;
const logger = require('../logging/harper_logger');
const hdb_terms = require('../hdbTerms');
const path = require('path');
const hdb_utils = require('../../utility/common_utils');
const {DeleteResponseObject} = require('../../data_layer/DataLayerObjects');
const ENOENT_ERROR_CODE = 'ENOENT';

/**
 * removes files from the file system
 * @param {Array.<string>} paths
 * @returns {Promise<array>}
 */
async function unlink(paths) {
    let failed_path_array = [];
    await Promise.all(
        paths.map(async file_path => {
            try {
                await fs_unlink(file_path);
            } catch(e){
                if(e.code !== ENOENT_ERROR_CODE){
                    logger.error(e);
                    failed_path_array.push(file_path);
                }
            }

            try {
                //attempt to remove the folder that contains the file
                let folder = path.dirname(file_path);
                // TODO: Can can be made much faster by comparing the last 10 characters of `folder` to see if they
                // progressively match `__hdb_hash` rather than searching through the entire string.
                if(folder.indexOf(hdb_terms.HASH_FOLDER_NAME) < 0) {
                    await fs_rmdir(folder);
                }
            } catch(e) {
                // OK for this to fail, just means there are other records in the folder.
                if(e.code !== 'ENOTEMPTY') {
                    logger.error(e);
                }
            }
        })
    );
    return failed_path_array;
}

/**
 * Uses unlink, but tracks failures in the unlink process so they can be reported.
 * @param delete_object - A map object that has the shape <record_id>:[array of paths]
 * @returns {Promise<DeleteResponseObject>}
 */
async function unlink_delete_object(delete_object) {
    let delete_response = new DeleteResponseObject();
    if(!delete_object) {
        delete_response.message = 'invalid delete input';
        return delete_response;
    }

    let unlink_failure_array = [];
    let delete_hash_ids = Object.keys(delete_object);
    try {
        await Promise.all(
            delete_hash_ids.map(async hash_id => {
                let unlink_failures = await unlink(delete_object[hash_id]);
                unlink_failures.forEach((id) => {
                   unlink_failure_array.push(id);
                });
            })
        );
        // if there are any failures, we need to report the id for that file as not removed.
        let failed_hash_ids_array = [];
        if(unlink_failure_array.length > 0) {
            // bummer, something failed.  We need to search through the object to find the id.
            for(let i=0; i<unlink_failure_array.length; i++) {
                for(let d=0; d<delete_hash_ids.length; ++d) {
                    let curr_hash_id = delete_hash_ids[d];
                    let curr_path_array = delete_object[curr_hash_id];
                    if(curr_path_array.includes(unlink_failure_array[i])) {
                        failed_hash_ids_array.push(curr_hash_id);
                        let failure_id_index = delete_hash_ids.indexOf(curr_hash_id);
                        if(failure_id_index > -1) {
                            delete_hash_ids.splice(failure_id_index, 1);
                        }
                        break;
                    }
                }
            }
        }
        delete_response.deleted_hashes = delete_hash_ids;
        delete_response.skipped_hashes = failed_hash_ids_array;
        return delete_response;
    } catch(err) {
        logger.error('There was a problem deleting files.');
    }
}

module.exports = {
    unlink,
    unlink_delete_object
};