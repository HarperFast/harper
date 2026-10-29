const env = require('#src/utility/environment/environmentManager');
const { CONFIG_PARAMS } = require('#src/utility/hdbTerms');
const parameters = {
	requestBudgetMilliseconds: CONFIG_PARAMS.STORAGE_FULL_TEXT_REQUEST_BUDGET_MILLISECONDS,
	maxRawHitsPerRequest: CONFIG_PARAMS.STORAGE_FULL_TEXT_MAX_RAW_HITS_PER_REQUEST,
	maxResultsPerRequest: CONFIG_PARAMS.STORAGE_FULL_TEXT_MAX_RESULTS_PER_REQUEST,
	runtime: CONFIG_PARAMS.STORAGE_FULL_TEXT_RUNTIME,
};
exports.getFullTextTestConfiguration = () =>
	Object.fromEntries(Object.entries(parameters).map(([name, parameter]) => [name, env.get(parameter)]));
exports.setFullTextTestConfiguration = (value) => {
	for (const [name, parameter] of Object.entries(parameters)) env.setProperty(parameter, value?.[name]);
};
