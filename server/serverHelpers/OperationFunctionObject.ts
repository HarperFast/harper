/**
 * represents the operation function object used for get operation
 */
export class OperationFunctionObject {
	operation_function: Function;
	job_operation_function: Function;

	constructor(operation_function: Function, job_operation_function: Function = undefined) {
		this.operation_function = operation_function;
		this.job_operation_function = job_operation_function;
	}
}
