import { Resource } from './Resource.ts';
import type { Context } from './ResourceInterface.ts';

/**
 * ErrorResource is a Resource that throws an error on any request, communicating to the client when attempts are made
 * to access endpoints/resources that had an internal error in their configuration or setup. This helps ensure that
 * if there is a problem with a resource, it is immediately apparent and can be fixed.
 *
 * The class is constructed lazily on first use, not at module load. ErrorResource
 * sits inside Resource.ts's own static-graph SCC, so a class-extends declaration
 * at module-top would TDZ on `Resource`. The Proxy here lets `new ErrorResource(x)`
 * and `ErrorResource.staticMember` work whenever they're called, even when this
 * module is loaded directly (unit tests, scripts) without the lifecycle hooks running.
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
	construct(_target, args) {
		return Reflect.construct(getErrorResource(), args);
	},
	get(_target, prop) {
		return getErrorResource()[prop];
	},
	has(_target, prop) {
		return prop in getErrorResource();
	},
	getPrototypeOf() {
		return getErrorResource().prototype;
	},
});
