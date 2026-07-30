/**
 * Status Hierarchy Builder
 *
 * Builds a tree-structured view of component status from the flat status map.
 * Component names are split on '.' to create parent-child relationships.
 * Parent status rolls up from children (worst status wins).
 */

import {
	type ComponentStatusLevel,
	type ComponentStatusSource,
	type AggregatedComponentStatus,
	COMPONENT_STATUS_LEVELS,
} from './types.ts';

export interface StatusNode {
	status: ComponentStatusLevel;
	message?: string;
	source?: ComponentStatusSource;
	lastChecked?: { main?: number; workers: Record<number, number> };
	occurrenceCount?: number;
	error?: Error | string;
	children?: Record<string, StatusNode>;
}

const STATUS_PRIORITY: Record<ComponentStatusLevel, number> = {
	[COMPONENT_STATUS_LEVELS.ERROR]: 4,
	[COMPONENT_STATUS_LEVELS.WARNING]: 3,
	[COMPONENT_STATUS_LEVELS.LOADING]: 2,
	[COMPONENT_STATUS_LEVELS.UNKNOWN]: 1,
	[COMPONENT_STATUS_LEVELS.HEALTHY]: 0,
};

/**
 * Build a hierarchical status tree from a flat map of aggregated statuses.
 * Names are split on '.' to create parent/child structure.
 *
 * Example:
 *   'system.disk' -> { system: { children: { disk: { status: 'warning', ... } } } }
 *   'replication' -> { replication: { status: 'error', ... } }
 */
export function buildHierarchy(statuses: Map<string, AggregatedComponentStatus>): Record<string, StatusNode> {
	const root: Record<string, StatusNode> = {};

	for (const [name, status] of statuses) {
		const parts = name.split('.');
		let currentLevel = root;

		for (let i = 0; i < parts.length; i++) {
			const part = parts[i];
			if (!currentLevel[part]) {
				currentLevel[part] = {
					status: COMPONENT_STATUS_LEVELS.HEALTHY,
				};
			}
			const node = currentLevel[part];

			if (i === parts.length - 1) {
				// Leaf node -- set actual status from aggregated data
				node.status = status.status;
				node.message = status.latestMessage;
				node.source = status.source;
				node.lastChecked = status.lastChecked;
				node.occurrenceCount = status.occurrenceCount;
				if (status.error) node.error = status.error;
			} else {
				// Intermediate node -- ensure children map exists
				if (!node.children) node.children = {};
				currentLevel = node.children;
			}
		}
	}

	rollUpStatus(root);
	return root;
}

/**
 * Roll up status from children to parents.
 * A parent's status is the worst (highest priority) status among its children.
 */
function rollUpStatus(nodes: Record<string, StatusNode>): ComponentStatusLevel {
	let worstStatus: ComponentStatusLevel = COMPONENT_STATUS_LEVELS.HEALTHY;

	for (const node of Object.values(nodes)) {
		let nodeStatus = node.status;

		if (node.children) {
			const childWorst = rollUpStatus(node.children);
			// Parent status = worst of own status and children's worst
			if (STATUS_PRIORITY[childWorst] > STATUS_PRIORITY[nodeStatus]) {
				nodeStatus = childWorst;
				node.status = nodeStatus;
			}
		}

		if (STATUS_PRIORITY[nodeStatus] > STATUS_PRIORITY[worstStatus]) {
			worstStatus = nodeStatus;
		}
	}

	return worstStatus;
}
