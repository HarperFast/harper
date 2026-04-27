import { Scope } from './Scope.js';

export interface PluginModule {
	handleApplication: (scope: Scope) => void | Promise<void>;
	defaultTimeout?: number;
}
