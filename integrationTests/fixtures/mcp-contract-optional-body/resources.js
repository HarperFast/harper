import { Resource, t } from 'harper';

export class OptionalIntake extends Resource.withSchema({
	post: { body: t.object({ name: t.string }).optional },
}) {
	post(_target, data) {
		return { omitted: data === undefined, name: data?.name };
	}
}

export class RequiredIntake extends Resource.withSchema({
	post: { body: t.object({ name: t.string }) },
}) {
	post(_target, data) {
		return { omitted: data === undefined, name: data?.name };
	}
}
