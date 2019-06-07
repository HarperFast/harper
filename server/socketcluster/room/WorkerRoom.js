"use strict";

const RoomIF = require('./RoomIF');
const types = require('../types');
const log = require('../../../utility/logging/harper_logger');

/**
 * This is a standard room that represents a socketcluster channel, as well as the middleware for that channel, and
 * worker rules for that channel.  Rooms should never be instantiated directly, instead the room factory should be used.
 */
class WorkerRoom extends RoomIF {
    constructor(new_topic_string) {
        super();
        this.setTopic(new_topic_string);
    }

    /**
     * Evaluate the rules for this channel.  Will return true if all rules pass, false when a rule fails.
     * @param request - The request to run rules against.
     * @param worker - The worker instance that needs to act on these rules.
     * @param connector_type_enum - Denotes the source of this request, currently either from HDBCore or a Clustering connector.
     * @returns {boolean}
     */
    async evalRules(request, worker, connector_type_enum) {
        let result = false;
        let cluster_rules_args = {};
        if(!this.decision_matrix) {
            return true;
        }
        try {
            result = await this.decision_matrix.evalRules(request, cluster_rules_args, worker, connector_type_enum);
        } catch(err) {
            log.error('There was an error evaluating rules');
            log.error(err);
            return false;
        }
        return result;
    }
}

module.exports = WorkerRoom;