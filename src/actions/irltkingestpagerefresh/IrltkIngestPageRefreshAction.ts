import { AbstractStatelessAction } from '../BaseWsAction';
import { StateEnum } from '../StateEnum';
import { globalSettings } from '../globalSettings';
import { refreshIngestPage } from '../irltkIngests';
import { KeyDownData, PersistentSettings, SocketSettings } from '../types';

type ActionSettings = Record<string, never>

/** Re-sort the shared IRLToolkit ingest page, which otherwise keeps every ingest in place until it's reopened */
export class IrltkIngestPageRefreshAction extends AbstractStatelessAction<ActionSettings> {
	constructor() {
		super('dev.theca11.multiobs.irltkingestpagerefresh');

		this.onSinglePress(({ context, payload }: KeyDownData<PersistentSettings<ActionSettings>>) => {
			const { settings, isInMultiAction } = payload;
			if (isInMultiAction || !settings.advanced?.longPress) this._refresh(context);
		});
		this.onLongPress(({ context, payload }: KeyDownData<PersistentSettings<ActionSettings>>) => {
			if (payload.settings.advanced?.longPress) this._refresh(context);
		});
	}

	override async fetchState(): Promise<StateEnum.Active> {
		return StateEnum.Active;
	}

	protected override async getForegroundImage(): Promise<string> {
		return '<polygon fill="#EFEFEF" points="97.5,60.7 94.7,46.5 83.3,57.9"/><path fill="none" stroke="#EFEFEF" stroke-width="9" stroke-linecap="round" d="M98 72A26 26 0 1 1 88 51.5"/>';
	}

	private _refresh(context: string) {
		const contextData = this.contexts.get(context);
		if (!contextData) return;
		contextData.settings.forEach((socketSettings: SocketSettings<ActionSettings> | null, socketIdx) => {
			if (socketSettings) refreshIngestPage(socketIdx);
		});
		if (globalSettings.feedback !== 'hide') $SD.showOk(context);
	}
}
