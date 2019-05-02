"use strict";

const MiddlewareIF = require('./MiddlewareIF');

/**
 * Generic middleware can be instantiated to store a function that does not yet have a premde middleware class.
 */
class GenericMiddleware extends MiddlewareIF {
    constructor(middleware_type_enum, eval_function) {
        super(middleware_type_enum, eval_function);
        this.middleware_type_enum = middleware_type_enum;
        this.eval_function = eval_function;
    }
}

module.exports = GenericMiddleware;