import { Scope } from './Scope';

export interface PluginModule {
	handleApplication: (scope: Scope) => void | Promise<void>;
	defaultTimeout?: number;
	suppressHandleApplicationWarning?: boolean;
}
