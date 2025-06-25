/**
 * Component Status System
 * 
 * A simple, clean API for tracking component health across Harper's distributed architecture.
 * 
 * @example Basic usage:
 * ```typescript
 * import { statusForComponent, STATUS } from './components/status';
 * 
 * // Report component status
 * statusForComponent('my-service').healthy('Service initialized');
 * statusForComponent('database').error('Connection timeout', error);
 * statusForComponent('cache').warning('High memory usage');
 * 
 * // Get component status
 * const status = statusForComponent('my-service').get();
 * ```
 * 
 * @example Lifecycle usage (for component loader):
 * ```typescript
 * import { lifecycle } from './components/status';
 * 
 * lifecycle.loading('my-component');
 * // ... load component ...
 * lifecycle.loaded('my-component', 'Successfully initialized');
 * // or
 * lifecycle.failed('my-component', error);
 * ```
 */

// Public API - clean and simple
export { 
	statusForComponent,  // Main API for reporting status
	lifecycle,           // Component loader lifecycle hooks
	reset,               // Reset all statuses (testing)
	STATUS               // Status level constants
} from './api.ts';

// Only export types that external code needs
export type {
	ComponentStatusLevel,
	AggregatedComponentStatus,
	ComponentStatus
} from './api.ts';


// Internal exports for Harper core only
// These should NOT be used by components
export * as internal from './internal.ts';