import { Resource } from './Resource.ts';
import type { Context } from './ResourceInterface.ts';

/**
 * ErrorResource is a Resource that throws an error on any request, communicating to the client when attempts are made
 * to access endpoints/resources that had an internal error in their configuration or setup. This helps ensure that
 * if there is a problem with a resource, it is immediately apparent and can be fixed.
 *
 * Construct lazily because Resource is uninitialized while its ESM cycle evaluates.
 */
let _ErrorResource: any;
function getErrorResource(): any {
	if (!_ErrorResource) {
		_ErrorResource = class ErrorResource extends Resource {
			error: Error;
			constructor(error: Error) {
				super(null as any, null);
				this.error = error;
			}
			isError = true;
			allowRead(): never {
				throw this.error;
			}
			allowUpdate(): never {
				throw this.error;
			}
			allowCreate(): never {
				throw this.error;
			}
			allowDelete(): never {
				throw this.error;
			}
			getId(): never {
				throw this.error;
			}
			getContext(): Context {
				throw this.error;
			}
			get(): never {
				throw this.error;
			}
			post(): never {
				throw this.error;
			}
			put(): never {
				throw this.error;
			}
			delete(): never {
				throw this.error;
			}
			connect(): never {
				throw this.error;
			}
			getResource() {
				// all child paths resolve back to reporting this error
				return this;
			}
			publish(): never {
				throw this.error;
			}
			subscribe(): never {
				throw this.error;
			}
		};
	}
	return _ErrorResource;
}

export const ErrorResource: any = new Proxy(function () {} as any, {
	construct(_target, args, newTarget) {
		return Reflect.construct(getErrorResource(), args, newTarget);
	},
	get(_target, prop) {
		return getErrorResource()[prop];
	},
	has(_target, prop) {
		return prop in getErrorResource();
	},
	getPrototypeOf() {
		return Object.getPrototypeOf(getErrorResource());
	},
});
