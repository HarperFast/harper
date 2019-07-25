"use strict";

const RulesIF = require('./RulesIF');
const log = require('../../../../utility/logging/harper_logger');
const types = require('../../types');
const DummyRule = require('./DummyRule');

/**
 * This creates a linked list of rules as they need to be evaluated.  The 0th element should always be the dummy 'base' data,
 * the 1st element should contain the rule that has the COMMAND_EVAL_ORDER_ENUM.VERY_FIRST value, and the (n-1)th data should
 * contain the rule that has the COMMAND_EVAL_ORDER_ENUM.VERY_LAST value.
 */

/**
 * This is used to represent a node in a linked list.
 */
class LinkedListNode {
    constructor(rule) {
        this.next = null;
        this.data = rule;
    }
}

class CommandCollection {
    constructor() {
        // Base is a dummy data that should always exist as the root of the linked list.
        this.base = new LinkedListNode(new DummyRule());
    }

    /**
     * Adds a command to this linked list.  Used the command_order of the node.data to decide where to put it in the linked list.
     * @param ruleIF_object - the RuleIF object to be inserted into the linked list.
     * @throws
     */
    addCommand(ruleIF_object) {
        if(!ruleIF_object) {
            log.warn('Invalid rule passed to addCommand');
            return;
        }
        let target_node = null;
        // Make sure we don't add a duplicate VERY_FIRST rule
        if(this.base.next && ruleIF_object.command_order === types.COMMAND_EVAL_ORDER_ENUM.VERY_FIRST && this.base.next.data.command_order === types.COMMAND_EVAL_ORDER_ENUM.VERY_FIRST) {
            throw new Error('There is already a rule with the VERY_FIRST order, pick a different order');
        }

        target_node = this.findLastInstanceOfEvalOrder(ruleIF_object.command_order);
        if(!target_node) {
            log.error('Did not find a data to insert into');
        }

        // Make sure we don't add a duplicate VERY_LAST command.
        if(ruleIF_object.command_order === types.COMMAND_EVAL_ORDER_ENUM.VERY_LAST && target_node.data.command_order === types.COMMAND_EVAL_ORDER_ENUM.VERY_LAST) {
            throw new Error('There is already a command with the VERY_LAST order, pick a different order');
        }
        this.insertCommandDontCallMeExternallyUseAddCommand(ruleIF_object, target_node);
    }

    /**
     * Returns the list data that contains the data closest to the next eval order enum value.  So if we have a list with elements
     * [0] -> [1] -> [1] -> [2], and we want to find the last instance of 1, this will traverse the list until the 2nd '1' data
     * is set to curr and the loop sees that curr.next.eval_order is 2.
     * @param rule_eval_order_enum
     */
    findLastInstanceOfEvalOrder(rule_eval_order_enum) {
        if(!rule_eval_order_enum) {
            return null;
        }
        if(this.base.next === null) {
            return this.base;
        }
        let curr = this.base;
        let next_eval_order_num = rule_eval_order_enum++;
        while(curr.next !== null && curr.next.data.command_order <= next_eval_order_num) {
            curr = curr.next;
        }
        return curr;
    }

    /**
     * Insert the command after the specified curr_linked_list_node.  THIS SHOULD NEVER BE CALLED, but since Javascript is silly
     * and doesn't offer hiding, do so at your own risk.
     * @param ruleIf_object - a command object
     * @param curr_linked_list_node - The linked list node which will serve as the 'parent' to the new node.  curr_linked_list_node.next will point to this
     *
     */
    insertCommandDontCallMeExternallyUseAddCommand(ruleIf_object, curr_linked_list_node) {
        if(!ruleIf_object) {
            log.error('Passed an invalid command to insertCommandDontCallMeExternallyUseAddCommand');
            return false;
        }
        if(!curr_linked_list_node || !(curr_linked_list_node instanceof LinkedListNode)) {
            log.error('The data passed as the current data in the linked list is invalid');
            return false;
        }
        let new_node = new LinkedListNode(ruleIf_object);
        new_node.next = curr_linked_list_node.next;
        curr_linked_list_node.next = new_node;
        return true;
    }

    /**
     * Remove all rules of a given type.
     * @param rule_type_enum
     * @returns {boolean}
     */
    removeCommandsByType(rule_type_enum) {
        if(!rule_type_enum) {
            log.error('invalid id passed to removeCommand');
            return false;
        }
        if(rule_type_enum === this.base.type) {
            log.error('cannot remove the linked list base');
            return false;
        }
        let curr = this.base;
        let prev = null;
        while(curr != null) {
            if(curr && curr.data && curr.data.type === rule_type_enum) {
                prev.next = curr.next;
                return true;
            }
            if(curr) {
                prev = curr;
            }
            curr = curr.next;
        }
    }

    /**
     * Remove a command from this collection that matches the id parameter.
     * @param command_id
     * @returns {boolean}
     */
    removeCommand(command_id) {
        if(!command_id) {
            log.error('invalid id passed to removeCommand');
            return false;
        }
        if(command_id === this.base.id) {
            log.error('cannot remove the linked list base');
            return false;
        }
        let curr = this.base;
        let prev = null;
        while(curr != null) {
            if(curr && curr.data && curr.data.id === command_id) {
                prev.next = curr.next;
                return true;
            }
            if(curr) {
                prev = curr;
            }
            curr = curr.next;
        }
        // never returned so we didnt find the command.
        return false;
    }

    /**
     * Prints the command linked list for debugging.
     */
    printCommands(print_to_console_bool) {
        let curr = this.base;
        do {
            if(curr !== this.base) {
                let msg = `[type: ${curr.data.constructor.name} - command_id: ${curr.data.id} - eval_order: ${curr.data.command_order}]`;
                log.debug(msg);
                if (print_to_console_bool) {
                    console.log(msg);
                }
            }
            curr = curr.next;
        } while (curr !== null);
    }

    /**
     * No matter what data structure we use to store commands, this function should always return the commands
     * in the order specified by each commands eval_order.  VERY_FIRST should always be the 0th element, HIGH
     * commands should be next in the order they were added, MID commands next in no guaranteed order, LOW commands next in
     * no guaranteed order, VERY_LAST should always be the (n-1)th element in the array.
     */
    getCommands() {
        let command_array = [];
        let index = 0;
        let curr = this.base.next;
        try {
            while (curr) {
                command_array.push(curr.data);
                curr = curr.next;
            }
        } catch(err) {
            log.error('Error traversing commands linked list');
            return command_array;
        }
        return command_array;
    }
}

module.exports = CommandCollection;