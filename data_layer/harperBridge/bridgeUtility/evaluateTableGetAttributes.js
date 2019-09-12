"use strict";

const _ = require('lodash');

module.exports = evaluateTableGetAttributes;

//TODO: we're iterating through the get_attributes parameter 2 times below, once to detect if there is a star attribute,
// and the second time when a star exists we iterate to remove it.
// This is (O)n^2, and not needed - update during next performance pass.
function evaluateTableGetAttributes(get_attributes, table_attributes) {
    let star_attribute =  _.filter(get_attributes, attribute => {
        return attribute === '*' || attribute.attribute === '*';
    });

    if (star_attribute && star_attribute.length > 0) {
        get_attributes = _.filter(get_attributes, attribute => {
            return attribute !== '*' && attribute.attribute !== '*';
        });

        table_attributes.forEach(attribute => {
            get_attributes.push(attribute.attribute);
        });

        return _.uniqBy(get_attributes);
    }

    return get_attributes;
}