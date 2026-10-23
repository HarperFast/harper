/**
 * Returned by a job operation whose outcome is decided after its worker exits — a restore that runs at
 * the next startup. The job stays IN_PROGRESS, naming the durable record that will settle it, instead
 * of reading COMPLETE before anything has happened.
 */
export class DeferredJobCompletion {
	owner: string;
	message: string;
	result?: unknown;
	constructor(owner: string, message: string, result?: unknown) {
		this.owner = owner;
		this.message = message;
		this.result = result;
	}
}
