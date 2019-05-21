const DecisionMatrixIF = require('./DecisionMatrixIF');
const types = require('../types');
const log = require('../../../utility/logging/harper_logger');

/**
 * Most functions are implemented in DecisionMatrixIF.
 *
 * This is the standard implementation of a decision matrix, used in standard rooms.
 */

class CoreDecisionMatrix extends DecisionMatrixIF {
    constructor() {
        super();
    }

    /**
     * Evaluate the rules associated with this room.  Returns true if all rules pass, returns false if a rule fails.
     * @param request - The inbound request
     * @param args - any args for the rules collection
     * @param worker - the worker processing these rules
     * @param connector_type_enum - the source of the inbound request.
     * @returns {Promise<boolean>}
     */
    async evalRules(request, args, worker, connector_type_enum) {
        log.trace('evaluating matrix rules.');
        let rules = [];
        try {
            rules = (connector_type_enum === types.CONNECTOR_TYPE_ENUM.CORE ? this.core_rules.getCommands() : this.cluster_rules.getCommands());
            if (!rules || rules.length === 0) {
                return true;
            }
            for (let i = 0; i < rules.length; i++) {
                let rule = rules[i];
                let rule_result = await rule.evaluateRule(request, args, worker);
                if (!rule_result) {
                    log.debug(`failed rule: ${rule.id}`);
                    return false;
                }
            }
        } catch(err) {
            log.error('There was a problem evaluating room rules');
            log.error(err);
            return false;
        }
        log.debug(`Passed all ${rules.length} rules.`);
        return true;
    }
}

module.exports = CoreDecisionMatrix;