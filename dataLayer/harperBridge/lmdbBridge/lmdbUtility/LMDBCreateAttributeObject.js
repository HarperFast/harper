'use strict';

const CreateAttributeObject =
	require('../../../CreateAttributeObject.ts').default || require('../../../CreateAttributeObject.ts');

class LMDBCreateAttributeObject extends CreateAttributeObject {
	/**
	 *
	 * @param {String} schema
	 * @param {String} table
	 * @param {String} attribute
	 * @param {*} [id] - optional, the predefined id for this attribute
	 * @param {Boolean} [dupSort] - optional, whether this attribute will allow duplicate keys in the lmdb dbi, defaults to true
	 * @param {Boolean} [isHashAttribute]
	 */
	constructor(schema, table, attribute, id, dupSort = true, isHashAttribute = false) {
		super(schema, table, attribute, id);
		this.dup_sort = dupSort;
		this.isPrimaryKey = isHashAttribute;
	}
}

module.exports = LMDBCreateAttributeObject;
