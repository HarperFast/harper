"use strict";

//TODO: Look into a way to import these defs from socketcluster
const MIDDLEWARE_TYPE = {
    MIDDLEWARE_HANDSHAKE_WS: 'handshakeWS',
    MIDDLEWARE_HANDSHAKE_SC: 'handshakeSC',
    MIDDLEWARE_EMIT: 'emit',
    MIDDLEWARE_SUBSCRIBE: 'subscribe',
    MIDDLEWARE_PUBLISH_IN: 'publishIn',
    MIDDLEWARE_PUBLISH_OUT: 'publishOut',
    MIDDLEWARE_AUTHENTICATE: 'authenticate',
};

const ROOM_TYPE = {
    DEMO: 'ChannelSource',
    HDB_DEMO: 'CoreSource',
    CLUSTER_SOURCE: 'ClusterSource',
    CORE_SOURCE: 'CoreSource',
    STANDARD: 'Standard',
    WORKER_ROOM: 'WorkerRoom'
};

const CONNECTOR_TYPE_ENUM = {
    CORE: 5,
    CLUSTER: 6
};

const ERROR_CODES = {
    MIDDLEWARE_ERROR: 10, // An error occurred while middleware was run
    MIDDLEWARE_SWALLOW: 11, // The message failed a rule in the middleware, message is 'swallowed'
    WORKER_RULE_FAILURE: 12, // There was a failure of a worker rule
    WORKER_RULE_ERROR: 13 // There was an error when evaluating a worker rule
};

const PREMADE_MIDDLEWARE_TYPES = {
    GENERIC: 10,
    AUTH: 11,
    ORIGINATOR: 12,
    REQUEST_DATA_VALID: 13,
    STAMP_REQUEST: 14,
    CORE_QUEUE_PUBLISH: 15,
    MSG_PREP: 16
};

const COMMAND_EVAL_ORDER_ENUM = {
    VERY_FIRST: 11, // This rule should be evaluated first, only one rule in the collection can contain this
    HIGH: 12, // This rule should be evaluated after VERY_FIRST, but before MID
    MID: 13, // This rule can be evaluated somewhere in the middle, order doesn't matter so much
    LOW: 14, // This rule should be evaluated last.
    VERY_LAST: 15 // This rule should be evaluated after all other rules.
};

const REQUEST_HEADER_ATTRIBUTE_NAMES = {
    DATA_SOURCE: '__data_source',
    ID: 'msg_id'
};

// Created to make removing certain rules easier.  Note these should be different values from Rules to avoid confusion.
const RULE_TYPE_ENUM = {
    BASE_TYPE: 100,
    ASSIGN_TO_HDB_WORKER: 101,
    CALL_ROOM_MSG_HANDLER: 102,
    WRITE_TO_TRANSACTION_LOG: 103,
    TEST_RULE: 104,
    CLEAN_DATA_OBJECT: 105
};

// Message types that will flow through the Cluster Worker room.
const WORKER_ROOM_MSG_TYPE_ENUM = {
    WORKER_ROOM_GET_STATUS: 'WORKER_ROOM_GET_CLUSTER_STATUS_REQUEST',
    WORKER_ROOM_STATUS_RESPONSE: 'WORKER_ROOM_STATUS_RESPONSE'
};

// Message types that will flow through the HDB Child and Cluster rooms.
const CORE_ROOM_MSG_TYPE_ENUM = {
    GET_CLUSTER_STATUS: 'GET_CLUSTER_STATUS',
    CLUSTER_STATUS_RESPONSE: 'CLUSTER_STATUS_RESPONSE',
    ERROR_RESPONSE: 'ERROR',
    ADD_USER: 'ADD_USER',
    ALTER_USER: 'ALTER_USER',
    DROP_USER: 'DROP_USER',
    HDB_OPERATION: 'HDB_OPERATION',
    ADD_NODE: 'ADD_NODE',
    REMOVE_NODE: 'REMOVE_NODE',
    HDB_USERS_MSG: 'HDB_USERS_MSG',
    HDB_WORKERS: 'HDB_WORKERS',
    HDB_TRANSACTION: 'HDB_TRANSACTION'
};

const HDB_HEADER_NAME = 'hdb_header';

module.exports = {
    MIDDLEWARE_TYPE,
    ROOM_TYPE,
    CONNECTOR_TYPE_ENUM,
    ERROR_CODES,
    PREMADE_MIDDLEWARE_TYPES,
    COMMAND_EVAL_ORDER_ENUM,
    REQUEST_HEADER_ATTRIBUTE_NAMES,
    RULE_TYPE_ENUM,
    WORKER_ROOM_MSG_TYPE_ENUM,
    CORE_ROOM_MSG_TYPE_ENUM,
    HDB_HEADER_NAME
};