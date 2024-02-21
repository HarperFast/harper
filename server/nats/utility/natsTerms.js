'use strict';
const { platform } = require('os');

const NATS_SERVER_ZIP = 'nats-server.zip';
const NATS_SERVER_NAME = 'nats-server';
const NATS_BINARY_NAME = process.platform === 'win32' ? `${NATS_SERVER_NAME}.exe` : NATS_SERVER_NAME;
const DELIVER_GROUP = 'HDB';

// Regex used to validate Nats node names
const NATS_TERM_CONSTRAINTS_RX = /^[^\s.,*>]+$/;

const REQUEST_SUFFIX = '__request__';
const REQUEST_SUBJECT = (remote_node) => `${remote_node}.${REQUEST_SUFFIX}`;

const MSG_HEADERS = {
	NATS_MSG_ID: 'Nats-Msg-Id',
	ORIGIN: 'origin',
	TRANSACTED_NODES: 'transacted_nodes',
};

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

const SUBJECT_PREFIXES = {
	TXN: 'txn',
	MSGID: 'msgid',
};

const LOG_LEVELS = {
	ERR: 'error',
	WRN: 'warn',
	INF: 'info',
	DBG: 'debug',
	TRC: 'trace',
};

const LOG_LEVEL_HIERARCHY = {
	[LOG_LEVELS.ERR]: 1,
	[LOG_LEVELS.WRN]: 2,
	[LOG_LEVELS.INF]: 3,
	[LOG_LEVELS.DBG]: 4,
	[LOG_LEVELS.TRC]: 5,
};

const LOG_LEVEL_FLAGS = {
	debug: '-D',
	trace: '-DVV',
};

module.exports = {
	NATS_SERVER_ZIP,
	NATS_SERVER_NAME,
	NATS_BINARY_NAME,
	PID_FILES,
	NATS_CONFIG_FILES,
	SERVER_SUFFIX,
	NATS_TERM_CONSTRAINTS_RX,
	REQUEST_SUFFIX,
	UPDATE_REMOTE_RESPONSE_STATUSES,
	CLUSTER_STATUS_STATUSES,
	REQUEST_SUBJECT,
	SUBJECT_PREFIXES,
	MSG_HEADERS,
	LOG_LEVELS,
	LOG_LEVEL_FLAGS,
	LOG_LEVEL_HIERARCHY,
};
