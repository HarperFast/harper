"use strict";
const RuleIF = require('./RulesIF');
const log = require('../../../../utility/logging/harper_logger');
const types = require('../../types');
const terms = require('../../../../utility/hdbTerms');

/**
 * This worker rule calls the inboundMsgHandler on its room.  Note this is typically done as part of the
 * standard flow, as a room's inboundMsgHandler is bound to the .watch during creation. However, we may
 * want to act on a request even if it fails middleware or rules, so this exists.
 */
class CallRoomMsgHandlerRule extends RuleIF {
    constructor() {
        super();
        this.setRuleOrder(types.COMMAND_EVAL_ORDER_ENUM.LOW);
        this.type = types.RULE_TYPE_ENUM.CALL_ROOM_MSG_HANDLER;
    }

    /**
     * Evaluate the request against this rule.  Return true if the request passes the rule, false if it does not.
     * @param req - the request
     * @param args - any arguments that are needed during rule evaluation, can be null.
     * @param worker - the worker this rule belongs to.
     * @returns {Promise<boolean>}
     */
    async evaluateRule(req, args, worker) {
        log.trace('Evaluating call handler rule');
        if(!worker) {
            log.error('invalid worker sent to CallRoomMsgHandlerRule.');
            return false;
        }

        if(!req) {
            log.info('Invalid request sent to evaluateRule');
            return false;
        }

        try {
            let room = worker.getRoom(req.channel);
            if(room) {
                await room.inboundMsgHandler(req, worker);
            }
        } catch(err) {
            log.trace('Failed call room msg handler worker rule');
            log.error(err);
            return false;
        }
        return true;
    }
}
module.exports = CallRoomMsgHandlerRule;