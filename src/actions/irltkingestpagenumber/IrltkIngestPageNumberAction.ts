import { AbstractStatelessAction } from '../BaseWsAction';
import { getIngestPage, getIngestPageCount, onIngestPageChanged, onIngestsUpdated } from '../irltkIngests';
import { ContextData } from '../types';

type ActionSettings = { titleTemplate?: string }

export class IrltkIngestPageNumberAction extends AbstractStatelessAction<ActionSettings> {
	constructor() {
		super('dev.theca11.multiobs.irltkingestpagenumber', { irltkCompat: 'only', hideTargetIndicators: true });

		const refresh = (socketIdx: number) => {
			for (const [context, contextData] of this.contexts) {
				if (contextData.displayIdx === socketIdx) this._updatePageTitle(context, contextData);
			}
		};
		onIngestsUpdated(refresh);
		onIngestPageChanged(refresh);
	}

	override async onContextAppear(context: string, contextData: ContextData<ActionSettings>): Promise<void> {
		this._updatePageTitle(context, contextData);
	}

	override async onContextSettingsUpdated(context: string, contextData: ContextData<ActionSettings>): Promise<void> {
		this._updatePageTitle(context, contextData);
	}

	protected override async updateKeyImage(): Promise<void> {
		return;
	}

	private _updatePageTitle(context: string, contextData: ContextData<ActionSettings>): void {
		const { displayIdx, settings } = contextData;
		const template = settings[displayIdx]?.titleTemplate || '{page}/{count}';
		const title = template
		.replace(/\{page\}/g, String(getIngestPage(displayIdx)))
		.replace(/\{count\}/g, String(getIngestPageCount(displayIdx)));
		$SD.setTitle(context, title);
	}
}
