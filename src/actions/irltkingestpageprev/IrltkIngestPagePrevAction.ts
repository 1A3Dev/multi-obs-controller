import { AbstractStatelessAction } from '../BaseWsAction';
import { getIngestPage, onIngestPageChanged, onIngestsUpdated, setIngestPage } from '../irltkIngests';
import { StateEnum } from '../StateEnum';
import { KeyDownData, PersistentSettings, SocketSettings } from '../types';

type ActionSettings = Record<string, never>

/**
 * Steps the shared IRLToolkit ingest virtual page (see irltkIngests.ts) back one page. Paired with Ingest
 * Page Next and Ingest Page Number, and with Ingest Status/Volume actions viewed via an Open Ingest
 * Profile button (see isIngestPagingActive), to page a fixed row/dial layout through however many
 * ingests are currently online instead of needing multiple real Stream Deck profile pages. Dims itself
 * (via the normal Active/Inactive rendering) when already on page 1
 */
export class IrltkIngestPagePrevAction extends AbstractStatelessAction<ActionSettings> {
	constructor() {
		super('dev.theca11.multiobs.irltkingestpageprev', { irltkCompat: 'only' });

		this.onSinglePress(({ context, payload }: KeyDownData<PersistentSettings<ActionSettings>>) => {
			const { settings, isInMultiAction } = payload;
			if (isInMultiAction || !settings.advanced?.longPress) this._prevPage(context);
		});
		this.onLongPress(({ context, payload }: KeyDownData<PersistentSettings<ActionSettings>>) => {
			if (payload.settings.advanced?.longPress) this._prevPage(context);
		});

		const refresh = (socketIdx: number) => this._refreshSocket(socketIdx);
		onIngestsUpdated(refresh);
		onIngestPageChanged(refresh);
	}

	override async fetchState(_socketSettings: SocketSettings<ActionSettings>, socketIdx: number): Promise<StateEnum.Active | StateEnum.Inactive> {
		return getIngestPage(socketIdx) > 1 ? StateEnum.Active : StateEnum.Inactive;
	}

	protected override async getForegroundImage(): Promise<string> {
		return '<path fill="#EFEFEF" d="M90 40L90 104L46 72Z"/>';
	}

	private _prevPage(context: string) {
		const contextData = this.contexts.get(context);
		if (!contextData) return;
		const socketIdx = contextData.displayIdx;
		setIngestPage(socketIdx, getIngestPage(socketIdx) - 1);
	}

	private _refreshSocket(socketIdx: number) {
		for (const [context, contextData] of this.contexts) {
			if (contextData.displayIdx !== socketIdx) continue;
			const newState = getIngestPage(socketIdx) > 1 ? StateEnum.Active : StateEnum.Inactive;
			if (newState !== contextData.states[socketIdx]) {
				this.setContextSocketState(context, socketIdx, newState);
			}
			this.updateKeyImage(context);
		}
	}
}
