import { AbstractStatelessAction } from '../BaseWsAction';
import { getIngestPage, getIngestPageCount, onIngestPageChanged, onIngestsUpdated } from '../irltkIngests';
import { ContextData } from '../types';

type ActionSettings = { titleTemplate?: string }

/**
 * Pure display of the shared IRLToolkit ingest virtual page, as a user-configurable title template (like
 * IrltkIngestStatusAction's titleTemplate) supporting {page}/{count} variables - see
 * IrltkIngestPagePrevAction for the full paging design note. No press behavior of its own. Shown via the
 * key's native title rather than text drawn into the key image, so it's unaffected by the shared
 * renderer's connection-state dimming - it's not a state
 */
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

	// Static key_on image only (set in manifest.json) - the page number lives entirely in the title,
	// so the shared per-pixel image renderer (and its connection-state dimming) never comes into play
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
