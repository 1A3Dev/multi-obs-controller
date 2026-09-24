import { registerGlobalListsHandler } from '../BaseWsAction';
import { globalSettings } from '../globalSettings';
import { clearIngestContextOverride } from '../irltkIngests';
import { KeyUpData } from '../types';

export class PreviousProfileAction extends Action {
	constructor() {
		super('uk.1a3.multiobs.previousprofile');
		registerGlobalListsHandler(this);

		this.onKeyUp(({ context, device }: KeyUpData<Record<string, never>>) => {
			clearIngestContextOverride();
			$SD.switchToProfile(device);
			if (globalSettings.feedback !== 'hide') setTimeout(() => $SD.showOk(context), 150);
		});
	}
}
