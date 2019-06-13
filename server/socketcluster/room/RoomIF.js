"use strict";
const DecisionMatrixIF = require('../decisionMatrix/DecisionMatrixIF');
const MiddlewareIF = require('../middleware/MiddlewareIF');
const types = require('../types');
const log = require('../../../utility/logging/harper_logger');
const CommandCollection = require('../decisionMatrix/rules/CommandCollection');

/**
 * Represents a socket cluster data channel, as well as any middleware and worker rules that guide what to do with a
 * request on that channel.  Rooms should never be instantiated directly, instead the room factory should be used.
 */
class RoomIF {
    constructor() {
        this.ack_topic = null;
        this.topic = null;
        this.connector_middleware = {};
        this.connector_middleware[types.MIDDLEWARE_TYPE.MIDDLEWARE_PUBLISH_OUT] = new CommandCollection();
        this.connector_middleware[types.MIDDLEWARE_TYPE.MIDDLEWARE_PUBLISH_IN] = new CommandCollection();
        this.connector_middleware[types.MIDDLEWARE_TYPE.MIDDLEWARE_AUTHENTICATE] = new CommandCollection();
        this.connector_middleware[types.MIDDLEWARE_TYPE.MIDDLEWARE_EMIT] = new CommandCollection();
        this.connector_middleware[types.MIDDLEWARE_TYPE.MIDDLEWARE_HANDSHAKE_SC] = new CommandCollection();
        this.connector_middleware[types.MIDDLEWARE_TYPE.MIDDLEWARE_HANDSHAKE_WS] = new CommandCollection();
        this.connector_middleware[types.MIDDLEWARE_TYPE.MIDDLEWARE_SUBSCRIBE] = new CommandCollection();
        this.core_middleware = {};
        this.core_middleware[types.MIDDLEWARE_TYPE.MIDDLEWARE_PUBLISH_OUT] = new CommandCollection();
        this.core_middleware[types.MIDDLEWARE_TYPE.MIDDLEWARE_PUBLISH_IN] = new CommandCollection();
        this.core_middleware[types.MIDDLEWARE_TYPE.MIDDLEWARE_AUTHENTICATE] = new CommandCollection();
        this.core_middleware[types.MIDDLEWARE_TYPE.MIDDLEWARE_EMIT] = new CommandCollection();
        this.core_middleware[types.MIDDLEWARE_TYPE.MIDDLEWARE_HANDSHAKE_SC] = new CommandCollection();
        this.core_middleware[types.MIDDLEWARE_TYPE.MIDDLEWARE_HANDSHAKE_WS] = new CommandCollection();
        this.core_middleware[types.MIDDLEWARE_TYPE.MIDDLEWARE_SUBSCRIBE] = new CommandCollection();

        this.decision_matrix = null;
    }

    /**
     * Evaluate the rules for this channel.  Will return true if all rules pass, false when a rule fails.
     * @param req - The request to run rules against.
     * @param next -
     * @param middleware_type_enum - Denotes the source of this request, currently either from HDBCore or a Clustering connector.
     * @returns {boolean}
     */
    evalMiddleware(req, next, middleware_type_enum) {
        try {
            let middleware_to_eval = [];
            if (!req.hdb_header) {
                //TODO: Need a way to differentiate the connector source when req.data is null (no __transacted flag).  req.data is null in some
                // messages like subscribe.
                middleware_to_eval = this.core_middleware[middleware_type_enum].getCommands();
            } else {
                middleware_to_eval = (req.hdb_header[types.REQUEST_HEADER_ATTRIBUTE_NAMES.DATA_SOURCE] === types.CONNECTOR_TYPE_ENUM.CORE ?
                    this.core_middleware[middleware_type_enum].getCommands() :
                    this.connector_middleware[middleware_type_enum].getCommands());
            }
            for (let i = 0; i < middleware_to_eval.length; i++) {
                if (!middleware_to_eval[i].eval_function) {
                    log.info('There is no function attached to this middleware.');
                    continue;
                }
                let result = middleware_to_eval[i].eval_function(req, next);
                // a defined result means there was a problem in the middleware.
                if (result) {
                    return types.ERROR_CODES.MIDDLEWARE_SWALLOW;
                }
            }
        } catch(err) {
            log.error(err);
            return types.ERROR_CODES.MIDDLEWARE_ERROR;
        }
    }

    /**
     * Sets the decision matrix for this room.
     * @throws
     * @param decision_matrix_if
     */
    setDecisionMatrix(decision_matrix_if) {
        if(!decision_matrix_if) {
            throw new Error('Invalid decision matrix');
        }
        this.decision_matrix = decision_matrix_if;
    }

    /**
     * Sets the topic i.e. channel name this room represents.  Automatically creates an ack topic name for this channel.
     * @returns boolean
     * @param topic_name_string - name of the channel this room represents.
     */
    setTopic(topic_name_string) {
        if(!topic_name_string) {
            log.error('Invalid topic name.');
            return false;
        }
        this.topic = topic_name_string;
        this.ack_topic = `ack${topic_name_string}`;
        return true;
    }

    /**
     * Sets the auth token used by this channel.
     * @returns boolean
     * @param auth_token_string - the auth token for this room.
     */
    setAuthToken(auth_token_string) {
        throw new Error('Not Implemented');
    }

    /**
     * Adds middleware for this room.  A room contains middleware for requests coming from HDBCore and from a cluster.
     * @param middlewareIF_object - The middleware to add
     * @param connector_type_enum - the data source this middleware represents.
     */
    addMiddleware(middlewareIF_object, connector_type_enum) {
        try {
            if(middlewareIF_object) {
                if(connector_type_enum === types.CONNECTOR_TYPE_ENUM.CORE) {
                    this.core_middleware[middlewareIF_object.middleware_type_enum].addCommand(middlewareIF_object);
                } else {
                    this.connector_middleware[middlewareIF_object.middleware_type_enum].addCommand(middlewareIF_object);
                }
            }
        } catch(err) {
            log.error('There was an error adding middleware');
            log.error(err);
        }
    }

    /**
     * Removes any middleware that matches the middleware type.
     * @param enum_middleware_type - The type of middleware to remove
     * @param connector_type_enum - The data source the middleware represents.
     */
    removeMiddleware(enum_middleware_type, connector_type_enum) {
        throw new Error('Not Implemented');
    }

    /**
     * Evaluate the rules for this channel.  Will return true if all rules pass, false when a rule fails.
     * @param request - The request to run rules against.
     * @param worker - The worker instance that needs to act on these rules.
     * @param connector_type_enum - Denotes the source of this request, currently either from HDBCore or a Clustering connector.
     * @returns {boolean}
     */
    async evalRules(request, worker, connector_type_enum, middleware_type) {
        let result = false;
        let cluster_rules_args = {};
        if(!this.decision_matrix) {
            return true;
        }
        try {
            result = await this.decision_matrix.evalRules(request, cluster_rules_args, worker, connector_type_enum, middleware_type);
        } catch(err) {
            log.error('There was an error evaluating rules');
            log.error(err);
            return false;
        }
        return result;
    }

    async publishToRoom(msg) {
        throw new Error('Not Implemented');
    }

    async inboundMsgHandler(input, worker, response) {
        throw new Error('Not Implemented');
    }
}

module.exports = RoomIF;