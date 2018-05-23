"use strict";

/**
 * This module should contain common variables/values that will be used across the project.  This should avoid
 * duplicate values making refactoring a little easier.
 */

const HDB_PROC_NAME = 'hdb_express.js';

const SYSTEM_SCHEMA_NAME = 'system';
const ROLE_TABLE_NAME = 'hdb_role';
const JOB_TABLE_NAME = 'hdb_job';
const JOB_TYPE_ENUM = {
    CSV_FILE_UPLOAD: 'CSV_FILE_UPLOAD',
    EMPTY_TRASH: 'EMPTY_TRASH',
    CSV_URL_LOAD: 'CSV_URL_LOAD',
    EXPORT_TO_S3: 'EXPORT_TO_S3',
    EXPORT_LOCAL: 'EXPORT_LOCAL',
	TTL: 'TTL'
};
const JOB_STATUS_ENUM = {
	CREATED: "CREATED",
	IN_PROGRESS: "IN_PROGRESS",
	COMPLETE: "COMPLETE",
	ERROR: "ERROR"
};

module.exports = {
    HDB_PROC_NAME,
    SYSTEM_SCHEMA_NAME,
    ROLE_TABLE_NAME,
    JOB_TABLE_NAME,
    JOB_TYPE_ENUM,
    JOB_STATUS_ENUM
};