"use strict";
const MessageIF = ('../message/MessageIF');
const RuleIF = require('./rules/RulesIF');
const MessageQueueIF = require('../messageQueue/MessageQueueIF');
const types = require('../types');
const log = require('../../../utility/logging/harper_logger');
const CommandCollection = require('./rules/CommandCollection');

/**
 * The decision matrix contains any worker rules and the functions to evaluate them against an
 * inbound request.
 */
class DecisionMatrixIF {
    constructor() {
        this.cluster_rules = {};
        this.cluster_rules[types.MIDDLEWARE_TYPE.MIDDLEWARE_PUBLISH_OUT] = new CommandCollection();
        this.cluster_rules[types.MIDDLEWARE_TYPE.MIDDLEWARE_PUBLISH_IN] = new CommandCollection();
        this.cluster_rules[types.MIDDLEWARE_TYPE.MIDDLEWARE_AUTHENTICATE] = new CommandCollection();
        this.cluster_rules[types.MIDDLEWARE_TYPE.MIDDLEWARE_EMIT] = new CommandCollection();
        this.cluster_rules[types.MIDDLEWARE_TYPE.MIDDLEWARE_HANDSHAKE_SC] = new CommandCollection();
        this.cluster_rules[types.MIDDLEWARE_TYPE.MIDDLEWARE_HANDSHAKE_WS] = new CommandCollection();
        this.cluster_rules[types.MIDDLEWARE_TYPE.MIDDLEWARE_SUBSCRIBE] = new CommandCollection();

        this.core_rules = {};
        this.core_rules[types.MIDDLEWARE_TYPE.MIDDLEWARE_PUBLISH_OUT] = new CommandCollection();
        this.core_rules[types.MIDDLEWARE_TYPE.MIDDLEWARE_PUBLISH_IN] = new CommandCollection();
        this.core_rules[types.MIDDLEWARE_TYPE.MIDDLEWARE_AUTHENTICATE] = new CommandCollection();
        this.core_rules[types.MIDDLEWARE_TYPE.MIDDLEWARE_EMIT] = new CommandCollection();
        this.core_rules[types.MIDDLEWARE_TYPE.MIDDLEWARE_HANDSHAKE_SC] = new CommandCollection();
        this.core_rules[types.MIDDLEWARE_TYPE.MIDDLEWARE_HANDSHAKE_WS] = new CommandCollection();
        this.core_rules[types.MIDDLEWARE_TYPE.MIDDLEWARE_SUBSCRIBE] = new CommandCollection();
    }

    /**
     * @returns boolean
     * @throws
     * @param rule_if_object
     * @param connector_type_enum
     */
    addRule(rule_if_object, connector_type_enum, middleware_type_enum) {
        if(!rule_if_object) {
            throw new Error('Added invalid rule');
        }
        if(connector_type_enum === null || connector_type_enum === undefined) {
            throw new Error('invalid data source passed.');
        }
        if(connector_type_enum === types.CONNECTOR_TYPE_ENUM.CORE) {
            this.core_rules[middleware_type_enum].addCommand(rule_if_object);
            return;
        }
        this.cluster_rules[middleware_type_enum].addCommand(rule_if_object);
    }

    /**
     * Evaluate the rules associated with this room.  Returns true if all rules pass, returns false if a rule fails.
     * @param request - The inbound request
     * @param args - any args for the rules collection
     * @param worker - the worker processing these rules
     * @param connector_type_enum - the source of the inbound request.
     * @returns {Promise<boolean>}
     */
    async evalRules(message_if_object, args, worker, connector_type_enum, middleware_type) {
        throw new Error('Not Implemented.');
    }

    /**
     * Removes the rule matching the rule_id parameter.  returns true on success, false on failure or if rule is not found.
     * @returns boolean
     * @throws
     * @param rule_id - The id of the affected rule
     * @param connector_type_enum - Used to decide which rules collection to look in.
     */
    removeRule(rule_id, connector_type_enum, middleware_type_enum) {
        if(!rule_id) {
            throw new Error('Invalid parameter passed to removeRule');
        }
        if(connector_type_enum === null || connector_type_enum=== undefined) {
            throw new Error('Invalid connector source');
        }
        try {
            if (connector_type_enum === types.CONNECTOR_TYPE_ENUM.CORE) {
                return this.searchAndRemoveRule(this.core_rules[middleware_type_enum], rule_id);
            }
            return this.searchAndRemoveRule(this.cluster_rules[middleware_type_enum], rule_id);
        } catch(err) {
            log.error(`There was an error removing rule with id: ${rule_id}`);
            log.error(err);
            return false;
        }
    }

    /**
     * Removes the rule matching the rule_id parameter.  returns true on success, false on failure or if rule is not found.
     * @returns boolean
     * @throws
     * @param rule_id - The id of the affected rule
     * @param connector_type_enum - Used to decide which rules collection to look in.
     */
    removeRuleByType(rule_type_enum, connector_type_enum, middleware_type_enum) {
        if(!rule_type_enum) {
            throw new Error('Invalid parameter passed to removeRule');
        }
        if(connector_type_enum === null || connector_type_enum=== undefined) {
            throw new Error('Invalid connector source');
        }
        try {
            if (connector_type_enum === types.CONNECTOR_TYPE_ENUM.CORE) {
                return this.core_rules[middleware_type_enum].removeCommandsByType(rule_type_enum);
            }
            return this.cluster_rules[middleware_type_enum].removeCommandsByType(rule_type_enum);
        } catch(err) {
            log.error(`There was an error removing rule with type: ${rule_type_enum}`);
            log.error(err);
            return false;
        }
    }

    /**
     * Returns an array of rules stored for a given connector type.
     * @param connector_type_enum
     * @returns {Array}
     * @throws
     */
    listRules(connector_type_enum, middleware_type_enum) {
        if(!connector_type_enum === null || connector_type_enum === undefined) {
            throw new Error('Invalid parameter passed to listRules');
        }
        // TODO: might need to return a deep copy of the rules so the caller can't modify the rules.
        if(connector_type_enum === types.CONNECTOR_TYPE_ENUM.CORE) {
            return this.core_rules[middleware_type_enum].getCommands();
        }
        return this.cluster_rules[middleware_type_enum].getCommands();
    }

    /**
     * Helper function to remove a rule from a collection of rules.
     * @param rule_collection
     * @param rule_if_object_id
     */
    searchAndRemoveRule(rule_collection, rule_if_object_id) {
        let result = rule_collection.removeCommand(rule_if_object_id);
        return result;
    }
}
module.exports = DecisionMatrixIF;