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
    STANDARD: 'Standard'
};

const MESSAGE_PRIORITY_ENUM = {
    HIGHEST: 0,
    HIGH: 1,
    STANDARD: 2,
    LOW: 3,
    LOWEST: 4
};

const GET_MSG_ARGS = {
    GET_NEXT: 0,
    GET_HIGHEST_PRIORITY: 1
};

const CORE_QUEUE_EVENTS_ENUM = {
    POST_TO_QUEUE: 'PostToCoreQueue',
    NEW_MSG_ENQUEUE: 'NewMessageEnqueueCore',
    GET_NEXT_MSG: 'GetNextCoreMsg',
    NEXT_MSG_INCOMING: 'CoreMsgIncoming'
};

const NOTIFY_EVENT_NAMES_ENUM = {
    CONNECTOR_SOURCE_MESSAGE_NOTIFY_EVENT_NAME:'ConnectorMessageNotify',
    HDB_SOURCE_MESSAGE_NOTIFY_EVENT_NAME: 'HDBMessageNotify',
    GET_MSG_EVENT_NAME: 'GetNextMessage',
    NEXT_MESSAGE_INCOMING_EVENT_NAME:'NextMessageIncoming',
    HDB_MESSAGE_QUEUED: 'HdbMessageQueued',
    CONNECTOR_MSG_QUEUED: 'ConnectorMessgeQueued'
};

const CONNECTOR_TYPE_ENUM = {
    CORE: 0,
    CLUSTER: 1
};

const ERROR_CODES = {
    MIDDLEWARE_ERROR: 10, // An error occurred while middleware was run
    MIDDLEWARE_SWALLOW: 11, // The message failed a rule in the middleware, message is 'swallowed'
    WORKER_RULE_FAILURE: 12, // There was a failure of a worker rule
    WORKER_RULE_ERROR: 13 // There was an error when evaluating a worker rule
};

const PREMADE_MIDDLEWARE_TYPES = {
    GENERIC: 0,
    AUTH: 1,
    ORIGINATOR: 2,
    REQUEST_DATA_VALID: 3,
    STAMP_REQUEST: 4,
    CORE_QUEUE_PUBLISH: 5,
    MSG_PREP: 6
};

const PREMADE_RULE_TYPES = {
    SEND_TO_WORKER: 0
};

const COMMAND_EVAL_ORDER_ENUM = {
    VERY_FIRST: 1, // This rule should be evaluated first, only one rule in the collection can contain this
    HIGH: 2, // This rule should be evaluated after VERY_FIRST, but before MID
    MID: 3, // This rule can be evaluated somewhere in the middle, order doesn't matter so much
    LOW: 4, // This rule should be evaluated last.
    VERY_LAST: 5 // This rule should be evaluated after all other rules.
};

const REQUEST_HEADER_ATTRIBUTE_NAMES = {
    DATA_SOURCE: '__data_source',
    ID: 'msg_id'
};

module.exports = {
    MIDDLEWARE_TYPE,
    ROOM_TYPE: ROOM_TYPE,
    MESSAGE_PRIORITY_ENUM,
    GET_MSG_ARGS,
    NOTIFY_EVENT_NAMES_ENUM,
    CONNECTOR_TYPE_ENUM,
    ERROR_CODES,
    PREMADE_MIDDLEWARE_TYPES,
    COMMAND_EVAL_ORDER_ENUM: COMMAND_EVAL_ORDER_ENUM,
    CORE_QUEUE_EVENTS_ENUM,
    REQUEST_HEADER_ATTRIBUTE_NAMES
};