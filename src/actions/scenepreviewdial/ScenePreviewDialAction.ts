import { sockets } from '../../plugin/sockets';
import { AbstractStatefulAction } from '../BaseWsAction';
import { StateEnum } from '../StateEnum';
import { globalSettings, resolveServers } from '../globalSettings';
import { getIngestSceneMap, getLastKnownIngestNames, isIngestSourceOnline, onIngestsUpdated } from '../irltkIngests';
import { getScenesLists } from '../lists';
import { ContextData, DialDownData, DialRotateData, DialUpData, SocketSettings, TouchTapData } from '../types';

type ActionSettings = { studioTarget?: 'preview' | 'program', useIngestAlias?: 'true', hideOfflineIngestScenes?: 'true', sceneOrder?: string | string[] } & Record<string, string | string[] | undefined>;
type Scene = { sceneName: string };
type FilteredScene = { sceneName: string, offline: boolean };

export class ScenePreviewDialAction extends AbstractStatefulAction<ActionSettings, 'StudioModeStateChanged'> {
	private _scenesCache: (string[] | undefined)[] = new Array(sockets.length).fill(undefined);
	private _currentProgramSceneName: (string | undefined)[] = new Array(sockets.length).fill(undefined);
	private _currentPreviewSceneName: (string | undefined)[] = new Array(sockets.length).fill(undefined);
	private _studioModeEnabled: boolean[] = new Array(sockets.length).fill(false);

	private _selectedSceneCache = new Map<string, (string | undefined)[]>();
	private _holdTimers = new Map<string, NodeJS.Timeout | undefined>();

	constructor() {
		super('uk.1a3.multiobs.scenepreviewdial', { statusEvent: 'StudioModeStateChanged', hideTargetIndicators: true });

		this.onDialRotate((evtData: DialRotateData<unknown>) => {
			const { context, payload } = evtData;
			if (!this.contexts.has(context)) return;
			const { settings, displayIdx } = this.contexts.get(context)!;
			this._warnIfDisconnected(context, settings);
			if (!this._selectedSceneCache.has(context)) this._selectedSceneCache.set(context, new Array(sockets.length).fill(undefined));
			const selectedCache = this._selectedSceneCache.get(context)!;

			settings.forEach((socketSettings, socketIdx) => {
				if (!socketSettings) return;
				const filtered = this._getFilteredScenes(socketSettings, socketIdx, context);
				if (!filtered.length) return;
				const currentName = this._getSelectedSceneName(context, socketSettings, socketIdx, filtered);
				const currentIdx = Math.max(0, filtered.findIndex(s => s.sceneName === currentName));
				const newIdx = ((currentIdx + payload.ticks) % filtered.length + filtered.length) % filtered.length;
				selectedCache[socketIdx] = filtered[newIdx].sceneName;
			});
			this._updateDialFeedback(context, displayIdx);
		});

		// Short press switches to the selected scene, long press reverts the selection to the live scene
		this.onDialDown((evtData: DialDownData<unknown>) => {
			const { context } = evtData;
			if (this._holdTimers.has(context)) return;
			this._holdTimers.set(context, setTimeout(() => {
				this._holdTimers.set(context, undefined);
				this._revertSelection(context);
			}, Number(globalSettings.longPressMs) || 500));
		});

		this.onDialUp((evtData: DialUpData<unknown>) => {
			const { context } = evtData;
			const holdTimer = this._holdTimers.get(context);
			const wasLongPress = this._holdTimers.has(context) && holdTimer === undefined;
			clearTimeout(holdTimer);
			this._holdTimers.delete(context);
			if (!wasLongPress) this._applySelectedScene(context);
		});

		this.onTouchTap((evtData: TouchTapData<unknown>) => {
			const { context, payload } = evtData;
			if (payload.hold) this._revertSelection(context);
			else this._applySelectedScene(context);
		});

		sockets.forEach((socket, socketIdx) => {
			socket.on('CurrentProgramSceneChanged', ({ sceneName }) => {
				this._currentProgramSceneName[socketIdx] = sceneName;
				this._refreshUntouchedContexts(socketIdx, 'program');
			});

			socket.on('CurrentPreviewSceneChanged', ({ sceneName }) => {
				this._currentPreviewSceneName[socketIdx] = sceneName;
				this._refreshUntouchedContexts(socketIdx, 'preview');
			});

			socket.on('StudioModeStateChanged', ({ studioModeEnabled }) => {
				this._studioModeEnabled[socketIdx] = studioModeEnabled;
				if (!studioModeEnabled) this._currentPreviewSceneName[socketIdx] = undefined;
				for (const [context, { displayIdx }] of this.contexts) {
					if (displayIdx === socketIdx) this._updateDialFeedback(context, displayIdx);
				}
			});

			socket.on('SceneListChanged', ({ scenes }) => {
				this._scenesCache[socketIdx] = [...(scenes as Scene[])].reverse().map(s => s.sceneName);
			});
		});

		$SD.onDidReceiveGlobalSettings(() => {
			for (const [context, { displayIdx }] of this.contexts) {
				this._updateDialFeedback(context, displayIdx);
			}
		});

		// Ingest names (needed to look up aliases) and online states are only learned from IRLToolkit status updates
		onIngestsUpdated((socketIdx) => {
			for (const [context, { settings, displayIdx }] of this.contexts) {
				if (displayIdx !== socketIdx) continue;
				const socketSettings = settings[socketIdx];
				if (socketSettings?.useIngestAlias === 'true' || socketSettings?.hideOfflineIngestScenes === 'true') this._updateDialFeedback(context, displayIdx);
			}
		});
	}

	override async onContextAppear(context: string, { displayIdx }: ContextData<ActionSettings>): Promise<void> {
		$SD.setFeedbackLayout(context, 'actions/scenepreviewdial/layout.json');
		this._selectedSceneCache.set(context, new Array(sockets.length).fill(undefined));
		this._updateDialFeedback(context, displayIdx);
	}

	override async onContextDisappear(context: string): Promise<void> {
		clearTimeout(this._holdTimers.get(context));
		this._holdTimers.delete(context);
		this._selectedSceneCache.delete(context);
	}

	private async _applySelectedScene(context: string): Promise<void> {
		if (!this.contexts.has(context)) return;
		const { settings, displayIdx } = this.contexts.get(context)!;
		this._warnIfDisconnected(context, settings);
		await Promise.allSettled(settings.map(async (socketSettings, socketIdx) => {
			if (!socketSettings || !sockets[socketIdx].isConnected) return;
			const sceneName = this._getSelectedSceneName(context, socketSettings, socketIdx, this._getFilteredScenes(socketSettings, socketIdx, context));
			if (!sceneName) return;
			if (socketSettings.studioTarget === 'program') {
				await sockets[socketIdx].call('SetCurrentProgramScene', { sceneName });
				this._currentProgramSceneName[socketIdx] = sceneName;
				return;
			}
			if (!this._studioModeEnabled[socketIdx]) return;
			await sockets[socketIdx].call('SetCurrentPreviewScene', { sceneName });
			this._currentPreviewSceneName[socketIdx] = sceneName;
		}));
		this._selectedSceneCache.set(context, new Array(sockets.length).fill(undefined));
		this._updateDialFeedback(context, displayIdx);
	}

	private _revertSelection(context: string): void {
		if (!this.contexts.has(context)) return;
		const { settings, displayIdx } = this.contexts.get(context)!;
		this._warnIfDisconnected(context, settings);
		this._selectedSceneCache.set(context, new Array(sockets.length).fill(undefined));
		this._updateDialFeedback(context, displayIdx);
	}

	override async onContextSettingsUpdated(context: string, { displayIdx }: ContextData<ActionSettings>): Promise<void> {
		this._selectedSceneCache.set(context, new Array(sockets.length).fill(undefined));
		this._updateDialFeedback(context, displayIdx);
	}

	override async onSocketConnected(socketIdx: number): Promise<void> {
		const { scenes, currentProgramSceneName, currentPreviewSceneName } = await sockets[socketIdx].call('GetSceneList');
		this._scenesCache[socketIdx] = [...(scenes as Scene[])].reverse().map(s => s.sceneName);
		this._currentProgramSceneName[socketIdx] = currentProgramSceneName;
		const { studioModeEnabled } = await sockets[socketIdx].call('GetStudioModeEnabled');
		this._studioModeEnabled[socketIdx] = studioModeEnabled;
		this._currentPreviewSceneName[socketIdx] = studioModeEnabled ? currentPreviewSceneName : undefined;

		for (const [context, { displayIdx }] of this.contexts) {
			if (displayIdx === socketIdx) this._updateDialFeedback(context, displayIdx);
		}
	}

	override async onSocketDisconnected(socketIdx: number): Promise<void> {
		this._scenesCache[socketIdx] = undefined;
		this._currentPreviewSceneName[socketIdx] = undefined;
		this._currentProgramSceneName[socketIdx] = undefined;
		this._studioModeEnabled[socketIdx] = false;

		for (const [context, { displayIdx }] of this.contexts) {
			if (displayIdx === socketIdx) this._updateDialFeedback(context, displayIdx);
		}
	}

	override async onPropertyInspectorReady({ context, action }: { context: string; action: string; }): Promise<void> {
		const scenesLists = await getScenesLists() as Scene[][];
		const payload = { event: 'SceneListLoaded', scenesLists };
		$SD.sendToPropertyInspector(context, payload, action);
	}

	override async fetchState(socketSettings: NonNullable<SocketSettings<ActionSettings>>, socketIdx: number): Promise<StateEnum.Active | StateEnum.Intermediate | StateEnum.Inactive> {
		if (socketSettings.studioTarget === 'program') return StateEnum.Active;
		return this._studioModeEnabled[socketIdx] ? StateEnum.Active : StateEnum.Inactive;
	}

	override async shouldUpdateState(): Promise<boolean> {
		return true;
	}

	override getStateFromEvent(evtData: { studioModeEnabled: boolean }, socketSettings: SocketSettings<ActionSettings>): StateEnum {
		if (socketSettings?.studioTarget === 'program') return StateEnum.Active;
		return evtData.studioModeEnabled ? StateEnum.Active : StateEnum.Inactive;
	}

	private _getLiveSceneName(socketSettings: SocketSettings<ActionSettings> | null, socketIdx: number): string | undefined {
		return socketSettings?.studioTarget === 'program' ? this._currentProgramSceneName[socketIdx] : this._currentPreviewSceneName[socketIdx];
	}

	/** The scene picked by rotating, or the live scene if nothing is picked - a picked scene that no longer exists in the list (e.g. deleted) is dropped */
	private _getSelectedSceneName(context: string, socketSettings: SocketSettings<ActionSettings> | null, socketIdx: number, filtered: FilteredScene[]): string | undefined {
		const selectedCache = this._selectedSceneCache.get(context);
		const selected = selectedCache?.[socketIdx];
		if (selected !== undefined && !filtered.some(s => s.sceneName === selected)) selectedCache![socketIdx] = undefined;
		return selectedCache?.[socketIdx] ?? this._getLiveSceneName(socketSettings, socketIdx);
	}

	/**
	 * Scenes in the custom order first, then any not in it (e.g. newly added) in their OBS order - keep in sync with pi.js orderSceneNames
	 * - scenes with an offline mapped ingest are hidden (if enabled), except the live scene and the one currently picked on the dial
	 */
	private _getFilteredScenes(socketSettings: SocketSettings<ActionSettings>, socketIdx: number, context?: string): FilteredScene[] {
		const scenes = this._scenesCache[socketIdx] ?? [];
		const sceneOrderSetting = socketSettings?.sceneOrder;
		const sceneOrder = (Array.isArray(sceneOrderSetting) ? sceneOrderSetting : sceneOrderSetting ? [sceneOrderSetting] : [])
		.filter(sceneName => scenes.includes(sceneName));
		const hideOffline = socketSettings?.hideOfflineIngestScenes === 'true';
		const keptSceneNames = [this._getLiveSceneName(socketSettings, socketIdx), context ? this._selectedSceneCache.get(context)?.[socketIdx] : undefined];
		return [...sceneOrder, ...scenes.filter(sceneName => !sceneOrder.includes(sceneName))]
		.filter(sceneName => socketSettings?.[`exclude__${sceneName}`] !== 'true')
		.map(sceneName => ({ sceneName, offline: hideOffline && this._isMappedIngestOffline(sceneName, socketIdx) }))
		.filter(({ sceneName, offline }) => !offline || keptSceneNames.includes(sceneName));
	}

	/** True if the scene has ingests mapped in the server's Ingest → Scene map and none of them are online */
	private _isMappedIngestOffline(sceneName: string, socketIdx: number): boolean {
		const mappedIngests = getIngestSceneMap(socketIdx).filter(m => m.scene === sceneName).map(m => m.ingest);
		if (!mappedIngests.length) return false;
		const states = mappedIngests.map(ingest => isIngestSourceOnline(socketIdx, ingest));
		// No IRLToolkit status yet, so the online state is unknown
		if (states.includes(undefined)) return false;
		return !states.includes(true);
	}

	/** Alias of the ingest mapped to this scene in the server's Ingest → Scene map, if one is set */
	private _getMappedIngestAlias(sceneName: string, socketIdx: number): string | undefined {
		const server = resolveServers(globalSettings)[socketIdx];
		const mapping = getIngestSceneMap(socketIdx).find(m => m.scene === sceneName);
		if (!mapping) return undefined;
		const ingestName = getLastKnownIngestNames(socketIdx).get(mapping.ingest) ?? mapping.ingest;
		return server?.ingestAlias?.[ingestName] || undefined;
	}

	private _refreshUntouchedContexts(socketIdx: number, changedTarget: 'preview' | 'program') {
		for (const [context, { settings, displayIdx }] of this.contexts) {
			if (displayIdx !== socketIdx) continue;
			const socketSettings = settings[socketIdx];
			const target = socketSettings?.studioTarget === 'program' ? 'program' : 'preview';
			if (target !== changedTarget) continue;
			if (this._selectedSceneCache.get(context)?.[socketIdx] !== undefined) continue;
			this._updateDialFeedback(context, displayIdx);
		}
	}

	private _updateDialFeedback(context: string, displayIdx: number) {
		if (!this.contexts.has(context)) return;
		const { settings } = this.contexts.get(context)!;
		const socketSettings = settings[displayIdx];
		const target = socketSettings?.studioTarget === 'program' ? 'program' : 'preview';
		const title = target === 'program' ? 'Program' : 'Preview';

		const filtered = socketSettings ? this._getFilteredScenes(socketSettings, displayIdx, context) : [];
		if (!filtered.length) {
			$SD.setFeedback(context, this._dimFeedback({ status: '', title, value: 'No Scenes', indicator: 0 }, displayIdx));
			return;
		}
		if (target === 'preview' && !this._studioModeEnabled[displayIdx]) {
			$SD.setFeedback(context, this._dimFeedback({ status: '', title, value: 'Studio Mode Off', indicator: 0 }, displayIdx));
			return;
		}
		const currentName = this._getSelectedSceneName(context, socketSettings, displayIdx, filtered);
		const idx = Math.max(0, filtered.findIndex(s => s.sceneName === currentName));
		const percent = filtered.length > 1 ? Math.round((idx / (filtered.length - 1)) * 100) : 100;
		const { sceneName, offline } = filtered[idx];
		const isLive = sceneName === this._getLiveSceneName(socketSettings, displayIdx);
		const alias = socketSettings?.useIngestAlias === 'true' ? this._getMappedIngestAlias(sceneName, displayIdx) : undefined;
		const status = [isLive ? '● SELECTED' : '', offline ? 'OFFLINE' : ''].filter(Boolean).join(' · ');
		$SD.setFeedback(context, this._dimFeedback({
			status: { value: status, color: offline ? '#e04848' : '#3ac97a' },
			title,
			value: alias ?? sceneName,
			indicator: percent,
		}, displayIdx));
	}
}
