import { METADATA_PROPERTY } from '../utility/hdbTerms.ts';
import { Packr } from 'msgpackr';

export class PackrWithMetadata extends Packr {
	preamble(object, target, position) {
		const metadata = object[METADATA_PROPERTY];
		metadata.updates;
	}

	decode(source, options) {
		// read preamble
		// then
		return super.decode(source, options);
	}
}
