"use strict";
const types = require('../types');

/**
 * This is a super class designed to represent a middleware function that is evaluated upon receipt of an inbound message.
 */

class MiddlewareIF {
    get eval_function() {
        return this._eval_function;
    }

    set eval_function(value) {
        this._eval_function = value;
    }
    get middleware_type_enum() {
        return this._middleware_type_enum;
    }

    set middleware_type_enum(value) {
        this._middleware_type_enum = value;
    }
    constructor(middleware_type_enum, eval_function) {
        this.middleware_type = middleware_type_enum;
        this.evalFunction = eval_function;
        this.command_order = types.COMMAND_EVAL_ORDER_ENUM.MID;
        this._middleware_type_enum = middleware_type_enum;
        this._eval_function = eval_function;
    }

    /**
     * Evaluates the stored function
     * @throws
     */
    evalFunction() {
        throw new Error('Not Implemented.');
    }

    setMiddlewareOrder(command_eval_order_enum) {
        log.trace(`setting command order to: ${command_eval_order_enum}`);
        if(command_eval_order_enum >= 0) {
            this.command_order = command_eval_order_enum;
        }
    }
}

module.exports = MiddlewareIF;