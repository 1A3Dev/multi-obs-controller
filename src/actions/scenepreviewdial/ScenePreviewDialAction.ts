import { sockets } from '../../plugin/sockets';
import { AbstractStatefulAction } from '../BaseWsAction';
import { StateEnum } from '../StateEnum';
import { globalSettings, resolveServers } from '../globalSettings';
import { getIngestSceneMap, getLastKnownIngestNames, isIngestSourceOnline, onIngestsUpdated } from '../irltkIngests';
import { getScenesLists } from '../lists';
import { DialDownData, DialRotateData, DialUpData, SocketSettings, TouchTapData } from '../types';

type ActionSettings = { studioTarget?: 'preview' | 'program', useIngestAlias?: 'true', hideOfflineIngestScenes?: 'true', sceneOrder?: string | string[] } & Record<string, string | string[] | undefined>;
type Scene = { sceneName: string };
/** One stop on the dial - the scene to switch to on each OBS instance (indexed by socket), undefined where that instance doesn't have it */
type DialEntry = { label: string, sceneNames: (string | undefined)[], offline: boolean, live: boolean };

export class ScenePreviewDialAction extends AbstractStatefulAction<ActionSettings, 'StudioModeStateChanged'> {
	private _scenesCache: (string[] | undefined)[] = new Array(sockets.length).fill(undefined);
	private _currentProgramSceneName: (string | undefined)[] = new Array(sockets.length).fill(undefined);
	private _currentPreviewSceneName: (string | undefined)[] = new Array(sockets.length).fill(undefined);
	private _studioModeEnabled: boolean[] = new Array(sockets.length).fill(false);

	/** <context, label of the entry picked by rotating> - unset while following the live scene */
	private _selectedEntryCache = new Map<string, string>();
	private _holdTimers = new Map<string, NodeJS.Timeout | undefined>();

	constructor() {
		super('dev.theca11.multiobs.scenepreviewdial', { statusEvent: 'StudioModeStateChanged', hideTargetIndicators: true });

		this.onDialRotate((evtData: DialRotateData<unknown>) => {
			const { context, payload } = evtData;
			if (!this.contexts.has(context)) return;
			this._warnIfDisconnected(context, this.contexts.get(context)!.settings);
			const entries = this._getEntries(context);
			if (!entries.length) return;
			const currentIdx = this._getCurrentEntryIdx(context, entries);
			const newIdx = ((currentIdx + payload.ticks) % entries.length + entries.length) % entries.length;
			this._selectedEntryCache.set(context, entries[newIdx].label);
			this._updateDialFeedback(context);
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

			socket.on('StudioModeStateChanged', async ({ studioModeEnabled }) => {
				this._studioModeEnabled[socketIdx] = studioModeEnabled;
				// OBS copies the program scene into preview on enable without firing CurrentPreviewSceneChanged
				this._currentPreviewSceneName[socketIdx] = studioModeEnabled ? this._currentProgramSceneName[socketIdx] : undefined;
				this._refreshSocketContexts(socketIdx);
				if (!studioModeEnabled) return;
				try {
					const { currentPreviewSceneName } = await socket.call('GetCurrentPreviewScene');
					if (!this._studioModeEnabled[socketIdx] || currentPreviewSceneName === this._currentPreviewSceneName[socketIdx]) return;
					this._currentPreviewSceneName[socketIdx] = currentPreviewSceneName;
					this._refreshSocketContexts(socketIdx);
				}
				catch {
					// Studio mode was disabled again before the request completed
				}
			});

			socket.on('SceneListChanged', ({ scenes }) => {
				this._scenesCache[socketIdx] = [...(scenes as Scene[])].reverse().map(s => s.sceneName);
				this._refreshSocketContexts(socketIdx);
			});
		});

		$SD.onDidReceiveGlobalSettings(() => {
			for (const context of this.contexts.keys()) {
				this._updateDialFeedback(context);
			}
		});

		// Ingest names (needed to look up aliases) and online states are only learned from IRLToolkit status updates
		onIngestsUpdated((socketIdx) => {
			for (const [context, { settings }] of this.contexts) {
				const socketSettings = settings[socketIdx];
				if (socketSettings?.useIngestAlias === 'true' || socketSettings?.hideOfflineIngestScenes === 'true') this._updateDialFeedback(context);
			}
		});
	}

	override async onContextAppear(context: string): Promise<void> {
		$SD.setFeedbackLayout(context, 'actions/scenepreviewdial/layout.json');
		this._selectedEntryCache.delete(context);
		this._updateDialFeedback(context);
	}

	override async onContextDisappear(context: string): Promise<void> {
		clearTimeout(this._holdTimers.get(context));
		this._holdTimers.delete(context);
		this._selectedEntryCache.delete(context);
	}

	private async _applySelectedScene(context: string): Promise<void> {
		if (!this.contexts.has(context)) return;
		const { settings } = this.contexts.get(context)!;
		this._warnIfDisconnected(context, settings);
		const entries = this._getEntries(context);
		const entry = entries[this._getCurrentEntryIdx(context, entries)];
		if (entry) {
			await Promise.allSettled(settings.map(async (socketSettings, socketIdx) => {
				const sceneName = entry.sceneNames[socketIdx];
				if (!socketSettings || !sceneName || !sockets[socketIdx].isConnected) return;
				if (socketSettings.studioTarget === 'program') {
					await sockets[socketIdx].call('SetCurrentProgramScene', { sceneName });
					this._currentProgramSceneName[socketIdx] = sceneName;
					return;
				}
				if (!this._studioModeEnabled[socketIdx]) return;
				await sockets[socketIdx].call('SetCurrentPreviewScene', { sceneName });
				this._currentPreviewSceneName[socketIdx] = sceneName;
			}));
		}
		this._selectedEntryCache.delete(context);
		this._updateDialFeedback(context);
	}

	private _revertSelection(context: string): void {
		if (!this.contexts.has(context)) return;
		this._warnIfDisconnected(context, this.contexts.get(context)!.settings);
		this._selectedEntryCache.delete(context);
		this._updateDialFeedback(context);
	}

	override async onContextSettingsUpdated(context: string): Promise<void> {
		this._selectedEntryCache.delete(context);
		this._updateDialFeedback(context);
	}

	override async onSocketConnected(socketIdx: number): Promise<void> {
		const { scenes, currentProgramSceneName, currentPreviewSceneName } = await sockets[socketIdx].call('GetSceneList');
		this._scenesCache[socketIdx] = [...(scenes as Scene[])].reverse().map(s => s.sceneName);
		this._currentProgramSceneName[socketIdx] = currentProgramSceneName;
		const { studioModeEnabled } = await sockets[socketIdx].call('GetStudioModeEnabled');
		this._studioModeEnabled[socketIdx] = studioModeEnabled;
		this._currentPreviewSceneName[socketIdx] = studioModeEnabled ? currentPreviewSceneName : undefined;
		this._refreshSocketContexts(socketIdx);
	}

	override async onSocketDisconnected(socketIdx: number): Promise<void> {
		this._scenesCache[socketIdx] = undefined;
		this._currentPreviewSceneName[socketIdx] = undefined;
		this._currentProgramSceneName[socketIdx] = undefined;
		this._studioModeEnabled[socketIdx] = false;
		this._refreshSocketContexts(socketIdx);
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

	/** Scenes in the custom order first, then any not in it (e.g. newly added) in their given order, minus excluded ones - keep in sync with pi.js orderSceneNames */
	private _orderScenes(sceneNames: string[], socketSettings: SocketSettings<ActionSettings> | null): string[] {
		const sceneOrderSetting = socketSettings?.sceneOrder;
		const sceneOrder = (Array.isArray(sceneOrderSetting) ? sceneOrderSetting : sceneOrderSetting ? [sceneOrderSetting] : [])
		.filter(sceneName => sceneNames.includes(sceneName));
		return [...sceneOrder, ...sceneNames.filter(sceneName => !sceneOrder.includes(sceneName))]
		.filter(sceneName => socketSettings?.[`exclude__${sceneName}`] !== 'true');
	}

	/**
	 * The stops on the dial, across every targeted OBS instance - scenes with the same dial label (the scene name unless
	 * a custom one is set) switch together, so differently named scenes on each instance can be combined by labelling them the same.
	 * Stops follow the first targeted instance's order, then any only found on later instances.
	 * Stops whose scenes all have an offline mapped ingest are hidden (if enabled), except the live stop and the one currently picked on the dial
	 */
	private _getEntries(context: string): DialEntry[] {
		const { settings } = this.contexts.get(context)!;
		const entriesByLabel = new Map<string, Omit<DialEntry, 'offline' | 'live'>>();
		settings.forEach((socketSettings, socketIdx) => {
			if (!socketSettings) return;
			for (const sceneName of this._orderScenes(this._scenesCache[socketIdx] ?? [], socketSettings)) {
				const customLabel = (socketSettings[`label__${sceneName}`] as string | undefined)?.trim();
				const label = customLabel || sceneName;
				if (!entriesByLabel.has(label)) entriesByLabel.set(label, { label, sceneNames: new Array(sockets.length).fill(undefined) });
				const entry = entriesByLabel.get(label)!;
				// If an instance has several scenes with the same label, the first one in its order wins
				if (entry.sceneNames[socketIdx] === undefined) entry.sceneNames[socketIdx] = sceneName;
			}
		});
		const entries = [...entriesByLabel.values()];

		// The live stop is the one matching the live scene on the most instances
		const liveSceneNames = settings.map((socketSettings, socketIdx) => this._getLiveSceneName(socketSettings, socketIdx));
		let liveIdx = -1, liveScore = 0;
		entries.forEach(({ sceneNames }, idx) => {
			const score = sceneNames.filter((sceneName, socketIdx) => sceneName && sceneName === liveSceneNames[socketIdx]).length;
			if (score > liveScore) [liveIdx, liveScore] = [idx, score];
		});

		const selectedLabel = this._selectedEntryCache.get(context);
		return entries
		.map((entry, idx) => ({
			...entry,
			live: idx === liveIdx,
			offline: entry.sceneNames.every((sceneName, socketIdx) => !sceneName || (settings[socketIdx]?.hideOfflineIngestScenes === 'true' && this._isMappedIngestOffline(sceneName, socketIdx))),
		}))
		.filter(({ label, offline, live }) => !offline || live || label === selectedLabel);
	}

	/** The stop picked by rotating, or the live stop if nothing is picked - a picked stop that no longer exists (e.g. scene deleted) is dropped */
	private _getCurrentEntryIdx(context: string, entries: DialEntry[]): number {
		const selectedLabel = this._selectedEntryCache.get(context);
		if (selectedLabel !== undefined) {
			const selectedIdx = entries.findIndex(({ label }) => label === selectedLabel);
			if (selectedIdx !== -1) return selectedIdx;
			this._selectedEntryCache.delete(context);
		}
		return Math.max(0, entries.findIndex(({ live }) => live));
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

	private _refreshSocketContexts(socketIdx: number) {
		for (const [context, { settings }] of this.contexts) {
			if (settings[socketIdx]) this._updateDialFeedback(context);
		}
	}

	private _refreshUntouchedContexts(socketIdx: number, changedTarget: 'preview' | 'program') {
		for (const [context, { settings }] of this.contexts) {
			const socketSettings = settings[socketIdx];
			if (!socketSettings) continue;
			const target = socketSettings.studioTarget === 'program' ? 'program' : 'preview';
			if (target !== changedTarget) continue;
			if (this._selectedEntryCache.has(context)) continue;
			this._updateDialFeedback(context);
		}
	}

	private _updateDialFeedback(context: string) {
		if (!this.contexts.has(context)) return;
		const { settings, displayIdx } = this.contexts.get(context)!;
		const socketSettings = settings[displayIdx];
		const target = socketSettings?.studioTarget === 'program' ? 'program' : 'preview';
		const title = target === 'program' ? 'Program' : 'Preview';

		const entries = this._getEntries(context);
		if (!entries.length) {
			$SD.setFeedback(context, this._dimFeedback({ status: '', title, value: 'No Scenes', indicator: 0 }, displayIdx));
			return;
		}
		const canSwitch = settings.some((s, socketIdx) => s && (s.studioTarget === 'program' || this._studioModeEnabled[socketIdx]));
		if (!canSwitch) {
			$SD.setFeedback(context, this._dimFeedback({ status: '', title, value: 'Studio Mode Off', indicator: 0 }, displayIdx));
			return;
		}
		const idx = this._getCurrentEntryIdx(context, entries);
		const percent = entries.length > 1 ? Math.round((idx / (entries.length - 1)) * 100) : 100;
		const { label, sceneNames, live, offline } = entries[idx];
		// Uses the ingest alias of the first targeted instance that has a scene at this stop, unless that scene has a custom label
		// (labelling another instance's scene only to combine it shouldn't hide this one's alias)
		const aliasSocketIdx = sceneNames[displayIdx] ? displayIdx : sceneNames.findIndex(sceneName => sceneName);
		const aliasSettings = settings[aliasSocketIdx];
		const aliasSceneName = sceneNames[aliasSocketIdx]!;
		const hasCustomLabel = !!(aliasSettings?.[`label__${aliasSceneName}`] as string | undefined)?.trim();
		const alias = !hasCustomLabel && aliasSettings?.useIngestAlias === 'true' ? this._getMappedIngestAlias(aliasSceneName, aliasSocketIdx) : undefined;
		const status = [live ? '● SELECTED' : '', offline ? 'OFFLINE' : ''].filter(Boolean).join(' · ');
		$SD.setFeedback(context, this._dimFeedback({
			status: { value: status, color: offline ? '#e04848' : '#3ac97a' },
			title,
			value: alias ?? label,
			indicator: percent,
		}, displayIdx));
	}
}
