"use strict";

const RoomIF = require('./RoomIF');
const CoreRoom = require('./CoreRoom');
const WorkerRoom = require('./WorkerRoom');

const types = require('../types');
const middleware_factory = require('../middleware/MiddlewareFactory');
const CoreDecisionMatrix = require('../decisionMatrix/CoreDecisionMatrix');
const log = require('../../../utility/logging/harper_logger');

//Rules
const AssignToHdbChildWorkerRule = require('../decisionMatrix/rules/AssignToHdbChildWorkerRule');
const WriteToTransactionLogRule = require('../decisionMatrix/rules/WriteToTransactionLogRule');

/**
 *  The room factory abstracts everything needed to create a room behind the createRoom function. A room constructor
 *  should never be called directly, instead the factory should be used.
 */

/**
 * Creates a room for the topic specified.  The room that is created depends on the enum passed.
 * @param topicName - The channel name this room represents.
 * @param room_type_enum - The type of room the factory should create.
 * @returns {RoomIF}
 */
function createRoom(topicName, room_type_enum) {
    let created_room = null;
    switch(room_type_enum) {
        case types.ROOM_TYPE.STANDARD: {
            created_room = new CoreRoom(topicName);
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
            created_room.addMiddleware(out_auth_middleware, types.CONNECTOR_TYPE_ENUM.CLUSTER);

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
            
            new_decision_matrix.addRule(new AssignToHdbChildWorkerRule(), types.CONNECTOR_TYPE_ENUM.CLUSTER);

            let write_transaction_rule = new WriteToTransactionLogRule();
            new_decision_matrix.addRule(write_transaction_rule, types.CONNECTOR_TYPE_ENUM.CLUSTER);
            new_decision_matrix.addRule(write_transaction_rule, types.CONNECTOR_TYPE_ENUM.CORE);

            created_room.setDecisionMatrix(new_decision_matrix);
            break;
        }
        case types.ROOM_TYPE.WORKER_ROOM: {
            created_room = new WorkerRoom(topicName);
            break;
        }
        default:
            // Don't default to anything.  A incorrectly created room is severe enough to warrant an exception
            log.error('Got an invalid room type in roomFactory.  No Room created.');
            throw new Error('Invalid Room type.');
    }
    return created_room;
}

module.exports = {
    createRoom: createRoom
};
