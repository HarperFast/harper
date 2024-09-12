'use strict';

//NOTE - This file is imported to and exported from the test_utils file to make importing to test modules easier

const TEST_CRUD_PERM_KEYS = {
	READ: 'read',
	INSERT: 'insert',
	UPDATE: 'update',
	DELETE: 'delete',
};

const TEST_CLUSTER_MESSAGE_TYPE_ENUM = {
	CLUSTERING_PAYLOAD: 'clustering_payload',
	DELEGATE_THREAD_RESPONSE: 'delegate_thread_response',
	CLUSTERING: 'clustering',
	SCHEMA: 'schema',
	CLUSTER_STATUS: 'cluster_status',
	JOB: 'job',
	CHILD_STARTED: 'child_started',
	CHILD_STOPPED: 'child_stopped',
	USER: 'user',
	RESTART: 'restart',
};

module.exports = {
	TEST_CRUD_PERM_KEYS,
	TEST_CLUSTER_MESSAGE_TYPE_ENUM,
};
