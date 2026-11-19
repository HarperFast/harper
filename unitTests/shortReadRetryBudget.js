const { _setRetryBudgetForTests } = require('#src/config/configReadRetry');

const SHORT_READ_RETRY_BUDGET_MS = 400;

/**
 * The config read ladder is bounded by wall clock, so a case whose subject is what happens *after*
 * the ladder gives up can only get there by waiting out the shipped 3.1 s budget. Call this at the
 * top of such a case — before the watcher that owns the ladder is constructed — and it gives up in
 * a fraction of a second instead. `restoreReadRetryBudget()` belongs in the file's `afterEach`.
 *
 * Not for a case that asserts what the ladder does while it is still running, and not for one that
 * asserts a non-event across a fixed wait: a budget shorter than that wait makes it pass vacuously.
 *
 * The shortened budget still walks four rungs at a growing backoff, and `configReadRetry.test.js`
 * spends the shipped budget in full, so the value that ships stays under test.
 *
 * @param {number} [budgetMs]
 */
function useShortReadRetryBudget(budgetMs = SHORT_READ_RETRY_BUDGET_MS) {
	_setRetryBudgetForTests(budgetMs);
}

function restoreReadRetryBudget() {
	_setRetryBudgetForTests();
}

module.exports = { useShortReadRetryBudget, restoreReadRetryBudget, SHORT_READ_RETRY_BUDGET_MS };
