import * as env from '../../../utility/environment/environmentManager.ts';
import * as terms from '../../../utility/hdbTerms.ts';

/**
 * Returns header timeout value from config file
 * @returns {*}
 */
function getHeaderTimeoutConfig() {
	return env.get(terms.CONFIG_PARAMS.HTTP_HEADERSTIMEOUT) ?? 60000;
}

export default getHeaderTimeoutConfig;
