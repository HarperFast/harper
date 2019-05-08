"use strict";

const uuidV4 = require('uuid/v4');
const types = require('../../types');
const log = require('../../../../utility/logging/harper_logger');

/**
 * Worker rules are meant to be a more flexible way of rule enforcement than middleware.  The rules evaluator will have
 * a reference to the worker passed in, making the scServer and exchange available to the rules.  This should avoid the
 * amount of code needed to be in the worker itself, instead abstracted out to these rules.
 */

class RulesIF {
    constructor() {
        this.id = uuidV4();
        this.command_order = types.COMMAND_EVAL_ORDER_ENUM.MID;
    }

    /**
     * @returns boolean.
     */
    async evaluateRule(req, args, worker) {
        throw new Error('Not Implemented.');
    }

    setRuleOrder(rule_eval_order_enum) {
        log.trace(`setting rule order to: ${rule_eval_order_enum}`);

        if(!rule_eval_order_enum) {
            return;
        }
        if(rule_eval_order_enum >= 0) {
            this.command_order = rule_eval_order_enum;
        }
    }
    evaluateRule(req, args, worker) {
        throw new Error('Not Implemented');
    }
}

module.exports = RulesIF;