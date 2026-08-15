import { AbstractStatelessAction } from '../BaseWsAction';
import { getIngestPage, getIngestPageCount, onIngestPageChanged, onIngestsUpdated, setIngestPage } from '../irltkIngests';
import { StateEnum } from '../StateEnum';
import { KeyDownData, PersistentSettings, SocketSettings } from '../types';

type ActionSettings = Record<string, never>

/**
 * Steps the shared IRLToolkit ingest virtual page (see irltkIngests.ts) forward one page. Paired with
 * Ingest Page Previous and Ingest Page Number - see IrltkIngestPagePrevAction for the full design note.
 * Dims itself (via the normal Active/Inactive rendering) when already on the last page
 */
export class IrltkIngestPageNextAction extends AbstractStatelessAction<ActionSettings> {
	constructor() {
		super('dev.theca11.multiobs.irltkingestpagenext', { irltkCompat: 'only' });

		this.onSinglePress(({ context, payload }: KeyDownData<PersistentSettings<ActionSettings>>) => {
			const { settings, isInMultiAction } = payload;
			if (isInMultiAction || !settings.advanced?.longPress) this._nextPage(context);
		});
		this.onLongPress(({ context, payload }: KeyDownData<PersistentSettings<ActionSettings>>) => {
			if (payload.settings.advanced?.longPress) this._nextPage(context);
		});

		const refresh = (socketIdx: number) => this._refreshSocket(socketIdx);
		onIngestsUpdated(refresh);
		onIngestPageChanged(refresh);
	}

	override async fetchState(_socketSettings: SocketSettings<ActionSettings>, socketIdx: number): Promise<StateEnum.Active | StateEnum.Inactive> {
		return getIngestPage(socketIdx) < getIngestPageCount(socketIdx) ? StateEnum.Active : StateEnum.Inactive;
	}

	protected override async getForegroundImage(): Promise<string> {
		return '<path fill="#EFEFEF" d="M54 40L54 104L98 72Z"/>';
	}

	private _nextPage(context: string) {
		const contextData = this.contexts.get(context);
		if (!contextData) return;
		const socketIdx = contextData.displayIdx;
		setIngestPage(socketIdx, getIngestPage(socketIdx) + 1);
	}

	private _refreshSocket(socketIdx: number) {
		for (const [context, contextData] of this.contexts) {
			if (contextData.displayIdx !== socketIdx) continue;
			const newState = getIngestPage(socketIdx) < getIngestPageCount(socketIdx) ? StateEnum.Active : StateEnum.Inactive;
			if (newState !== contextData.states[socketIdx]) {
				this.setContextSocketState(context, socketIdx, newState);
			}
			this.updateKeyImage(context);
		}
	}
}
