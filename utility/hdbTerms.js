'use strict';

/**
 * This module should contain common variables/values that will be used across the project.  This should avoid
 * duplicate values making refactoring a little easier.
 */

 // Name of the HDB process
const HDB_PROC_NAME = 'hdb_express.js';

// Name of the System schema
const SYSTEM_SCHEMA_NAME = 'system';

// Role table name
const ROLE_TABLE_NAME = 'hdb_role';

// Job table name
const JOB_TABLE_NAME = 'hdb_job';

// Describes all available job types
const JOB_TYPE_ENUM = {
    csv_file_upload: 'csv_file_upload',
    empty_trash: 'empty_trash',
    csv_url_load: 'csv_url_load',
    csv_data_load: 'csv_data_load',
    export_to_s3: 'export_to_s3',
    export_local: 'export_local',
	delete_files_before: 'delete_files_before'
};

// Describes the available statuses for jobs
const JOB_STATUS_ENUM = {
	CREATED: 'CREATED',
	IN_PROGRESS: 'IN_PROGRESS',
	COMPLETE: 'COMPLETE',
	ERROR: 'ERROR'
};

// Operations
const OPERATIONS_ENUM = {
    UPDATE: 'update'
}

module.exports = {
    HDB_PROC_NAME,
    SYSTEM_SCHEMA_NAME,
    ROLE_TABLE_NAME,
    JOB_TABLE_NAME,
    JOB_TYPE_ENUM,
    JOB_STATUS_ENUM,
    OPERATIONS_ENUM
};

