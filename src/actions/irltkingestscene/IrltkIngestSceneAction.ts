import { sockets } from '../../plugin/sockets';
import { SDUtils } from '../../plugin/utils';
import { AbstractStatefulRequestAction } from '../BaseRequestAction';
import { StateEnum } from '../StateEnum';
import { globalSettings, resolveServers } from '../globalSettings';
import { getIngests, getThresholds, hasIngestTarget, IrltkTargetSettings, isIngestPagingActive, onIngestPageChanged, onIngestsUpdated, resolveIngest, sortIngests } from '../irltkIngests';
import { ContextData, SingleRequestPayload, SocketSettings } from '../types';

type ActionSettings = IrltkTargetSettings & { studioTarget: 'preview' | 'program' }

export class IrltkIngestSceneAction extends AbstractStatefulRequestAction<ActionSettings, 'CurrentProgramSceneChanged'> {
	private _currentSceneName = new Array(sockets.length).fill(null);
	private _currentPreviewSceneName = new Array(sockets.length).fill(null);
	private _studioModeEnabled: boolean[] = new Array(sockets.length).fill(false);

	constructor() {
		super('uk.1a3.multiobs.irltkingestscene', {
			irltkCompat: 'only',
			statusEvent: ['CurrentProgramSceneChanged', 'CurrentPreviewSceneChanged', 'StudioModeStateChanged'],
		});

		sockets.forEach((socket, socketIdx) => {
			socket.on('CurrentProgramSceneChanged', ({ sceneName }) => {
				this._currentSceneName[socketIdx] = sceneName;
			});

			socket.on('CurrentPreviewSceneChanged', ({ sceneName }) => {
				this._currentPreviewSceneName[socketIdx] = sceneName;
			});

			socket.on('StudioModeStateChanged', ({ studioModeEnabled }) => {
				this._studioModeEnabled[socketIdx] = studioModeEnabled;
				this._currentPreviewSceneName[socketIdx] = studioModeEnabled ? this._currentSceneName[socketIdx] : null;
			});
		});

		const refresh = (socketIdx: number) => {
			for (const [context, contextData] of this.contexts) {
				const socketSettings = contextData.settings[socketIdx];
				if (!socketSettings || !hasIngestTarget(socketSettings)) continue;
				this.setContextSocketState(context, socketIdx, this._computeState(socketIdx, socketSettings));
				this.updateKeyImage(context);
				if (contextData.displayIdx === socketIdx) this._updateSceneTitle(context, contextData);
			}
		};
		onIngestsUpdated(refresh);
		onIngestPageChanged(refresh);
	}

	private _resolveSceneName(socketIdx: number, settings: SocketSettings<ActionSettings>): string | undefined {
		const ingest = resolveIngest(getIngests(socketIdx), settings, socketIdx, getThresholds(socketIdx));
		if (!ingest) return undefined;
		const server = resolveServers(globalSettings)[socketIdx];
		const mapping = server?.ingestSceneMap?.find(m => m.ingest === ingest.obs_source_name);
		return mapping?.scene || undefined;
	}

	override getPayloadFromSettings(socketIdx: number, settings: Record<string, never> | Partial<ActionSettings>): SingleRequestPayload<'SetCurrentProgramScene' | 'SetCurrentPreviewScene'> {
		const sceneName = this._resolveSceneName(socketIdx, settings);
		return {
			requestType: (!this._studioModeEnabled[socketIdx] || settings.studioTarget === 'program') ? 'SetCurrentProgramScene' : 'SetCurrentPreviewScene',
			requestData: { sceneName: sceneName as string },
		};
	}

	override async onPropertyInspectorReady({ context, action }: { context: string; action: string; }): Promise<void> {
		const ingestsLists = sockets.map((_, socketIdx) => sortIngests([...getIngests(socketIdx).values()], socketIdx));
		const payload = { event: 'IngestListLoaded', ingestsLists, pagingActive: isIngestPagingActive() };
		$SD.sendToPropertyInspector(context, payload, action);
	}

	override async onSocketConnected(socketIdx: number): Promise<void> {
		const { currentProgramSceneName } = await sockets[socketIdx].call('GetCurrentProgramScene');
		this._currentSceneName[socketIdx] = currentProgramSceneName;
		const { studioModeEnabled } = await sockets[socketIdx].call('GetStudioModeEnabled');
		this._studioModeEnabled[socketIdx] = studioModeEnabled;
		if (studioModeEnabled) {
			const { currentPreviewSceneName } = await sockets[socketIdx].call('GetCurrentPreviewScene');
			this._currentPreviewSceneName[socketIdx] = currentPreviewSceneName;
		}
	}

	override async onSocketDisconnected(socketIdx: number): Promise<void> {
		this._currentSceneName[socketIdx] = null;
		this._currentPreviewSceneName[socketIdx] = null;
		this._studioModeEnabled[socketIdx] = false;
	}

	override async onContextAppear(context: string, contextData: ContextData<ActionSettings>): Promise<void> {
		this._updateSceneTitle(context, contextData);
	}

	override async onContextSettingsUpdated(context: string, contextData: ContextData<ActionSettings>): Promise<void> {
		this._updateSceneTitle(context, contextData);
	}

	override async fetchState(socketSettings: NonNullable<SocketSettings<ActionSettings>>, socketIdx: number): Promise<StateEnum.Active | StateEnum.Intermediate | StateEnum.Inactive> {
		return this._computeState(socketIdx, socketSettings);
	}

	override async shouldUpdateState(evtData: { sceneName: string; }, socketSettings: SocketSettings<ActionSettings>, socketIdx: number): Promise<boolean> {
		return !!socketSettings && hasIngestTarget(socketSettings) && !!this._resolveSceneName(socketIdx, socketSettings);
	}

	override getStateFromEvent(evtData: { sceneName?: string, studioModeEnabled?: boolean }, socketSettings: SocketSettings<ActionSettings>, evtName: 'CurrentProgramSceneChanged' | 'CurrentPreviewSceneChanged' | 'StudioModeStateChanged', socketIdx: number): StateEnum {
		const sceneName = this._resolveSceneName(socketIdx, socketSettings);
		if (!sceneName) return StateEnum.Inactive;

		if (evtName === 'CurrentProgramSceneChanged') {
			return evtData.sceneName === sceneName ? StateEnum.Active : (this._studioModeEnabled[socketIdx] && this._currentPreviewSceneName[socketIdx] === sceneName) ? StateEnum.Intermediate : StateEnum.Inactive;
		}
		else if (evtName === 'CurrentPreviewSceneChanged') {
			return this._currentSceneName[socketIdx] === sceneName ? StateEnum.Active : evtData.sceneName === sceneName ? StateEnum.Intermediate : StateEnum.Inactive;
		}
		else if (evtName === 'StudioModeStateChanged') {
			return this._currentSceneName[socketIdx] === sceneName ? StateEnum.Active : StateEnum.Inactive;
		}

		return StateEnum.Inactive;
	}

	private _computeState(socketIdx: number, socketSettings: SocketSettings<ActionSettings>): StateEnum.Active | StateEnum.Intermediate | StateEnum.Inactive {
		if (!hasIngestTarget(socketSettings)) return StateEnum.Inactive;
		const sceneName = this._resolveSceneName(socketIdx, socketSettings);
		if (!sceneName) return StateEnum.Inactive;
		return sceneName === this._currentSceneName[socketIdx] ? StateEnum.Active : (this._studioModeEnabled[socketIdx] && sceneName === this._currentPreviewSceneName[socketIdx]) ? StateEnum.Intermediate : StateEnum.Inactive;
	}

	private _updateSceneTitle(context: string, contextData: ContextData<ActionSettings>): void {
		if (contextData.isInMultiAction) return;
		const titles = contextData.settings
		.map((socketSettings, socketIdx) => (socketSettings && hasIngestTarget(socketSettings)) ? (this._resolveSceneName(socketIdx, socketSettings) || '?') : null)
		.filter((title): title is string => title !== null);
		const title = [...new Set(titles)].join('\n········\n');
		SDUtils.setKeyTitle(context, title);
	}
}
