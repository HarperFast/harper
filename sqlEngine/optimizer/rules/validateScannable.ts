/**
 * Rule R8: scan validation.
 *
 * After all pushdowns, we walk every Scan in the plan and check that the
 * Resource API will accept the resulting target. Specifically: if no usable
 * index condition was pushed (and `allowFullScan` is off in config), we
 * throw EngineUnsupportedError naming the offending scan so the router can
 * fall back to legacy in 'auto' mode.
 *
 * Phase 1 keeps the check loose: any pushedFilter that maps to at least one
 * Resource API condition with an indexed attribute is sufficient. Filtering
 * decisions sit in optimizer/whereToConditions.ts.
 */

import type { LogicalPlan, LogicalScan } from '../../logical/op.ts';
import { EngineUnsupportedError } from '../../errors.ts';
import { whereToConditions, conditionUsesIndex, sortDrivesIndex } from '../whereToConditions.ts';
import { getSqlEngineConfig } from '../../config.ts';

export function validateScannable(plan: LogicalPlan): LogicalPlan | null {
	const cfg = getSqlEngineConfig();
	walk(plan, cfg.allowFullScan);
	return null;
}

function walk(plan: LogicalPlan, allowFullScan: boolean): void {
	if (plan.kind === 'Scan') {
		validateScan(plan, allowFullScan);
		return;
	}
	if ('input' in plan) walk(plan.input, allowFullScan);
	if ('left' in plan) walk(plan.left, allowFullScan);
	if ('right' in plan) walk(plan.right, allowFullScan);
}

function validateScan(scan: LogicalScan, allowFullScan: boolean): void {
	if (allowFullScan) return;
	// Inner side of an index-nested-loop join: served by a per-outer-row indexed
	// equality probe, not a standalone scan.
	if (scan.joinProbe) return;
	// whereToConditions, given the table's attributes, pushes only conditions on
	// indexed attributes (unindexed predicates are residualized into a post-scan
	// Filter). The scan is valid only if at least one pushed condition can drive
	// an index seek/range — a lone full-scan comparator (e.g. LIKE→contains) or a
	// pushed sort is treated by Table.search as needFullScan and rejected under
	// allowFullScan:false, so reject here too and let 'auto' fall back to legacy.
	const { conditions } = whereToConditions(scan.pushedFilter, scan.boundTable?.attributes);
	if (conditions.some((c) => conditionUsesIndex(c, scan.boundTable?.attributes))) return;
	// A sort pushed onto an indexed attribute drives the scan via the index's
	// natural order (D-219): rows stream ordered from the index and a pushed LIMIT
	// early-terminates, so it's a valid scan even with no index-driving predicate.
	if (sortDrivesIndex(scan.pushedSort, scan.boundTable?.attributes)) return;
	throw new EngineUnsupportedError(
		`scan on "${scan.table.database}.${scan.table.table}" has no usable index condition`,
		scan.pushedFilter
	);
}
