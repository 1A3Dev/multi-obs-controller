import { globalSettings } from '../globalSettings';
import { clearIngestContextOverride } from '../irltkIngests';
import { KeyUpData } from '../types';

/**
 * Returns to whichever profile was active before the current one (e.g. one opened via Open Ingest
 * Profile). Needs no settings and has nothing to do with OBS - it's a thin wrapper around Stream Deck's
 * own switchToProfile called with no target profile, which the Stream Deck app itself resolves to "go
 * back" regardless of which profile that is, so this doesn't need to know or declare it. Also clears any
 * active Open Ingest Profile override on the way out, so returning restores normal per-button behavior
 */
export class PreviousProfileAction extends Action {
	constructor() {
		super('dev.theca11.multiobs.previousprofile');

		this.onKeyUp(({ context, device }: KeyUpData<Record<string, never>>) => {
			clearIngestContextOverride();
			$SD.switchToProfile(device);
			if (globalSettings.feedback !== 'hide') setTimeout(() => $SD.showOk(context), 150);
		});
	}
}
