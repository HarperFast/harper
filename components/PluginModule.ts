import { Scope } from './Scope.ts';

export interface PluginModule {
	handleApplication: (scope: Scope) => void | Promise<void>;
	defaultTimeout?: number;
}
