"use strict";

const RoomIF = require('./RoomIF');
//Rooms
const CoreRoom = require('./CoreRoom');
const WorkerRoom = require('./WorkerRoom');
const UsersRoom = require('./UsersRoom');
const WatchHDBWorkersRoom = require('./WatchHDBWorkersRoom');
const AddUserRoom = require('./AddUserRoom');
const AlterUserRoom = require('./AlterUserRoom');
const DropUserRoom = require('./DropUserRoom');

const types = require('../types');
const hdb_terms = require('../../../utility/hdbTerms');
const middleware_factory = require('../middleware/MiddlewareFactory');
const CoreDecisionMatrix = require('../decisionMatrix/CoreDecisionMatrix');
const log = require('../../../utility/logging/harper_logger');
const {inspect} = require('util');

//Rules
const AssignToHdbChildWorkerRule = require('../decisionMatrix/rules/AssignToHdbChildWorkerRule');
const WriteToTransactionLogRule = require('../decisionMatrix/rules/WriteToTransactionLogRule');
const CallRoomMsgHandlerRule = require('../decisionMatrix/rules/CallRoomMsgHandlerRule');
const StripHdbHeaderRule = require('../decisionMatrix/rules/StripHdbHeaderRule');

/**
 *  The room factory abstracts everything needed to create a room behind the createRoom function. A room constructor
 *  should never be called directly, instead the factory should be used.
 */

/**
 * Creates a room for the topic specified.  The room that is created depends on the enum passed.
 * @param topicName - The channel name this room represents.
 * @returns {RoomIF}
 */
function createRoom(topicName) {
    let created_room = null;
    switch(topicName) {
        case hdb_terms.INTERNAL_SC_CHANNELS.WORKER_ROOM: {
            created_room = new WorkerRoom(topicName);
            configureStandardRoom(created_room);
            configureSingleFunctionRoom(created_room);
            configureWorkerRoom(created_room);
            break;
        }
        case hdb_terms.INTERNAL_SC_CHANNELS.HDB_USERS: {
            created_room = new UsersRoom(topicName);
            configureStandardRoom(created_room);
            configureSingleFunctionRoom(created_room);
            break;
        }
        case hdb_terms.INTERNAL_SC_CHANNELS.HDB_WORKERS: {
            created_room = new WatchHDBWorkersRoom(topicName);
            configureStandardRoom(created_room);
            configureSingleFunctionRoom(created_room);
            break;
        }
        case hdb_terms.INTERNAL_SC_CHANNELS.ADD_USER: {
            created_room = new AddUserRoom(topicName);
            configureStandardRoom(created_room);
            configureSingleFunctionRoom(created_room);
            break;
        }
        case hdb_terms.INTERNAL_SC_CHANNELS.ALTER_USER: {
            created_room = new AlterUserRoom(topicName);
            configureStandardRoom(created_room);
            configureSingleFunctionRoom(created_room);
            break;
        }
        case hdb_terms.INTERNAL_SC_CHANNELS.DROP_USER: {
            created_room = new DropUserRoom(topicName);
            configureStandardRoom(created_room);
            configureSingleFunctionRoom(created_room);
            break;
        }
        default:
            // Most Rooms should be a default 'Core' room.
            created_room = new CoreRoom(topicName);
            configureStandardRoom(created_room);
    }
    log.debug(`Created room: ${inspect(created_room)}`);
    return created_room;
}

/**
 * Meant to be called after configureStandardRoom, this will configure a room that will be used to handle a single type of
 * message (i.e. addUser).  This removes the transaction rule and the send to HDB worker rule.
 * @param created_room
 */
function configureSingleFunctionRoom(created_room) {
    // Remove the AssignToHdbChildWorker rule.
    created_room.decision_matrix.removeRuleByType(types.RULE_TYPE_ENUM.ASSIGN_TO_HDB_WORKER, types.CONNECTOR_TYPE_ENUM.CORE, types.MIDDLEWARE_TYPE.MIDDLEWARE_PUBLISH_IN);
    created_room.decision_matrix.removeRuleByType(types.RULE_TYPE_ENUM.ASSIGN_TO_HDB_WORKER, types.CONNECTOR_TYPE_ENUM.CLUSTER, types.MIDDLEWARE_TYPE.MIDDLEWARE_PUBLISH_IN);

    created_room.decision_matrix.removeRuleByType(types.RULE_TYPE_ENUM.WRITE_TO_TRANSACTION_LOG, types.CONNECTOR_TYPE_ENUM.CORE, types.MIDDLEWARE_TYPE.MIDDLEWARE_PUBLISH_IN);
    created_room.decision_matrix.removeRuleByType(types.RULE_TYPE_ENUM.WRITE_TO_TRANSACTION_LOG, types.CONNECTOR_TYPE_ENUM.CLUSTER, types.MIDDLEWARE_TYPE.MIDDLEWARE_PUBLISH_IN);
}

/**
 * Meant to be called after configureStandardRoom, this will configure a room that will be used to handle a single type of
 * message (i.e. addUser).  This removes the transaction rule and the send to HDB worker rule.
 * @param created_room
 */
function configureWorkerRoom(created_room) {
    // Remove the AssignToHdbChildWorker rule.
    created_room.removeMiddleware(types.MIDDLEWARE_TYPE.MIDDLEWARE_PUBLISH_OUT, types.PREMADE_MIDDLEWARE_TYPES.ORIGINATOR, types.CONNECTOR_TYPE_ENUM.CORE);
    created_room.removeMiddleware(types.MIDDLEWARE_TYPE.MIDDLEWARE_PUBLISH_OUT, types.PREMADE_MIDDLEWARE_TYPES.ORIGINATOR, types.CONNECTOR_TYPE_ENUM.CLUSTER);

    let stripper = new StripHdbHeaderRule();
    created_room.removeMiddleware(stripper, types.CONNECTOR_TYPE_ENUM.CLUSTER, types.MIDDLEWARE_TYPE.MIDDLEWARE_PUBLISH_OUT);
    created_room.removeMiddleware(stripper, types.CONNECTOR_TYPE_ENUM.CORE, types.MIDDLEWARE_TYPE.MIDDLEWARE_PUBLISH_OUT);
}

/**
 * Populates a newly created room with a nominal setup of rules and middleware.
 * @param created_room
 */
function configureStandardRoom(created_room) {
    //TODO: This could be its own predefined Middleware.  Leaving for now as an example to readers.
    let subscribe_middleware = middleware_factory.createMiddleware(types.MIDDLEWARE_TYPE.MIDDLEWARE_SUBSCRIBE, (req, next) => {
        if(global.hdb_workers && global.hdb_workers.indexOf(req.channel) >= 0 && req.channel !== req.socket.id){
            return next('cannot connect to another socket\'s room');
        }
    });
    // This middleware will be used by both core and cluster connectors
    created_room.addMiddleware(subscribe_middleware, types.CONNECTOR_TYPE_ENUM.CORE);
    created_room.addMiddleware(subscribe_middleware, types.CONNECTOR_TYPE_ENUM.CLUSTER);

    let out_auth_middleware = middleware_factory.createMiddleware(types.MIDDLEWARE_TYPE.MIDDLEWARE_PUBLISH_OUT,
        null,
        new middleware_factory.MiddlewareFactoryOptions(types.PREMADE_MIDDLEWARE_TYPES.AUTH));
    created_room.addMiddleware(out_auth_middleware, types.CONNECTOR_TYPE_ENUM.CORE);
    created_room.addMiddleware(out_auth_middleware, types.CONNECTOR_TYPE_ENUM.CLUSTER);

    let originator_middleware = middleware_factory.createMiddleware(types.MIDDLEWARE_TYPE.MIDDLEWARE_PUBLISH_OUT,
        null,
        new middleware_factory.MiddlewareFactoryOptions(types.PREMADE_MIDDLEWARE_TYPES.ORIGINATOR));
    created_room.addMiddleware(originator_middleware, types.CONNECTOR_TYPE_ENUM.CORE);
    created_room.addMiddleware(originator_middleware, types.CONNECTOR_TYPE_ENUM.CLUSTER);

    let msg_prep_middleware = middleware_factory.createMiddleware(types.MIDDLEWARE_TYPE.MIDDLEWARE_PUBLISH_IN,
        null,
        new middleware_factory.MiddlewareFactoryOptions(types.PREMADE_MIDDLEWARE_TYPES.MSG_PREP));
    created_room.addMiddleware(msg_prep_middleware, types.CONNECTOR_TYPE_ENUM.CORE);
    created_room.addMiddleware(msg_prep_middleware, types.CONNECTOR_TYPE_ENUM.CLUSTER);

    let valid_data_middleware = middleware_factory.createMiddleware(types.MIDDLEWARE_TYPE.MIDDLEWARE_PUBLISH_IN,
        null,
        new middleware_factory.MiddlewareFactoryOptions(types.PREMADE_MIDDLEWARE_TYPES.REQUEST_DATA_VALID));
    created_room.addMiddleware(valid_data_middleware, types.CONNECTOR_TYPE_ENUM.CORE);
    created_room.addMiddleware(valid_data_middleware, types.CONNECTOR_TYPE_ENUM.CLUSTER);

    let un_auth_middleware = middleware_factory.createMiddleware(types.MIDDLEWARE_TYPE.MIDDLEWARE_PUBLISH_IN,
        null,
        new middleware_factory.MiddlewareFactoryOptions(types.PREMADE_MIDDLEWARE_TYPES.AUTH));
    created_room.addMiddleware(un_auth_middleware, types.CONNECTOR_TYPE_ENUM.CORE);
    created_room.addMiddleware(un_auth_middleware, types.CONNECTOR_TYPE_ENUM.CLUSTER);

    let stamp_middleware = middleware_factory.createMiddleware(types.MIDDLEWARE_TYPE.MIDDLEWARE_PUBLISH_IN,
        null,
        new middleware_factory.MiddlewareFactoryOptions(types.PREMADE_MIDDLEWARE_TYPES.STAMP_REQUEST));
    created_room.addMiddleware(stamp_middleware, types.CONNECTOR_TYPE_ENUM.CORE);
    created_room.addMiddleware(stamp_middleware, types.CONNECTOR_TYPE_ENUM.CLUSTER);

    // create room decision matrix
    let new_decision_matrix = new CoreDecisionMatrix();

    new_decision_matrix.addRule(new AssignToHdbChildWorkerRule(), types.CONNECTOR_TYPE_ENUM.CLUSTER, types.MIDDLEWARE_TYPE.MIDDLEWARE_PUBLISH_IN);

    let write_transaction_rule = new WriteToTransactionLogRule();
    new_decision_matrix.addRule(write_transaction_rule, types.CONNECTOR_TYPE_ENUM.CLUSTER, types.MIDDLEWARE_TYPE.MIDDLEWARE_PUBLISH_IN);
    new_decision_matrix.addRule(write_transaction_rule, types.CONNECTOR_TYPE_ENUM.CORE, types.MIDDLEWARE_TYPE.MIDDLEWARE_PUBLISH_IN);

    created_room.setDecisionMatrix(new_decision_matrix);
}

module.exports = {
    createRoom
};
