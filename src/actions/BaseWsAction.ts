import { OBSEventTypes } from 'obs-websocket-js';
import pRetry from 'p-retry';
import { sockets } from '../plugin/sockets';
import { SDUtils } from '../plugin/utils';
import { StateEnum } from './StateEnum';
import { globalSettings, resolveServers, resolveTargetIds, resolveTargetIndices } from './globalSettings';
import { getIngestContextOverride, getIngests, getLastKnownIngestNames, sortIngests } from './irltkIngests';
import { getLastKnownScenes, getScenesLists } from './lists';
import { ContextData, SocketSettings, ConstructorParams, DidReceiveSettingsData, KeyDownData, KeyUpData, PartiallyRequired, PersistentSettings, SendToPluginData, WillAppearData, WillDisappearData } from './types';

/** Base class for all actions used to communicate with OBS WS */
export abstract class AbstractBaseWsAction<T extends Record<string, unknown>> extends Action {
	readonly _actionId;
	private _contexts = new Map<string, ContextData<T>>(); // <context, contextData>

	private _titleParam: string | undefined;	// to-do: this type could be restricted more, something like keyof T?
	private _statesColors = { active: '#517a96', intermediate: '#de902a', inactive: '#3d5b70' };
	private _hideTargetIndicators = false;
	private _irltkCompat: 'only' | 'exclude' | undefined;
	protected _showSuccess = true;

	private _pressCache = new Map<string, NodeJS.Timeout>(); // <context, timeoutRef>
	private _defaultKeyImg: string | undefined;
	static _dirtyImages = new Map<string, string>(); // <context, b64 image>

	constructor(UUID: string, params?: Partial<ConstructorParams>) {
		super(UUID);
		this._actionId = UUID.split('.').at(-1);
		this._titleParam = params?.titleParam;
		this._statesColors = { ...this._statesColors, ...params?.statesColors };
		this._hideTargetIndicators = !!params?.hideTargetIndicators;
		this._irltkCompat = params?.irltkCompat;

		// Load default image
		this._getDefaultKeyImage().then(img => this._defaultKeyImg = img).catch(() => console.warn(`Default key image for ${this.UUID} couldn't be loaded`));

		// -- Main logic when key is pressed --
		this.onKeyDown((evtData: KeyDownData<{ advanced: { longPressMs?: string } }>) => {
			const { context, payload } = evtData;
			const { settings } = payload;

			if (this._pressCache.has(context)) return;

			const timeout = setTimeout(() => {
				this._pressCache.delete(context);
				this.emit(`${this.UUID}.longPress`, evtData);
			}, Number(settings.advanced?.longPressMs) || Number(globalSettings.longPressMs) || 500);
			this._pressCache.set(context, timeout);
		});

		this.onKeyUp((evtData: KeyUpData<unknown>) => {
			const { context } = evtData;
			// Check if long press
			if (!this._pressCache.has(context)) { // it was long press, already processed
				return;
			}
			else {
				clearTimeout(this._pressCache.get(context));
				this._pressCache.delete(context);
				this.emit(`${this.UUID}.singlePress`, evtData);
			}
		});
		// --

		// -- Contexts cache --
		this.onWillAppear(async (evtData: WillAppearData<any>) => {
			const { context, payload } = evtData;
			const { settings, isInMultiAction } = payload;
			this._migrateLegacySettings(context, settings);
			const settingsArray = this.getSettingsArray(settings);
			const targets = this.getTargets(settings);
			const contextData: ContextData<T> = {
				targets,
				displayIdx: targets.length ? Math.min(...targets) - 1 : 0,
				isInMultiAction: !!isInMultiAction,
				settings: settingsArray,
				advancedSettings: settings.advanced,
				states: await this._fetchStates(settingsArray),
			};
			this._contexts.set(context, contextData);
			if (this.onContextAppear) await this.onContextAppear(context, contextData);

			this._updateTitle(context, this._titleParam);
			this.updateKeyImage(context);
			this._updateSDState(context, contextData);
		});

		this.onWillDisappear((evtData: WillDisappearData<any>) => {
			const { context } = evtData;
			this._contexts.delete(context);
			if (this.onContextDisappear) this.onContextDisappear(context);
		});

		this.onDidReceiveSettings(async (evtData: DidReceiveSettingsData<any>) => {
			const { context, payload } = evtData;
			const { settings, isInMultiAction } = payload;
			this._migrateLegacySettings(context, settings);
			const settingsArray = this.getSettingsArray(settings);
			const targets = this.getTargets(settings);
			const contextData: ContextData<T> = {
				targets,
				displayIdx: targets.length ? Math.min(...targets) - 1 : 0,
				isInMultiAction: !!isInMultiAction,
				settings: settingsArray,
				advancedSettings: settings.advanced,
				states: await this._fetchStates(settingsArray),
			};
			this._contexts.set(context, contextData);
			if (this.onContextSettingsUpdated) await this.onContextSettingsUpdated(context, contextData);

			this._updateTitle(context, this._titleParam);
			this.updateKeyImage(context);
			this._updateSDState(context, contextData);
		});
		// --

		// -- Sockets connected/disconnected
		sockets.forEach((socket, socketIdx) => {
			socket.on('Identified', async () => {
				if (this.onSocketConnected && this._isSocketEligible(socketIdx)) {
					await pRetry(() => this.onSocketConnected!(socketIdx), {
						retries: 5,
						minTimeout: 100,
						onFailedAttempt: error => { SDUtils.logActionError(socketIdx, this._actionId, `Error while initializing on socket connected (${error.message}). Attempt #${error.attemptNumber}, retries left ${error.retriesLeft}`); },
					})
					.catch(() => { SDUtils.logActionError(socketIdx, this._actionId, 'All initialization retries failed. Action may not work or may behave unexpectedly'); });
				}
				for (const [context, { settings, states }] of this._contexts) {
					const newState = await this._fetchSocketState(settings[socketIdx], socketIdx).catch(() => StateEnum.Unavailable);
					if (newState !== states[socketIdx]) {
						this.setContextSocketState(context, socketIdx, newState);
						this.updateKeyImage(context);
					}
				}
			});

			// @ts-expect-error Disconnected event is custom of the Socket class, not part of the OBS WS protocol
			socket.on('Disconnected', async () => {
				if (this.onSocketDisconnected) await this.onSocketDisconnected(socketIdx);
				for (const [context, { states }] of this._contexts) {
					if (states[socketIdx] !== StateEnum.Unavailable) {
						this.setContextSocketState(context, socketIdx, StateEnum.Unavailable);
						this.updateKeyImage(context);
					}
				}
			});
		});
		// --

		// Update images on global settings updated
		$SD.onDidReceiveGlobalSettings(() => {
			this.updateImages();
			for (const context of this._contexts.keys()) {
				$SD.getSettings(context);
			}
		});

		// When PI is loaded and ready, extra optional logic per action
		this.onSendToPlugin(async ({ context, action, payload }: SendToPluginData<{ event: string }>) => {
			if (payload.event === 'ready' && this.onPropertyInspectorReady) {
				await this.onPropertyInspectorReady({ context, action })
				.catch(() => SDUtils.logError(`[${this._actionId}] Error executing custom onPropertyInspectorReady()`));
			}
			else if (payload.event === 'reconnect') {
				sockets.forEach(socket => { socket.tryReconnect(); });
			}
			// Requested by the general configuration window (which isn't tied to any one action) to
			// live-populate its ingest/scene name alias editors - handled here, in the common base class
			// constructor, so it's answered regardless of which action's PI the window was opened from.
			// Falls back to each socket's last-known list (see getLastKnownIngestNames/getLastKnownScenes)
			// whenever the live one comes back empty (e.g. socket currently disconnected), so aliases set
			// up while connected stay visible/editable instead of the editor going blank while offline.
			// Unlike the live list, the fallback can't confirm a name still exists, so it's narrowed to
			// only names that already have an alias saved - otherwise every ingest/scene ever seen this
			// session would resurface as an empty, unverifiable row
			else if (payload.event === 'getGlobalLists') {
				const liveIngestsLists = sockets.map((_, socketIdx) => sortIngests([...getIngests(socketIdx).values()]));
				const liveScenesLists = await getScenesLists();
				const ingestsLists = liveIngestsLists.map((live, socketIdx) => {
					if (live.length) return live;
					return [...getLastKnownIngestNames(socketIdx)]
					.filter(([obs_source_name]) => !!globalSettings[`ingestAlias__${obs_source_name}`])
					.map(([obs_source_name, name]) => ({ obs_source_name, name }));
				});
				const scenesLists = liveScenesLists.map((scenes, socketIdx) => {
					if (scenes.length) return scenes;
					return getLastKnownScenes(socketIdx).filter(({ sceneName }) => !!globalSettings[`sceneAlias__${sceneName}`]);
				});
				// Names confirmed present right now on a socket that's actually connected - as opposed to
				// ingestsLists/scenesLists above, which may include last-known/offline data. The alias
				// editors use this to decide when it's safe to offer deleting a stale, never-aliased row:
				// only once its name is confirmed absent from every currently-connected socket, never just
				// because one particular socket (which might be the one it belongs to) is offline right now
				const connectedIngestSourceNames = sockets.flatMap((socket, socketIdx) => socket.isConnected ? liveIngestsLists[socketIdx].map(i => i.obs_source_name) : []);
				const connectedSceneNames = sockets.flatMap((socket, socketIdx) => socket.isConnected ? liveScenesLists[socketIdx].map(s => s.sceneName) : []);
				$SD.sendToPropertyInspector(context, { event: 'GlobalListsLoaded', ingestsLists, scenesLists, connectedIngestSourceNames, connectedSceneNames }, action);
			}
		});

		// Attach status event listener if defined
		let statusEvent = params?.statusEvent;
		if (statusEvent) {
			if (!Array.isArray(statusEvent)) {
				statusEvent = [statusEvent];
			}
			statusEvent.forEach(event => this._attachEventListener(event as keyof OBSEventTypes));
		}

	}

	// -- Key press methods
	protected onSinglePress = (callback: (evtData: KeyUpData<any>) => void) => this.on(`${this.UUID}.singlePress`, callback);
	protected onLongPress = (callback: (evtData: KeyDownData<any>) => void) => this.on(`${this.UUID}.longPress`, callback);

	// -- Optional methods called on socket connected/disconnected and on context appear/disappear/update
	async onSocketConnected?(socketIdx: number): Promise<void>
	async onSocketDisconnected?(socketIdx: number): Promise<void>
	async onContextAppear?(context: string, contextData: ContextData<T>): Promise<void>
	async onContextDisappear?(context: string): Promise<void>
	async onContextSettingsUpdated?(context: string, contextData: ContextData<T>): Promise<void>

	protected async getForegroundImage?(context: string): Promise<string | undefined>;

	/**
	 * Triggers when PI has imported everything and is ready to be shown to the user
	 */
	protected async onPropertyInspectorReady?({ context, action }: { context: string, action: string }): Promise<void>

	// -- Getters/setters
	protected get contexts() {
		return this._contexts;
	}

	protected setContextSocketState(context: string, socketIdx: number, state: StateEnum) {
		const contextData = this._contexts.get(context);
		if (!contextData) return;
		contextData.states[socketIdx] = state; // Update cache
		this._updateSDState(context, contextData);	// update internal SD state
	}
	// --

	// -- General helpers
	getCommonSettings(settings: PersistentSettings<T>) {
		settings = settings ?? {};
		// An active Open Ingest Profile override takes priority over this button's own Target setting,
		// for IRLTK-only actions specifically - that's the whole point of the override (see irltkIngests.ts)
		const overrideTarget = this._irltkCompat === 'only' ? getIngestContextOverride().target : undefined;
		return {
			targets: overrideTarget !== undefined ? [overrideTarget] : resolveTargetIndices(settings.common?.target || globalSettings.defaultTarget, resolveServers(globalSettings)),
			indivParams: !!settings.common?.indivParams,
		};
	}

	getTargets(settings: PersistentSettings<T>): number[] {
		return this.getCommonSettings(settings).targets;
	}

	getSettingsArray(settings: PersistentSettings<T>): (SocketSettings<T> | null)[] {
		settings = settings ?? {};
		const { targets, indivParams } = this.getCommonSettings(settings);
		const servers = resolveServers(globalSettings);
		const settingsArray = [];
		for (let i = 0; i < sockets.length; i++) {
			if (targets.includes(i + 1) && this._isSocketEligible(i)) {
				if (targets.length > 1 && !indivParams) {
					// Multiple targets sharing one params blob always live in the fixed params_shared slot,
					// regardless of which servers are actually selected/their order - there's no single
					// server identity to key it by. params1 is also checked, for a button saved before
					// multi-select existed (target was '0'/All, non-individual) - that's where its shared
					// blob still lives until this button is resaved
					settingsArray.push(settings.params_shared ?? settings.params1 ?? {});
				}
				else {
					// Keyed by the server's stable id so a saved single-target/individual params blob
					// keeps following its server if `servers` gets reordered, falling back to the old
					// positional params{n} key for buttons saved before servers had ids
					const id = servers[i]?.id;
					settingsArray.push((id ? settings[`params_${id}`] : undefined) ?? settings[`params${i + 1}`] ?? {});
				}
			}
			else {
				settingsArray.push(null);
			}
		}
		return settingsArray;
	}

	/**
	 * One-time per-button migration: rewrites a button's own legacy positional target/params - saved
	 * before per-server ids existed, or before this button's PI was ever reopened since - into their
	 * id-based equivalents, resolved against the server positions as they exist right now. Mirrors the
	 * server-list migration in app.ts, but has to run per-button since it depends on that button's own
	 * settings. Runs on every appear/settings-update, but is a no-op once already migrated, so this only
	 * ever writes once per button - critical to do automatically rather than waiting on the user to
	 * manually reopen/re-edit every button's PI, since the PI's own "keep at least one target checked"
	 * guard makes it impossible to force a resave by simply toggling the only checked target off and on
	 */
	private _migrateLegacySettings(context: string, settings: PersistentSettings<T>): void {
		const rawTarget = settings?.common?.target;
		if (rawTarget === undefined) return; // brand new button - nothing saved yet to migrate
		const servers = resolveServers(globalSettings);
		const alreadyIds = Array.isArray(rawTarget) && rawTarget.every((t) => servers.some((server) => server.id === t));
		const idTargets = resolveTargetIds(rawTarget, servers);
		if (!idTargets.length) return; // unresolvable - leave settings untouched rather than saving an empty target

		// Legacy per-server params blobs (params{n}) get copied to their id-keyed equivalent, for
		// whichever server(s) this button is about to be saved as targeting - capturing the position
		// they're currently sitting at before any further reordering can invalidate that association
		const paramsUpdates: Record<string, unknown> = {};
		idTargets.forEach((id) => {
			const index = servers.findIndex((server) => server.id === id) + 1;
			const idKey = `params_${id}` as const;
			const legacyKey = `params${index}` as const;
			if ((settings as Record<string, unknown>)[idKey] === undefined && (settings as Record<string, unknown>)[legacyKey] !== undefined) {
				paramsUpdates[idKey] = (settings as Record<string, unknown>)[legacyKey];
			}
		});

		if (alreadyIds && Object.keys(paramsUpdates).length === 0) return; // nothing to migrate
		$SD.setSettings(context, { ...settings, common: { ...settings.common, target: idTargets }, ...paramsUpdates });
	}

	/**
	 * Whether a socket is a valid target for this action, per its General Configuration "IRLTK" flag and
	 * this action's irltkCompat restriction (if any). Actions with no restriction accept every socket
	 */
	private _isSocketEligible(socketIdx: number): boolean {
		if (!this._irltkCompat) return true;
		const isIrltk = resolveServers(globalSettings)[socketIdx]?.irltk === 'true';
		return this._irltkCompat === 'only' ? isIrltk : !isIrltk;
	}
	// --

	/**
	 * Show the SD alert (warning triangle) overlay on a context - for dial actions to call from their
	 * press/rotate/tap handlers when one or more of their targeted (non-null settings) sockets is
	 * currently disconnected, so nothing happened there. Those interactions mostly cache locally and
	 * commit via a debounce, so they'd otherwise fail silently instead of surfacing the same feedback a
	 * regular button gets from AbstractBaseRequestAction's _execute on a WS call failure. Respects the
	 * same "feedback: hide" global setting as that path
	 */
	protected _warnIfDisconnected(context: string, settings: (SocketSettings<T> | null)[]): void {
		if (globalSettings.feedback === 'hide') return;
		if (settings.some((socketSettings, socketIdx) => socketSettings && !sockets[socketIdx].isConnected)) {
			$SD.showAlert(context);
		}
	}

	/**
	 * Wrap a flat setFeedback payload (key -> display value, or an object of item property overrides for
	 * keys that need more than just their value updated, e.g. a bar's fill color) with a shared opacity,
	 * dimmed while the given socket is disconnected - so a Stream Deck + dial's touch screen visibly reads
	 * as stale instead of silently continuing to show whatever it last displayed while connected
	 */
	protected _dimFeedback(feedback: Record<string, string | number | Record<string, unknown>>, socketIdx: number): Record<string, Record<string, unknown>> {
		const opacity = sockets[socketIdx]?.isConnected ? 1 : 0.4;
		return Object.fromEntries(Object.entries(feedback).map(([key, value]) => [
			key,
			typeof value === 'object' ? { ...value, opacity } : { value, opacity },
		]));
	}

	/**
	 * Update key title with the corresponding settings param string, depending on configured target
	 */
	private _updateTitle(context: string, settingsParam: string | undefined) {
		if (!settingsParam) return;
		const contextData = this._contexts.get(context);
		if (!contextData || contextData.isInMultiAction) return;	// to-do: also check if a title associated param is defined for this class object

		const titles = contextData.settings
		.filter(socketSettings => socketSettings)
		.map(socketSettings => socketSettings![settingsParam] as string || '?');

		const title = [...new Set(titles)].join('\n········\n');
		SDUtils.setKeyTitle(context, title);
	}
	// --

	// -- States
	/**
	 * Fetch the current states associated with an action, for all OBS instances.
	 * Never rejects
	 * @param settings Action settings
	 * @returns
	 */
	private async _fetchStates(settings: (SocketSettings<T> | null)[]): Promise<StateEnum[]> {
		const statesResults = await Promise.allSettled(settings.map((socketSettings, idx) => {
			return this._fetchSocketState(socketSettings, idx);
		}));
		return statesResults.map(res => res.status === 'fulfilled' ? res.value : StateEnum.Unavailable);
	}

	/**
	 * Utility wrapper around fetchState. Don't override
	 */
	private async _fetchSocketState(socketSettings: SocketSettings<T> | null, socketIdx: number): Promise<StateEnum> {
		if (!socketSettings || !sockets[socketIdx].isConnected) return StateEnum.Unavailable;
		return this.fetchState ? this.fetchState(socketSettings, socketIdx) : StateEnum.None;
	}

	// Update SD state - active (0) only if every targeted state is active
	protected _updateSDState(context: string, contextData: ContextData<unknown>) {
		const { targets, states } = contextData;
		const sdState = states.filter((_, i) => targets.includes(i + 1)).every(state => state === StateEnum.Active) ? 0 : 1;
		$SD.setState(context, sdState);
	}
	// --

	// -- Images update
	/**
	 * Get default action key image, defined in the manifest.json, as SVG string
	 */
	private async _getDefaultKeyImage(): Promise<string> {
		const key = (await import(`../assets/actions/${this._actionId}/key.svg`)).default;
		return key;
	}

	/**
	 * Update the context key image.
	 * The update is not immediate, it's queued in a small buffer to improve sync and avoid unneeded messages to SD
	 * @param context Action context
	 */
	protected async updateKeyImage(context: string): Promise<void> {
		const image = await this._generateKeyImage(context).catch(e => { console.error(`Error updating key image for context ${context}: ${e}`); });
		if (!image) return;
		AbstractBaseWsAction._dirtyImages.set(context, image);
		if (AbstractBaseWsAction._dirtyImages.size === 1) {
			setTimeout(() => {
				for (const [ctx, img] of AbstractBaseWsAction._dirtyImages) {
					$SD.setImage(ctx, img);
					AbstractBaseWsAction._dirtyImages.delete(ctx);
				}
			}, 15);
		}
	}

	/**
	 * Update key images for all action contexts in cache.
	 */
	protected updateImages(): void {
		for (const [context] of this._contexts) {
			this.updateKeyImage(context);
		}
	}

	private _getFgColor(context: string) {
		if (!this._contexts.has(context)) return;
		const { advancedSettings } = this._contexts.get(context)!;
		const noColor = '#fefefe';
		return (advancedSettings?.fgColor !== noColor && advancedSettings?.fgColor) ||
			(globalSettings.fgColor !== noColor && globalSettings.fgColor) ||
			'#efefef';
	}

	private _getBgColor(context: string, stateStr: 'Active' | 'Inactive' | 'Intermediate') {
		if (!this._contexts.has(context)) return;
		const { advancedSettings } = this._contexts.get(context)!;
		const noColor = '#fefefe';
		const lowercaseState = stateStr.toLowerCase() as 'active' | 'inactive' | 'intermediate';
		return (advancedSettings?.[`bgColor${stateStr}`] !== noColor && advancedSettings?.[`bgColor${stateStr}`]) ||
			(globalSettings[`bgColor${stateStr}`] !== noColor && globalSettings[`bgColor${stateStr}`]) ||
			this._statesColors[lowercaseState];
	}

	private async _generateKeyImage(context: string) {
		if (!this._contexts.has(context)) return;
		const { states, targets, advancedSettings } = this._contexts.get(context)!;

		// State rectangles
		let bgLayer = '', fgLayer = '';
		const activeColor = this._getBgColor(context, 'Active');
		const inactiveColor = this._getBgColor(context, 'Inactive');
		const intermediateColor = this._getBgColor(context, 'Intermediate');

		if (states) {
			if (targets.length === 1) {
				const idx = targets[0] - 1;
				const isDimmed = states[idx] === StateEnum.Inactive || states[idx] === StateEnum.Unavailable;
				bgLayer += `<rect x="0" y="0" width="144" height="144" fill="${isDimmed ? inactiveColor : states[idx] === StateEnum.Intermediate ? intermediateColor : activeColor}"/>`;
				if (isDimmed) {
					fgLayer += '<rect x="0" y="0" width="144" height="144" fill="black" fill-opacity="0.5"/>';
				}
			}
			else {
				// Multiple (or zero) targets: one equal-width vertical slice per targeted server, in target
				// order - not one slice per socket slot, so an arbitrary subset renders tightly instead of
				// leaving gaps for servers that aren't selected
				const n = targets.length;
				targets.forEach((pos, sliceIdx) => {
					const idx = pos - 1;
					const x = 144 * sliceIdx / n;
					const width = 144 * (sliceIdx + 1) / n - x;
					const isDimmed = states[idx] === StateEnum.Inactive || states[idx] === StateEnum.Unavailable;
					bgLayer += `<rect x="${x}" y="0" width="${width}" height="144" fill="${isDimmed ? inactiveColor : states[idx] === StateEnum.Intermediate ? intermediateColor : activeColor}"/>`;
					if (isDimmed) {
						fgLayer += `<rect x="${x}" y="0" width="${width}"  height="144" fill="black" fill-opacity="0.5"/>`;
					}
				});
			}
		}

		// Target numbers
		let targetsText = '';
		const fgColor = this._getFgColor(context);
		if (!this._hideTargetIndicators && globalSettings.targetNumbers !== 'hide') {
			const pos = globalSettings.targetNumbers ?? 'top';

			const yPos = pos === 'top' ? 28 : pos === 'middle' ? 144 / 2 + 10 : 144 - 10;
			if (targets.length > 1 && states) {
				const n = targets.length;
				targets.forEach((serverPos, sliceIdx) => {
					const xPos = 144 * (sliceIdx + 0.5) / n;
					targetsText += `<text x="${xPos}" y="${yPos}" text-anchor="middle" font-size="24" font-family="Arial, sans-serif" font-weight="bold" fill="${fgColor}">${serverPos}</text>`;
				});
			}
			else if (targets.length === 1) {
				targetsText += `<text x="${0 + 10}" y="${yPos}" text-anchor="start" font-size="24" font-family="Arial, sans-serif" font-weight="bold" fill="${fgColor}">${targets[0]}</text>`;
			}
		}

		// Foreground/main image
		let fgImg = '';
		if (this.getForegroundImage) {
			fgImg = await this.getForegroundImage(context) ?? '';
		}
		else if (advancedSettings?.customImg && advancedSettings.customImgPos) {
			const { customImg, customImgPos } = advancedSettings;
			const [x, y, width, height] = customImgPos.split(',').map(v => parseInt(v.trim()));
			fgImg = `<image xlink:href="${customImg}" x="${x}" y="${y}" width="${width}" height="${height}"/>`;
		}
		else {
			fgImg = this._defaultKeyImg?.replace(/<\/?svg.*?>/g, '')
			.replace(/fill=".*?"/, `fill="${fgColor}"`)
			.replace(/stroke=".*?"/, `stroke="${fgColor}"`)
				?? '';
		}

		const svgStr = `
		<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">
			${bgLayer}
			${fgImg}
			${targetsText}
			${fgLayer}
		</svg>
		`;
		return `data:image/svg+xml;base64,${btoa(svgStr)}`;
	}
	// --

	// -- Methods related to stateful actions
	private _attachEventListener(statusEvent: keyof OBSEventTypes) {
		if (!this.shouldUpdateState || !this.getStateFromEvent) return;
		sockets.forEach((socket, evtSocketIdx) => {
			socket.on(statusEvent, async (...args) => {
				for (const [context, { settings, states }] of this._contexts) {
					try {
						const [evtData] = args;
						const socketSettings = settings[evtSocketIdx];
						if (socketSettings && await this.shouldUpdateState!(evtData, socketSettings, evtSocketIdx)) {
							const newState = this.getStateFromEvent!(evtData, socketSettings, statusEvent, evtSocketIdx);
							if (newState !== states[evtSocketIdx]) {
								this.setContextSocketState(context, evtSocketIdx, newState);
								this.updateKeyImage(context);
							}
						}
					}
					catch (e) {
						console.error(`Error getting state from event: ${e}`);
					}
				}
			});
		});
	}

	/**
	 * Fetch the current OBS state associated with the action (e.g. if scene is visible).
	 * Rejects on fetching error.
	 * @param socketSettings Action settings for the target OBS
	 * @param socketIdx Index of the OBS instance to fetch settings from
	 * @returns Active/Inactive
	 */
	async fetchState?(socketSettings: SocketSettings<T>, socketIdx: number): Promise<Exclude<StateEnum, StateEnum.Unavailable | StateEnum.None>>;

	/**
	 * Whether a received event should trigger an state update an action
	 * @param evtData Event data
	 * @param socketSettings Action settings for the corresponding socket
	 * @param socketIdx Socket index
	 */
	async shouldUpdateState?(evtData: unknown, socketSettings: SocketSettings<T>, socketIdx: number): Promise<boolean>;

	/**
	 * Get state associated with the action from the event that notifies a state update
	 * @param evtData Event data
	 * @param socketSettings Action settings for the corresponding socket
	 * @param evtName Event name, as defined by OBS
	 * @param socketIdx Socket index
	 * @returns New state
	 */
	getStateFromEvent?(evtData: unknown, socketSettings: SocketSettings<T>, evtName: keyof OBSEventTypes, socketIdx: number): StateEnum;
	// --
}


export { AbstractBaseWsAction as AbstractStatelessAction };

export abstract class AbstractStatefulAction<T extends Record<string, unknown>, U extends keyof OBSEventTypes> extends AbstractBaseWsAction<T> {

	constructor(UUID: string, params: PartiallyRequired<ConstructorParams, 'statusEvent'>) {
		super(UUID, params);
		this._showSuccess = false;	// success already shown via event updates
	}

	abstract override fetchState(socketSettings: SocketSettings<T>, socketIdx: number): Promise<Exclude<StateEnum, StateEnum.Unavailable | StateEnum.None>>;
	abstract override shouldUpdateState(evtData: OBSEventTypes[U], socketSettings: SocketSettings<T>, socketIdx: number): Promise<boolean>;
	abstract override getStateFromEvent(evtData: OBSEventTypes[U], socketSettings: SocketSettings<T>, evtName: U, socketIdx: number): StateEnum;
}