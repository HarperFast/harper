"use strict";
const RuleIF = require('./RulesIF');
const log = require('../../../../utility/logging/harper_logger');
const types = require('../../types');
const terms = require('../../../../utility/hdbTerms');

/**
 * This worker rule sends a request via socketcluster to an HDBChild for processing in core.
 */
class CallRoomMsgHandlerRule extends RuleIF {
    constructor() {
        super();
        this.setRuleOrder(types.COMMAND_EVAL_ORDER_ENUM.VERY_LAST);
        this.type = types.RULE_TYPE_ENUM.CALL_ROOM_MSG_HANDLER;
    }
    evaluateRule(req, args, worker) {
        log.trace('Evaluating Assign to Hdb Child worker rule');
        if(!worker) {
            log.error('invalid worker sent to CallRoomMsgHandlerRule.');
            return false;
        }

        try {
            let room = worker.getRoom(req.channel);
            if(room) {
                room.inboundMsgHandler(req);
            }
        } catch(err) {
            log.error(err);
            return false;
        }
        return true;
    }
}
module.exports = CallRoomMsgHandlerRule;