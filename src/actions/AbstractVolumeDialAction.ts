import { sockets } from '../plugin/sockets';
import { AbstractStatefulAction } from './BaseWsAction';
import { StateEnum } from './StateEnum';
import { ConstructorParams, ContextData, DialRotateData, DialUpData, SocketSettings, TouchTapData } from './types';

const MIN_DB = -100;
const DEFAULT_MAX_DB = 0; // fallback max dB when a context has no maxDb override configured
const HARD_MAX_DB = 26; // OBS's own ceiling on input volume - a maxDb setting can't push past this
const METER_FLOOR_DB = 60; // dB below 0 mapped to the bottom of the dial's 0-100 indicator bar
const ROTATE_SETTLE_MS = 150; // wait for rotation to settle before committing, so rapid ticks don't spam/race WS requests

const INDICATOR_COLOR = '#EFEFEF'; // normal bar fill, matching the dial's title/value text color
const INDICATOR_CLIP_COLOR = '#e5473b'; // bar fill once boosted above 0 dB, matching the MUTED status color

// OBS's own mute button, for an input with monitoring enabled, mutes the output by flipping the monitor
// type between these two instead of (or in addition to) `inputMuted` - see _getEffectiveMute
const MONITOR_TYPE_NONE = 'OBS_MONITORING_TYPE_NONE';
const MONITOR_TYPE_MONITOR_ONLY = 'OBS_MONITORING_TYPE_MONITOR_ONLY';
const MONITOR_TYPE_MONITOR_AND_OUTPUT = 'OBS_MONITORING_TYPE_MONITOR_AND_OUTPUT';

/**
 * Shared mechanics for a Stream Deck + dial that controls an OBS input's volume: dB rotation with optimistic
 * local caching, tap-to-reset, push-to-mute (mirroring OBS's monitor-type-aware mute button), and keeping the
 * dial feedback in sync with volume/mute/monitor-type changes made elsewhere.
 *
 * Subclasses only need to say which OBS input name a given socket's settings currently target - the target
 * doesn't have to be a fixed setting, see `notifyTargetsChanged` for subclasses whose target can shift around
 * (e.g. resolved from live external data) without a settings change of their own.
 */
export abstract class AbstractVolumeDialAction<T extends Record<string, unknown> & { stepDb: string, maxDb: string }> extends AbstractStatefulAction<T, 'InputMuteStateChanged'> {
	// Locally-tracked dB value per context, one entry per socket. Ticks update this optimistically;
	// the actual SetInputVolume WS call is debounced off of it so requests can't land out of order.
	private _volumeCache = new Map<string, (number | undefined)[]>();
	// Locally-tracked mute state per context, one entry per socket, used to render the mute indicator on the dial
	private _muteCache = new Map<string, (boolean | undefined)[]>();
	// Locally-tracked audio monitor type per context, one entry per socket - see _getEffectiveMute
	private _monitorTypeCache = new Map<string, (string | undefined)[]>();
	private _rotateTimers = new Map<string, NodeJS.Timeout>();
	// Last resolved OBS source name per context/socket - lets notifyTargetsChanged() detect when a subclass's
	// resolved target actually switched, so caches only get refetched when something meaningful changed
	private _lastResolvedNames = new Map<string, (string | undefined)[]>();

	constructor(UUID: string, params?: Omit<Partial<ConstructorParams>, 'statusEvent'>) {
		super(UUID, { hideTargetIndicators: true, ...params, statusEvent: 'InputMuteStateChanged' });

		this.onDialRotate((evtData: DialRotateData<unknown>) => {
			const { context, payload } = evtData;
			if (!this.contexts.has(context) || !this._volumeCache.has(context)) return;
			const { settings, displayIdx } = this.contexts.get(context)!;
			const cached = this._volumeCache.get(context)!;
			this._warnIfDisconnected(context, settings);

			settings.forEach((socketSettings, socketIdx) => {
				if (!this.resolveInputName(socketIdx, socketSettings) || cached[socketIdx] === undefined) return;
				const maxDb = this._resolveMaxDb(socketSettings);
				cached[socketIdx] = Math.min(maxDb, Math.max(MIN_DB, cached[socketIdx]! + payload.ticks * (Number(socketSettings?.stepDb) || 1)));
			});
			this._updateDialFeedback(context, this.resolveDisplayName(displayIdx, settings[displayIdx]), cached[displayIdx], this._getEffectiveMute(context, displayIdx), displayIdx, settings[displayIdx]);

			clearTimeout(this._rotateTimers.get(context));
			this._rotateTimers.set(context, setTimeout(() => this._commitVolume(context), ROTATE_SETTLE_MS));
		});

		this.onDialUp(async (evtData: DialUpData<unknown>) => {
			const { context } = evtData;
			if (!this.contexts.has(context)) return;
			const { settings } = this.contexts.get(context)!;
			this._warnIfDisconnected(context, settings);
			const muteCache = this._muteCache.get(context);
			const monitorTypeCache = this._monitorTypeCache.get(context);
			await Promise.allSettled(settings.map((socketSettings, socketIdx) => {
				if (!sockets[socketIdx].isConnected) return Promise.resolve();
				const inputName = this.resolveInputName(socketIdx, socketSettings);
				if (!inputName) return Promise.resolve();
				const monitorType = monitorTypeCache?.[socketIdx];
				// Mirror OBS's own mute button: for inputs with monitoring enabled, it mutes the output by
				// switching monitor type between Monitor Only (silent output) and Monitor & Output, not via inputMuted
				if (monitorType && monitorType !== MONITOR_TYPE_NONE) {
					const newMonitorType = monitorType === MONITOR_TYPE_MONITOR_ONLY ? MONITOR_TYPE_MONITOR_AND_OUTPUT : MONITOR_TYPE_MONITOR_ONLY;
					return sockets[socketIdx].call('SetInputAudioMonitorType', { inputName, monitorType: newMonitorType });
				}
				return sockets[socketIdx].call('SetInputMute', { inputName, inputMuted: !muteCache?.[socketIdx] });
			}));
		});

		this.onTouchTap(async (evtData: TouchTapData<unknown>) => {
			const { context } = evtData;
			if (!this.contexts.has(context)) return;
			const { settings, displayIdx } = this.contexts.get(context)!;
			this._warnIfDisconnected(context, settings);

			// A tap is a decisive absolute action - cancel any pending rotation commit so it doesn't clobber it
			clearTimeout(this._rotateTimers.get(context));
			this._rotateTimers.delete(context);

			const cached = this._volumeCache.get(context);
			await Promise.allSettled(settings.map((socketSettings, socketIdx) => {
				if (!sockets[socketIdx].isConnected) return Promise.resolve();
				const inputName = this.resolveInputName(socketIdx, socketSettings);
				if (!inputName) return Promise.resolve();
				if (cached) cached[socketIdx] = 0;
				return sockets[socketIdx].call('SetInputVolume', { inputName, inputVolumeDb: 0 });
			}));
			const displayName = this.resolveDisplayName(displayIdx, settings[displayIdx]);
			this._updateDialFeedback(context, displayName, displayName ? 0 : undefined, this._getEffectiveMute(context, displayIdx), displayIdx, settings[displayIdx]);
		});

		// Keep the dial display in sync with volume changes made elsewhere (e.g. directly in OBS)
		sockets.forEach((socket, socketIdx) => {
			socket.on('InputVolumeChanged', (evtData) => {
				for (const [context, { settings, displayIdx }] of this.contexts) {
					if (this.resolveInputName(socketIdx, settings[socketIdx]) !== evtData.inputName) continue;
					// A rotation is still in flight (unsent local ticks pending) - it supersedes this echo,
					// so applying it here would clobber the newer value both on screen and in the eventual commit
					if (this._rotateTimers.has(context)) continue;
					const cached = this._volumeCache.get(context);
					if (cached) cached[socketIdx] = evtData.inputVolumeDb;
					if (socketIdx === displayIdx) {
						this._updateDialFeedback(context, this.resolveDisplayName(socketIdx, settings[socketIdx]), evtData.inputVolumeDb, this._getEffectiveMute(context, socketIdx), socketIdx, settings[socketIdx]);
					}
				}
			});
		});

		// Keep the dial's mute indicator in sync with mute changes, whatever the source (this dial, another action, or directly in OBS)
		sockets.forEach((socket, socketIdx) => {
			socket.on('InputMuteStateChanged', (evtData) => {
				for (const [context, { settings, displayIdx }] of this.contexts) {
					if (this.resolveInputName(socketIdx, settings[socketIdx]) !== evtData.inputName) continue;
					const cached = this._muteCache.get(context);
					if (cached) cached[socketIdx] = evtData.inputMuted;
					if (socketIdx === displayIdx) {
						this._updateDialFeedback(context, this.resolveDisplayName(socketIdx, settings[socketIdx]), this._volumeCache.get(context)?.[socketIdx], this._getEffectiveMute(context, socketIdx), socketIdx, settings[socketIdx]);
					}
				}
			});
		});

		// Keep the dial's mute indicator in sync with monitor type changes too - see _getEffectiveMute
		sockets.forEach((socket, socketIdx) => {
			socket.on('InputAudioMonitorTypeChanged', (evtData) => {
				for (const [context, { settings, displayIdx }] of this.contexts) {
					if (this.resolveInputName(socketIdx, settings[socketIdx]) !== evtData.inputName) continue;
					const cached = this._monitorTypeCache.get(context);
					if (cached) cached[socketIdx] = evtData.monitorType;
					if (socketIdx === displayIdx) {
						this._updateDialFeedback(context, this.resolveDisplayName(socketIdx, settings[socketIdx]), this._volumeCache.get(context)?.[socketIdx], this._getEffectiveMute(context, socketIdx), socketIdx, settings[socketIdx]);
					}
				}
			});
		});

		// A display name alias may have changed in the general configuration - refresh titles to match
		$SD.onDidReceiveGlobalSettings(() => {
			for (const [context, { settings, displayIdx }] of this.contexts) {
				this._updateDialFeedback(context, this.resolveDisplayName(displayIdx, settings[displayIdx]), this._volumeCache.get(context)?.[displayIdx], this._getEffectiveMute(context, displayIdx), displayIdx, settings[displayIdx]);
			}
		});
	}

	/**
	 * Resolve a socket's settings to the OBS input name it currently targets. For most actions this is just a
	 * fixed settings field; subclasses whose target can shift on its own (not from a settings change) should
	 * call `notifyTargetsChanged()` whenever the data that resolution depends on updates.
	 */
	protected abstract resolveInputName(socketIdx: number, socketSettings: SocketSettings<T> | null | undefined): string | undefined;

	/**
	 * Resolve a socket's settings to the human-readable name shown on the dial's touch display. Defaults to
	 * the same value as resolveInputName; subclasses whose target has a friendlier display name than its OBS
	 * source name (e.g. an IRLToolkit ingest's configured name vs. its OBS source name) should override this.
	 */
	protected resolveDisplayName(socketIdx: number, socketSettings: SocketSettings<T> | null | undefined): string | undefined {
		return this.resolveInputName(socketIdx, socketSettings);
	}

	/**
	 * Re-check resolveInputName() for every context on the given socket (or all sockets), refreshing the
	 * volume/mute/monitor-type cache for any whose resolved target actually changed since last checked.
	 * For subclasses whose target is a fixed settings field, this never needs to be called.
	 */
	protected async notifyTargetsChanged(onlySocketIdx?: number): Promise<void> {
		for (const [context, { settings, displayIdx }] of this.contexts) {
			const socketIndices = onlySocketIdx === undefined ? settings.map((_, i) => i) : [onlySocketIdx];
			for (const socketIdx of socketIndices) {
				const resolvedName = this.resolveInputName(socketIdx, settings[socketIdx]);
				const lastNames = this._lastResolvedNames.get(context);
				if (!lastNames || lastNames[socketIdx] === resolvedName) continue; // target hasn't changed

				lastNames[socketIdx] = resolvedName;
				if (resolvedName) {
					await this._refreshTarget(context, socketIdx, resolvedName);
				}
				else {
					this._volumeCache.get(context)?.splice(socketIdx, 1, undefined);
					this._muteCache.get(context)?.splice(socketIdx, 1, undefined);
					this._monitorTypeCache.get(context)?.splice(socketIdx, 1, undefined);
					// The target disappeared (e.g. a dynamic-position ingest that's no longer live) - show the dial as disabled
					if (socketIdx === displayIdx) this._updateDialFeedback(context, undefined, undefined, undefined, displayIdx, settings[displayIdx]);
				}
			}
		}
	}

	/**
	 * Re-fetch volume/mute/monitor-type for a resolved target and update the context's caches (and dial feedback,
	 * if it's the currently displayed socket). Used on context appear, socket reconnect, and target switches
	 */
	private async _refreshTarget(context: string, socketIdx: number, inputName: string): Promise<void> {
		if (!sockets[socketIdx].isConnected) return;
		const [volumeRes, muteRes, monitorRes] = await Promise.allSettled([
			sockets[socketIdx].call('GetInputVolume', { inputName }),
			sockets[socketIdx].call('GetInputMute', { inputName }),
			sockets[socketIdx].call('GetInputAudioMonitorType', { inputName }),
		]);
		const volumeCache = this._volumeCache.get(context);
		if (volumeCache) volumeCache[socketIdx] = volumeRes.status === 'fulfilled' ? volumeRes.value.inputVolumeDb : undefined;
		const muteCache = this._muteCache.get(context);
		if (muteCache) muteCache[socketIdx] = muteRes.status === 'fulfilled' ? muteRes.value.inputMuted : undefined;
		const monitorTypeCache = this._monitorTypeCache.get(context);
		if (monitorTypeCache) monitorTypeCache[socketIdx] = monitorRes.status === 'fulfilled' ? monitorRes.value.monitorType : undefined;

		const contextData = this.contexts.get(context);
		if (!contextData) return;
		const { displayIdx } = contextData;
		if (socketIdx === displayIdx) {
			const name = this.resolveDisplayName(socketIdx, contextData.settings[socketIdx]);
			this._updateDialFeedback(context, name, this._volumeCache.get(context)?.[socketIdx], this._getEffectiveMute(context, socketIdx), socketIdx, contextData.settings[socketIdx]);
		}
	}

	/**
	 * Commit the locally-tracked (optimistic) volume to OBS, once rotation has settled
	 */
	private async _commitVolume(context: string) {
		this._rotateTimers.delete(context);
		if (!this.contexts.has(context) || !this._volumeCache.has(context)) return;
		const { settings } = this.contexts.get(context)!;
		const cached = this._volumeCache.get(context)!;
		await Promise.allSettled(settings.map((socketSettings, socketIdx) => {
			if (cached[socketIdx] === undefined || !sockets[socketIdx].isConnected) return Promise.resolve();
			const inputName = this.resolveInputName(socketIdx, socketSettings);
			if (!inputName) return Promise.resolve();
			return sockets[socketIdx].call('SetInputVolume', { inputName, inputVolumeDb: cached[socketIdx]! });
		}));
	}

	override async onContextAppear(context: string, { settings, displayIdx }: ContextData<T>): Promise<void> {
		$SD.setFeedbackLayout(context, 'actions/dialLayout/layout.json');

		const resolvedNames = settings.map((socketSettings, socketIdx) => this.resolveInputName(socketIdx, socketSettings));
		this._lastResolvedNames.set(context, [...resolvedNames]);
		this._volumeCache.set(context, new Array(sockets.length).fill(undefined));
		this._muteCache.set(context, new Array(sockets.length).fill(undefined));
		this._monitorTypeCache.set(context, new Array(sockets.length).fill(undefined));

		await Promise.all(resolvedNames.map((inputName, socketIdx) => inputName ? this._refreshTarget(context, socketIdx, inputName) : Promise.resolve()));

		this._updateDialFeedback(context, this.resolveDisplayName(displayIdx, settings[displayIdx]), this._volumeCache.get(context)?.[displayIdx], this._getEffectiveMute(context, displayIdx), displayIdx, settings[displayIdx]);
	}

	override async onContextDisappear(context: string): Promise<void> {
		clearTimeout(this._rotateTimers.get(context));
		this._rotateTimers.delete(context);
		this._volumeCache.delete(context);
		this._muteCache.delete(context);
		this._monitorTypeCache.delete(context);
		this._lastResolvedNames.delete(context);
	}

	/**
	 * Refresh the volume/mute/monitor-type cache for this socket on every context, in case the socket wasn't
	 * connected yet when the dial appeared (so the initial fetch came back empty and nothing would otherwise
	 * correct it until a matching OBS event happened to fire)
	 */
	override async onSocketConnected(socketIdx: number): Promise<void> {
		for (const [context, { settings }] of this.contexts) {
			const inputName = this.resolveInputName(socketIdx, settings[socketIdx]);
			if (!inputName) continue;
			await this._refreshTarget(context, socketIdx, inputName);
			const lastNames = this._lastResolvedNames.get(context);
			if (lastNames) lastNames[socketIdx] = inputName;
		}
	}

	/**
	 * Dim the touch display of every context currently showing this socket, so a disconnect is visible
	 * immediately rather than only once some other refresh happens to redraw it
	 */
	override async onSocketDisconnected(socketIdx: number): Promise<void> {
		for (const [context, { settings, displayIdx }] of this.contexts) {
			if (displayIdx !== socketIdx) continue;
			this._updateDialFeedback(context, this.resolveDisplayName(socketIdx, settings[socketIdx]), this._volumeCache.get(context)?.[socketIdx], this._getEffectiveMute(context, socketIdx), socketIdx, settings[socketIdx]);
		}
	}

	override async fetchState(socketSettings: NonNullable<SocketSettings<T>>, socketIdx: number): Promise<StateEnum.Active | StateEnum.Intermediate | StateEnum.Inactive> {
		const inputName = this.resolveInputName(socketIdx, socketSettings);
		if (!inputName) return StateEnum.Inactive;
		const { inputMuted } = await sockets[socketIdx].call('GetInputMute', { inputName });
		return !inputMuted ? StateEnum.Active : StateEnum.Inactive;
	}

	override async shouldUpdateState(evtData: { inputName: string; inputMuted: boolean; }, socketSettings: SocketSettings<T>, socketIdx: number): Promise<boolean> {
		return this.resolveInputName(socketIdx, socketSettings) === evtData.inputName;
	}

	override getStateFromEvent(evtData: { inputName: string; inputMuted: boolean; }): StateEnum {
		return !evtData.inputMuted ? StateEnum.Active : StateEnum.Inactive;
	}

	/**
	 * Resolve a context's configured max dB, falling back to the default and clamped to OBS's own hard ceiling
	 * so a bogus/tampered setting (the PI's number input only enforces its max/min client-side) can't push past it
	 */
	private _resolveMaxDb(socketSettings: SocketSettings<T> | null | undefined): number {
		const maxDb = Number(socketSettings?.maxDb) || DEFAULT_MAX_DB;
		return Math.min(HARD_MAX_DB, Math.max(DEFAULT_MAX_DB, maxDb));
	}

	/**
	 * Whether an input is effectively muted from the output's perspective: either `inputMuted` is set,
	 * or its monitor type is Monitor Only, which OBS's own mute button uses to silence monitored inputs
	 */
	private _getEffectiveMute(context: string, socketIdx: number): boolean | undefined {
		const muted = this._muteCache.get(context)?.[socketIdx];
		const monitorType = this._monitorTypeCache.get(context)?.[socketIdx];
		if (muted === undefined && monitorType === undefined) return undefined;
		return !!muted || monitorType === MONITOR_TYPE_MONITOR_ONLY;
	}

	/**
	 * Render the current volume on the dial's touch display: the target's name as the title, dB text plus a
	 * 0-100 indicator bar as the value, and a red "MUTED" label in the status slot when muted. With no resolved
	 * name (no target, e.g. a dynamic-position ingest slot with no ingest live in it), shows "N/A" and 0 dB instead.
	 * The bar's top always represents this context's configured max (0 dB by default), so it keeps using the
	 * full width even when that max has been raised; it also turns red past 0 dB as a boosted-gain warning.
	 */
	private _updateDialFeedback(context: string, name: string | undefined, db: number | undefined, muted: boolean | undefined, socketIdx: number, socketSettings: SocketSettings<T> | null | undefined) {
		if (!name) {
			$SD.setFeedback(context, this._dimFeedback({ status: '', title: 'N/A', value: '0.0 dB', indicator: { value: 0, bar_fill_c: INDICATOR_COLOR } }, socketIdx));
			return;
		}
		if (db === undefined || Number.isNaN(db)) return;
		const meterRange = METER_FLOOR_DB + this._resolveMaxDb(socketSettings);
		const percent = Math.round(Math.min(100, Math.max(0, ((db + METER_FLOOR_DB) / meterRange) * 100)));
		const dbText = db.toFixed(1) === '-0.0' ? '0.0' : db.toFixed(1);
		$SD.setFeedback(context, this._dimFeedback({
			status: muted ? 'MUTED' : '',
			title: name,
			value: `${dbText} dB`,
			indicator: { value: muted ? 0 : percent, bar_fill_c: !muted && db > 0 ? INDICATOR_CLIP_COLOR : INDICATOR_COLOR },
		}, socketIdx));
	}
}
