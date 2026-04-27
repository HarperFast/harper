'use strict';
import * as terms from '../utility/hdbTerms.js';

export class UpgradeObject {
	[key: string]: any;
	constructor(dataVersion: string, upgradeVersion: string) {
		this[terms.UPGRADE_JSON_FIELD_NAMES_ENUM.DATA_VERSION] = dataVersion;
		this[terms.UPGRADE_JSON_FIELD_NAMES_ENUM.UPGRADE_VERSION] = upgradeVersion;
	}
}
