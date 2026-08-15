import { sockets } from '../../plugin/sockets';
import { AbstractStatefulAction } from '../BaseWsAction';
import { StateEnum } from '../StateEnum';
import { globalSettings } from '../globalSettings';
import { getScenesLists } from '../lists';
import { ContextData, DialRotateData, DialUpData, SocketSettings, TouchTapData } from '../types';

// Settings are a fixed `studioTarget` plus dynamic per-scene exclusion keys (`exclude__<sceneName>`),
// generated in the property inspector once the scene list is known - see fields.js/pi.js. Display aliases
// are global (set in the general configuration, shared by every dial) rather than a per-scene settings key
type ActionSettings = { studioTarget?: 'preview' | 'program' } & Record<string, string | undefined>;
type Scene = { sceneName: string };
type FilteredScene = { sceneName: string, displayName: string };

export class ScenePreviewDialAction extends AbstractStatefulAction<ActionSettings, 'StudioModeStateChanged'> {
	// Per-socket OBS state, shared across every context targeting that socket - a socket only ever has
	// one preview/program scene, so unlike volume/mute (per-input) this doesn't need to be per-context
	private _scenesCache: (string[] | undefined)[] = new Array(sockets.length).fill(undefined);
	private _currentProgramSceneName: (string | undefined)[] = new Array(sockets.length).fill(undefined);
	private _currentPreviewSceneName: (string | undefined)[] = new Array(sockets.length).fill(undefined);
	private _studioModeEnabled: boolean[] = new Array(sockets.length).fill(false);

	// Per-context, per-socket: the scene the dial is currently browsing to, not yet committed to OBS.
	// Rotating only ever changes this - it's applied to OBS solely on dial push / screen tap
	private _selectedSceneCache = new Map<string, (string | undefined)[]>();

	constructor() {
		super('dev.theca11.multiobs.scenepreviewdial', { statusEvent: 'StudioModeStateChanged', hideTargetIndicators: true });

		this.onDialRotate((evtData: DialRotateData<unknown>) => {
			const { context, payload } = evtData;
			if (!this.contexts.has(context)) return;
			const { settings, displayIdx } = this.contexts.get(context)!;
			this._warnIfDisconnected(context, settings);
			if (!this._selectedSceneCache.has(context)) this._selectedSceneCache.set(context, new Array(sockets.length).fill(undefined));
			const selectedCache = this._selectedSceneCache.get(context)!;

			settings.forEach((socketSettings, socketIdx) => {
				if (!socketSettings) return;
				const filtered = this._getFilteredScenes(socketSettings, socketIdx);
				if (!filtered.length) return;
				const currentName = selectedCache[socketIdx] ?? this._getLiveSceneName(socketSettings, socketIdx);
				const currentIdx = Math.max(0, filtered.findIndex(s => s.sceneName === currentName));
				const newIdx = ((currentIdx + payload.ticks) % filtered.length + filtered.length) % filtered.length;
				selectedCache[socketIdx] = filtered[newIdx].sceneName;
			});
			this._updateDialFeedback(context, displayIdx);
		});

		// Push the dial - commit the browsed-to scene to the configured target
		this.onDialUp(async (evtData: DialUpData<unknown>) => {
			const { context } = evtData;
			if (!this.contexts.has(context)) return;
			const { settings, displayIdx } = this.contexts.get(context)!;
			this._warnIfDisconnected(context, settings);
			const selectedCache = this._selectedSceneCache.get(context);
			await Promise.allSettled(settings.map(async (socketSettings, socketIdx) => {
				if (!socketSettings || !sockets[socketIdx].isConnected) return;
				const sceneName = selectedCache?.[socketIdx] ?? this._getLiveSceneName(socketSettings, socketIdx);
				if (!sceneName) return;
				if (socketSettings.studioTarget === 'program') {
					await sockets[socketIdx].call('SetCurrentProgramScene', { sceneName });
					// Update optimistically for an immediate display refresh - the real CurrentProgramSceneChanged
					// echo will confirm it shortly after anyway
					this._currentProgramSceneName[socketIdx] = sceneName;
					return;
				}
				if (!this._studioModeEnabled[socketIdx]) return;
				await sockets[socketIdx].call('SetCurrentPreviewScene', { sceneName });
				this._currentPreviewSceneName[socketIdx] = sceneName;
			}));
			// Commit is done - there's no more in-progress browse to protect, so go back to passively
			// tracking live state (same as a tap) instead of staying pinned and missing later external changes
			this._selectedSceneCache.set(context, new Array(sockets.length).fill(undefined));
			this._updateDialFeedback(context, displayIdx);
		});

		// Tap the screen - discard any un-committed browsing and snap back to whatever is currently live
		this.onTouchTap((evtData: TouchTapData<unknown>) => {
			const { context } = evtData;
			if (!this.contexts.has(context)) return;
			const { settings, displayIdx } = this.contexts.get(context)!;
			this._warnIfDisconnected(context, settings);
			this._selectedSceneCache.set(context, new Array(sockets.length).fill(undefined));
			this._updateDialFeedback(context, displayIdx);
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

		// A display name alias may have changed in the general configuration - refresh titles to match
		$SD.onDidReceiveGlobalSettings(() => {
			for (const [context, { displayIdx }] of this.contexts) {
				this._updateDialFeedback(context, displayIdx);
			}
		});
	}

	override async onContextAppear(context: string, { displayIdx }: ContextData<ActionSettings>): Promise<void> {
		$SD.setFeedbackLayout(context, 'actions/scenepreviewdial/layout.json');
		this._selectedSceneCache.set(context, new Array(sockets.length).fill(undefined));
		this._updateDialFeedback(context, displayIdx);
	}

	override async onContextDisappear(context: string): Promise<void> {
		this._selectedSceneCache.delete(context);
	}

	override async onContextSettingsUpdated(context: string, { displayIdx }: ContextData<ActionSettings>): Promise<void> {
		// Target/aliases/exclusions may have changed - drop the in-progress candidate and re-derive from live state
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

	/**
	 * The name of the scene currently live for the given context's configured target (preview or program)
	 */
	private _getLiveSceneName(socketSettings: SocketSettings<ActionSettings> | null, socketIdx: number): string | undefined {
		return socketSettings?.studioTarget === 'program' ? this._currentProgramSceneName[socketIdx] : this._currentPreviewSceneName[socketIdx];
	}

	/**
	 * The socket's scene list with excluded scenes removed (per this context's settings) and display
	 * aliases applied (global, from the general configuration - shared across every dial)
	 */
	private _getFilteredScenes(socketSettings: SocketSettings<ActionSettings>, socketIdx: number): FilteredScene[] {
		const scenes = this._scenesCache[socketIdx] ?? [];
		return scenes
		.filter(sceneName => socketSettings?.[`exclude__${sceneName}`] !== 'true')
		.map(sceneName => ({ sceneName, displayName: globalSettings[`sceneAlias__${sceneName}`] || sceneName }));
	}

	/**
	 * Refresh the dial feedback for contexts targeting `changedTarget` on this socket, unless the user has
	 * an unsaved candidate selection in progress (rotated but not yet committed) - that takes priority
	 */
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

	/**
	 * Render the scene the dial is currently browsing to on the touch display: the dial's fixed target
	 * (Preview/Program) as the title, the scene name (aliased) as the value, an indicator bar showing its
	 * position within the (filtered) scene list, and a status label when the browsed-to scene is already
	 * the one set for this dial's target (nothing would happen on commit).
	 * With no scenes to show (disconnected, or every scene excluded) the value reads "No Scenes" - checked
	 * first since a disconnected socket also clears studioModeEnabled, and that isn't really what's wrong.
	 * Otherwise, targeting Preview while Studio Mode is genuinely off (but still connected, with scenes)
	 * reads "Studio Mode Off" instead, since Preview has no meaning outside Studio Mode.
	 */
	private _updateDialFeedback(context: string, displayIdx: number) {
		if (!this.contexts.has(context)) return;
		const { settings } = this.contexts.get(context)!;
		const socketSettings = settings[displayIdx];
		const target = socketSettings?.studioTarget === 'program' ? 'program' : 'preview';
		const title = target === 'program' ? 'Program' : 'Preview';

		const filtered = socketSettings ? this._getFilteredScenes(socketSettings, displayIdx) : [];
		if (!filtered.length) {
			$SD.setFeedback(context, this._dimFeedback({ status: '', title, value: 'No Scenes', indicator: 0 }, displayIdx));
			return;
		}
		if (target === 'preview' && !this._studioModeEnabled[displayIdx]) {
			$SD.setFeedback(context, this._dimFeedback({ status: '', title, value: 'Studio Mode Off', indicator: 0 }, displayIdx));
			return;
		}
		const currentName = this._selectedSceneCache.get(context)?.[displayIdx] ?? this._getLiveSceneName(socketSettings, displayIdx);
		const idx = Math.max(0, filtered.findIndex(s => s.sceneName === currentName));
		const percent = filtered.length > 1 ? Math.round((idx / (filtered.length - 1)) * 100) : 100;
		const isLive = filtered[idx].sceneName === this._getLiveSceneName(socketSettings, displayIdx);
		$SD.setFeedback(context, this._dimFeedback({
			status: isLive ? '● SELECTED' : '',
			title,
			value: filtered[idx].displayName,
			indicator: percent,
		}, displayIdx));
	}
}
