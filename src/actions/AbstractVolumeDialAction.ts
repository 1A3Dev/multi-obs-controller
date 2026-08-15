import { sockets } from '../plugin/sockets';
import { AbstractStatefulAction } from './BaseWsAction';
import { StateEnum } from './StateEnum';
import { ConstructorParams, ContextData, DialRotateData, DialUpData, SocketSettings, TouchTapData } from './types';

const MIN_DB = -100;
const DEFAULT_MAX_DB = 0;
const HARD_MAX_DB = 26;
const METER_FLOOR_DB = 60;
const ROTATE_SETTLE_MS = 150;

const INDICATOR_COLOR = '#EFEFEF';
const INDICATOR_CLIP_COLOR = '#e5473b';

const MONITOR_TYPE_NONE = 'OBS_MONITORING_TYPE_NONE';
const MONITOR_TYPE_MONITOR_ONLY = 'OBS_MONITORING_TYPE_MONITOR_ONLY';
const MONITOR_TYPE_MONITOR_AND_OUTPUT = 'OBS_MONITORING_TYPE_MONITOR_AND_OUTPUT';

export abstract class AbstractVolumeDialAction<T extends Record<string, unknown> & { stepDb: string, maxDb: string }> extends AbstractStatefulAction<T, 'InputMuteStateChanged'> {
	private _volumeCache = new Map<string, (number | undefined)[]>();
	private _muteCache = new Map<string, (boolean | undefined)[]>();
	private _monitorTypeCache = new Map<string, (string | undefined)[]>();
	private _rotateTimers = new Map<string, NodeJS.Timeout>();
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

		sockets.forEach((socket, socketIdx) => {
			socket.on('InputVolumeChanged', (evtData) => {
				for (const [context, { settings, displayIdx }] of this.contexts) {
					if (this.resolveInputName(socketIdx, settings[socketIdx]) !== evtData.inputName) continue;
					if (this._rotateTimers.has(context)) continue;
					const cached = this._volumeCache.get(context);
					if (cached) cached[socketIdx] = evtData.inputVolumeDb;
					if (socketIdx === displayIdx) {
						this._updateDialFeedback(context, this.resolveDisplayName(socketIdx, settings[socketIdx]), evtData.inputVolumeDb, this._getEffectiveMute(context, socketIdx), socketIdx, settings[socketIdx]);
					}
				}
			});
		});

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

		$SD.onDidReceiveGlobalSettings(() => {
			for (const [context, { settings, displayIdx }] of this.contexts) {
				this._updateDialFeedback(context, this.resolveDisplayName(displayIdx, settings[displayIdx]), this._volumeCache.get(context)?.[displayIdx], this._getEffectiveMute(context, displayIdx), displayIdx, settings[displayIdx]);
			}
		});
	}

	protected abstract resolveInputName(socketIdx: number, socketSettings: SocketSettings<T> | null | undefined): string | undefined;

	protected resolveDisplayName(socketIdx: number, socketSettings: SocketSettings<T> | null | undefined): string | undefined {
		return this.resolveInputName(socketIdx, socketSettings);
	}

	protected async notifyTargetsChanged(onlySocketIdx?: number): Promise<void> {
		for (const [context, { settings, displayIdx }] of this.contexts) {
			const socketIndices = onlySocketIdx === undefined ? settings.map((_, i) => i) : [onlySocketIdx];
			for (const socketIdx of socketIndices) {
				const resolvedName = this.resolveInputName(socketIdx, settings[socketIdx]);
				const lastNames = this._lastResolvedNames.get(context);
				if (!lastNames || lastNames[socketIdx] === resolvedName) continue;

				lastNames[socketIdx] = resolvedName;
				if (resolvedName) {
					await this._refreshTarget(context, socketIdx, resolvedName);
				}
				else {
					this._volumeCache.get(context)?.splice(socketIdx, 1, undefined);
					this._muteCache.get(context)?.splice(socketIdx, 1, undefined);
					this._monitorTypeCache.get(context)?.splice(socketIdx, 1, undefined);
					if (socketIdx === displayIdx) this._updateDialFeedback(context, undefined, undefined, undefined, displayIdx, settings[displayIdx]);
				}
			}
		}
	}

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

	override async onSocketConnected(socketIdx: number): Promise<void> {
		for (const [context, { settings }] of this.contexts) {
			const inputName = this.resolveInputName(socketIdx, settings[socketIdx]);
			if (!inputName) continue;
			await this._refreshTarget(context, socketIdx, inputName);
			const lastNames = this._lastResolvedNames.get(context);
			if (lastNames) lastNames[socketIdx] = inputName;
		}
	}

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

	private _resolveMaxDb(socketSettings: SocketSettings<T> | null | undefined): number {
		const maxDb = Number(socketSettings?.maxDb) || DEFAULT_MAX_DB;
		return Math.min(HARD_MAX_DB, Math.max(DEFAULT_MAX_DB, maxDb));
	}

	private _getEffectiveMute(context: string, socketIdx: number): boolean | undefined {
		const muted = this._muteCache.get(context)?.[socketIdx];
		const monitorType = this._monitorTypeCache.get(context)?.[socketIdx];
		if (muted === undefined && monitorType === undefined) return undefined;
		return !!muted || monitorType === MONITOR_TYPE_MONITOR_ONLY;
	}

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
