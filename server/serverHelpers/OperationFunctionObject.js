'use strict';

/**
 * represents the operation function object used for get operation
 */
class OperationFunctionObject{
    /**
     * @param {function} operation_function
     * @param {function} job_operation_function
     */
    constructor(operation_function, job_operation_function = undefined) {
        this.operation_function = operation_function;
        this.job_operation_function = job_operation_function;
    }
}

module.exports = OperationFunctionObject;