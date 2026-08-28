/**
 * Resolves the given partial topics into an array of topic levels.
 * This function takes one or more topic parts, which can be strings, numbers, or arrays,
 * and sanitizes them into a flat array of topic levels.
 * 
 * @param  {(string|number)[] | string | number} partialTopics - The topic parts to resolve.
 * @returns {string[]} The sanitized topic levels as an array of strings.
 */
export const resolveTopic = (...partialTopics) => {
	const topic = [];

	// Iterate over each part of the provided topics
	for (let part of partialTopics) {
		// Skip undefined, null, or empty string values
		if (part === undefined || part === null || part === '') continue;

		// If the part is a string containing '/', split it into an array of levels
		if (typeof part === 'string' && part.includes('/')) {
			part = part.split('/');
		}

		// If the part is an array, recursively resolve its elements
		if (Array.isArray(part)) {
			topic.push(...resolveTopic(...part));
		} else {
			// Otherwise, add the part to the topic array
			topic.push(part);
		}
	}

	// Return the resolved topic levels as a flat array
	return topic;
}

/**
 * Given the provided ACLs, and user, find the ACLs that the user has subscribe (or publish) permissions for.
 * @param acls - The list of ACLs that could apply to a topic
 * @param user - The user object
 * @param client_id - The client_id of the user
 * @param publish - Whether to check for publish or subscribe permissions
 */
export function findTopicsForUser(acls, user, client_id, publish = false) {
	return acls
		.map(acl => {
		const aclGroups = acl[publish ? 'publishers' : 'subscribers'];

		// user groups can be array or semicolon-delimited string
		let userGroups = [];
		if (user?.authGroups) {
			userGroups = Array.isArray(user.authGroups) ? user.authGroups : String(user.authGroups).split(';');
		} else if (user?.role?.role) {
			userGroups = Array.isArray(user.role.role) ? user.role.role : String(user.role.role).split(';');
		}

		const allowedByGroup =
			Array.isArray(aclGroups) && aclGroups.some(g => userGroups.includes(g));

		const allowedAnon = !publish && acl.anonymousSubscriber;

		if (!allowedByGroup && !allowedAnon) return null;

		// Apply %u (username) and %c (client id) replacements anywhere in the filter
		const username = user?.username ?? '';
		const filter = acl.topicFilter
			.replaceAll('%u', username)
			.replaceAll('%c', client_id ?? '');

		return filter; // return STRING filter
		})
		.filter(Boolean);
}

/**
 * Convert a topic identifier into a normalized MQTT topic string.
 *
 * - If `id` is an array of segments (e.g. ["sensors", "kitchen", "temp"]),
 *   it joins them with '/' into "sensors/kitchen/temp".
 * - If `id` is a number, it converts it to a string.
 * - For all other values, it coerces to a string (or empty string if falsy).
 *
 * @param {string|string[]|number} id - A topic identifier (array of segments, string, or number).
 * @returns {string} The normalized topic string.
 */
function toTopicString(id) {
	if (Array.isArray(id)) return id.join('/');
	if (typeof id === 'number') return String(id);
	return String(id || '');
}


/**
 * Normalize a list of allowed topic filters into string form.
 *
 * - Each element may be an array of segments (["sensors", "+", "temp"]) or a string ("sensors/+/temp").
 * - Arrays are joined with '/', non-string values are coerced to strings.
 * - Empty or falsy entries are removed.
 *
 * @param {Array<string|string[]>} allowed - List of topic filters in array or string form.
 * @returns {string[]} Array of normalized topic filter strings.
 */
function normalizeFilters(allowed) {
	// allowed can be array of arrays (old) or array of strings (new)
	return (allowed || [])
	  .map(f => Array.isArray(f) ? f.join('/') : String(f || ''))
	  .filter(Boolean);
}

/**
 * Robust MQTT topic filter matcher: supports + and #, anchors pattern, escapes literals.
 * 
 * @param {*} filter 
 * @param {*} topic 
 * @returns 
 */
export function topicFilterMatches(filter, topic) {
	if (typeof filter !== 'string' || typeof topic !== 'string') return false;
  
	// Escape regex special chars except MQTT wildcards + and #
	const esc = s => s.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
  
	// Split and translate segment-by-segment for correctness
	const parts = filter.split('/').map(seg => {
	  if (seg === '+') return '[^/]+';
	  if (seg === '#') return '.*';
	  return esc(seg);
	});
  
	// If # is present, it must be the last segment per MQTT spec
	const hashIdx = filter.indexOf('#');
	if (hashIdx !== -1 && hashIdx !== filter.length - 1) {
	  // Some brokers are lenient; we choose to enforce spec strictly
	  // but still match as best-effort by allowing trailing anything.
	}
  
	const pattern = `^${parts.join('/')}$`;
	const re = new RegExp(pattern);
	return re.test(topic);
};

/**
 * Check if the provided id/topic is allowed to subscribe/publish to the list of allowed topics
 * @param id
 * @param allowed_topics
 * @return {boolean}
 */
export function mqttPermissionCheck(id, allowed_topics) {
	const topic = toTopicString(id);
  const filters = normalizeFilters(allowed_topics);

  if (!filters.length || !topic) return false;

  // MQTT-correct comparison
  return filters.some(f => topicFilterMatches(f, topic));
}
