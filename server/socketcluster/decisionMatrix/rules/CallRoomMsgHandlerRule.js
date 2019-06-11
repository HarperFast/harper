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
            log.error(err);
            return false;
        }
        return true;
    }
}
module.exports = CallRoomMsgHandlerRule;