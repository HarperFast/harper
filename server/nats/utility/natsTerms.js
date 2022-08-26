'use strict';
const { platform } = require('os')

const NATS_SERVER_ZIP = 'nats-server.zip';
const NATS_SERVER_NAME = 'nats-server';
const NATS_BINARY_NAME = process.platform === 'win32' ? `${NATS_SERVER_NAME}.exe` : NATS_SERVER_NAME;
const DELIVER_GROUP = 'HDB';

// Regex used to validate Nats node names
const NATS_TERM_CONSTRAINTS_RX = /^[^\s.,*>]+$/;

const REQUEST_SUFFIX = '__request__';
const REQUEST_SUBJECT = (remote_node) => `${remote_node}.${REQUEST_SUFFIX}`;

const NATS_CONFIG_FILES = {
	HUB_SERVER: 'hub.json',
	LEAF_SERVER: 'leaf.json',
};

const PID_FILES = {
	HUB: 'hub.pid',
	LEAF: 'leaf.pid',
};

const SERVER_SUFFIX = {
	HUB: '-hub',
	LEAF: '-leaf',
	ADMIN: '-admin',
};

const WORK_QUEUE_CONSUMER_NAMES = {
	stream_name: '__HARPERDB_WORK_QUEUE__',
	durable_name: 'HDB_WORK_QUEUE',
	deliver_group: DELIVER_GROUP,
	deliver_subject: '__HDB__.WORKQUEUE',
};

const SCHEMA_QUEUE_CONSUMER_NAMES = {
	stream_name: '__HARPERDB_SCHEMA_QUEUE__',
	durable_name: 'HDB_SCHEMA_QUEUE',
	deliver_group: DELIVER_GROUP,
	deliver_subject: 'HDB.SCHEMAQUEUE',
};

const USER_QUEUE_CONSUMER_NAMES = {
	stream_name: '__HARPERDB_USER_QUEUE__',
	durable_name: 'HDB_USER_QUEUE',
	deliver_group: DELIVER_GROUP,
	deliver_subject: 'HDB.USERQUEUE',
};

const UPDATE_REMOTE_RESPONSE_STATUSES = {
	SUCCESS: 'success',
	ERROR: 'error',
};

const CLUSTER_STATUS_STATUSES = {
	OPEN: 'open',
	CLOSED: 'closed',
	NO_RESPONDERS: 'NoResponders',
	TIMEOUT: 'Timeout',
};

module.exports = {
	NATS_SERVER_ZIP,
	NATS_SERVER_NAME,
	NATS_BINARY_NAME,
	PID_FILES,
	NATS_CONFIG_FILES,
	SERVER_SUFFIX,
	WORK_QUEUE_CONSUMER_NAMES,
	SCHEMA_QUEUE_CONSUMER_NAMES,
	USER_QUEUE_CONSUMER_NAMES,
	NATS_TERM_CONSTRAINTS_RX,
	REQUEST_SUFFIX,
	UPDATE_REMOTE_RESPONSE_STATUSES,
	CLUSTER_STATUS_STATUSES,
	REQUEST_SUBJECT,
};
