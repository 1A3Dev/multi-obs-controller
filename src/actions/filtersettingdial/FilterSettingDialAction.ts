import { sockets } from '../../plugin/sockets';
import { AbstractStatelessAction } from '../BaseWsAction';
import { getInputsLists, getScenesLists, getSourceFilterList } from '../lists';
import { ContextData, DialRotateData, DialUpData, SendToPluginData, SocketSettings, TouchTapData } from '../types';

const ROTATE_SETTLE_MS = 150; // wait for rotation to settle before committing, so rapid ticks don't spam/race WS requests
const DEFAULT_STEP = 1;

type ActionSettings = { sourceName: string, filterName: string, settingName: string, step: string, min?: string, max?: string };

function clampValue(value: number, min: string | undefined, max: string | undefined): number {
	if (min !== undefined && min !== '' && !Number.isNaN(Number(min))) value = Math.max(Number(min), value);
	if (max !== undefined && max !== '' && !Number.isNaN(Number(max))) value = Math.min(Number(max), value);
	return value;
}

/**
 * OBS only reports settings the user has actually touched in `GetSourceFilter` - a freshly-added filter
 * whose sliders were never moved can report an empty/partial `filterSettings`, even though every property
 * has a real value (its default). Merging in `GetSourceFilterDefaultSettings` (keyed off the filter kind)
 * gives the complete, currently-effective settings object regardless of whether anything's been touched.
 */
async function getEffectiveFilterSettings(socketIdx: number, sourceName: string, filterName: string): Promise<Record<string, unknown>> {
	const { filterKind, filterSettings } = await sockets[socketIdx].call('GetSourceFilter', { sourceName, filterName });
	const { defaultFilterSettings } = await sockets[socketIdx].call('GetSourceFilterDefaultSettings', { filterKind });
	return { ...defaultFilterSettings, ...filterSettings };
}

/**
 * Stream Deck + dial that adjusts a single numeric setting on a source filter (e.g. a Chroma Key's
 * similarity/smoothness, or a Color Correction filter's contrast/gamma) - filter settings are entirely
 * filter-kind-specific and untyped in the OBS websocket protocol, so the setting is targeted by name
 * rather than from a fixed list. Rotating adjusts the value with optimistic local caching and a debounced
 * commit; push or tap discards any uncommitted rotation and resyncs the displayed value from OBS (there's
 * no universal "default" to reset a filter setting to, unlike volume's 0 dB or a transform's neutral pose).
 *
 * There's no OBS event for filter settings changes, so - unlike volume/mute - this can't stay live-synced
 * with edits made elsewhere (e.g. directly in OBS); the cached value is only refreshed on appear/settings
 * update/reconnect/scene collection change, or by tapping/pushing the dial.
 */
export class FilterSettingDialAction extends AbstractStatelessAction<ActionSettings> {
	// Per-context, per-socket: locally-tracked setting value, optimistically updated on rotate
	private _valueCache = new Map<string, (number | undefined)[]>();
	private _rotateTimers = new Map<string, NodeJS.Timeout>();

	constructor() {
		super('dev.theca11.multiobs.filtersettingdial', { titleParam: 'filterName', hideTargetIndicators: true });

		this.onDialRotate((evtData: DialRotateData<unknown>) => {
			const { context, payload } = evtData;
			if (!this.contexts.has(context)) return;
			const { settings, displayIdx } = this.contexts.get(context)!;
			this._warnIfDisconnected(context, settings);
			const cached = this._valueCache.get(context);
			if (!cached) return;

			settings.forEach((socketSettings, socketIdx) => {
				if (!socketSettings?.settingName || cached[socketIdx] === undefined) return;
				const step = Number(socketSettings.step) || DEFAULT_STEP;
				cached[socketIdx] = clampValue(cached[socketIdx]! + payload.ticks * step, socketSettings.min, socketSettings.max);
			});
			this._updateDialFeedback(context, displayIdx);

			clearTimeout(this._rotateTimers.get(context));
			this._rotateTimers.set(context, setTimeout(() => this._commitValue(context), ROTATE_SETTLE_MS));
		});

		// Push or tap - both discard any uncommitted rotation and resync from OBS's actual current value
		this.onDialUp((evtData: DialUpData<unknown>) => this._resync(evtData.context));
		this.onTouchTap((evtData: TouchTapData<unknown>) => this._resync(evtData.context));

		sockets.forEach((socket, socketIdx) => {
			socket.on('CurrentSceneCollectionChanged', () => this._refreshSocket(socketIdx));
		});

		this.onSendToPlugin(async ({ payload, context, action }: SendToPluginData<{ event: string, socketIdx: number, sourceName: string, filterName: string }>) => {
			if (payload.event === 'GetSourceFilterList') {
				const filterItems = await getSourceFilterList(payload.socketIdx, payload.sourceName);
				const piPayload = {
					event: 'FilterListLoaded',
					idx: payload.socketIdx,
					filterList: filterItems.map(o => o.filterName),
				};
				$SD.sendToPropertyInspector(context, piPayload, action);
			}
			else if (payload.event === 'GetFilterSettingKeys') {
				let settingKeys: string[] = [];
				if (sockets[payload.socketIdx].isConnected && payload.sourceName && payload.filterName) {
					try {
						const effectiveSettings = await getEffectiveFilterSettings(payload.socketIdx, payload.sourceName, payload.filterName);
						settingKeys = Object.keys(effectiveSettings).filter(k => typeof effectiveSettings[k] === 'number');
					}
					catch { /* Source/filter doesn't exist (yet) */ }
				}
				const piPayload = { event: 'SettingListLoaded', idx: payload.socketIdx, settingKeys };
				$SD.sendToPropertyInspector(context, piPayload, action);
			}
		});
	}

	override async onContextAppear(context: string, { settings, displayIdx }: ContextData<ActionSettings>): Promise<void> {
		$SD.setFeedbackLayout(context, 'actions/dialLayout/layout.json');
		this._valueCache.set(context, new Array(sockets.length).fill(undefined));
		await Promise.all(settings.map((socketSettings, socketIdx) => this._refreshTarget(context, socketIdx, socketSettings)));
		this._updateDialFeedback(context, displayIdx);
	}

	override async onContextDisappear(context: string): Promise<void> {
		clearTimeout(this._rotateTimers.get(context));
		this._rotateTimers.delete(context);
		this._valueCache.delete(context);
	}

	override async onContextSettingsUpdated(context: string, { settings, displayIdx }: ContextData<ActionSettings>): Promise<void> {
		clearTimeout(this._rotateTimers.get(context));
		this._rotateTimers.delete(context);
		await Promise.all(settings.map((socketSettings, socketIdx) => this._refreshTarget(context, socketIdx, socketSettings)));
		this._updateDialFeedback(context, displayIdx);
	}

	override async onSocketConnected(socketIdx: number): Promise<void> {
		await this._refreshSocket(socketIdx);
	}

	// No data to refresh - just redraw so the touch display dims immediately rather than waiting for
	// some other refresh to happen to redraw it
	override async onSocketDisconnected(socketIdx: number): Promise<void> {
		for (const [context, { displayIdx }] of this.contexts) {
			if (socketIdx === displayIdx) this._updateDialFeedback(context, displayIdx);
		}
	}

	override async onPropertyInspectorReady({ context, action }: { context: string; action: string; }): Promise<void> {
		const scenesLists = await getScenesLists();
		const inputsLists = await getInputsLists();
		const payload = { event: 'SourceListLoaded', scenesLists, inputsLists };
		$SD.sendToPropertyInspector(context, payload, action);
	}

	private async _refreshSocket(socketIdx: number): Promise<void> {
		for (const [context, { settings, displayIdx }] of this.contexts) {
			if (!settings[socketIdx]) continue;
			await this._refreshTarget(context, socketIdx, settings[socketIdx]);
			if (socketIdx === displayIdx) this._updateDialFeedback(context, displayIdx);
		}
	}

	/**
	 * Fetch the setting's current live value from OBS and update the cache, leaving it undefined (disabled)
	 * on any resolution failure
	 */
	private async _refreshTarget(context: string, socketIdx: number, socketSettings: SocketSettings<ActionSettings> | null): Promise<void> {
		const values = this._valueCache.get(context);
		if (!values) return;
		values[socketIdx] = undefined;

		const { sourceName, filterName, settingName } = socketSettings ?? {};
		if (!sourceName || !filterName || !settingName || !sockets[socketIdx].isConnected) return;
		try {
			const effectiveSettings = await getEffectiveFilterSettings(socketIdx, sourceName, filterName);
			const value = effectiveSettings[settingName];
			if (typeof value === 'number') values[socketIdx] = value;
		}
		catch {
			// Source/filter doesn't exist (yet) - leave undefined, already reset above
		}
	}

	private async _commitValue(context: string): Promise<void> {
		this._rotateTimers.delete(context);
		if (!this.contexts.has(context)) return;
		const { settings } = this.contexts.get(context)!;
		const values = this._valueCache.get(context);
		if (!values) return;

		await Promise.allSettled(settings.map((socketSettings, socketIdx) => {
			const value = values[socketIdx];
			if (!socketSettings?.sourceName || !socketSettings?.filterName || !socketSettings?.settingName || value === undefined || !sockets[socketIdx].isConnected) return Promise.resolve();
			return sockets[socketIdx].call('SetSourceFilterSettings', {
				sourceName: socketSettings.sourceName,
				filterName: socketSettings.filterName,
				filterSettings: { [socketSettings.settingName]: value },
			});
		}));
	}

	private async _resync(context: string): Promise<void> {
		if (!this.contexts.has(context)) return;
		const { settings, displayIdx } = this.contexts.get(context)!;
		this._warnIfDisconnected(context, settings);
		clearTimeout(this._rotateTimers.get(context));
		this._rotateTimers.delete(context);

		await Promise.all(settings.map((socketSettings, socketIdx) => this._refreshTarget(context, socketIdx, socketSettings)));
		this._updateDialFeedback(context, displayIdx);
	}

	/**
	 * Render the current setting value on the dial's touch display: the filter and setting name as the
	 * title, the value, and an indicator bar - only meaningful (otherwise left empty) when both min and
	 * max are configured, since filter setting ranges vary wildly by filter kind and aren't discoverable
	 */
	private _updateDialFeedback(context: string, displayIdx: number): void {
		if (!this.contexts.has(context)) return;
		const { settings } = this.contexts.get(context)!;
		const socketSettings = settings[displayIdx];
		const value = this._valueCache.get(context)?.[displayIdx];

		if (!socketSettings?.settingName || value === undefined) {
			$SD.setFeedback(context, this._dimFeedback({ status: '', title: ' ', value: '', indicator: 0 }, displayIdx));
			return;
		}
		const { filterName, settingName, min, max } = socketSettings;
		const minNum = min !== undefined && min !== '' ? Number(min) : undefined;
		const maxNum = max !== undefined && max !== '' ? Number(max) : undefined;
		const percent = minNum !== undefined && maxNum !== undefined && maxNum > minNum
			? Math.round(Math.min(100, Math.max(0, ((value - minNum) / (maxNum - minNum)) * 100)))
			: 0;
		$SD.setFeedback(context, this._dimFeedback({
			status: '',
			title: `${filterName} — ${settingName}`,
			value: Number.isInteger(value) ? String(value) : value.toFixed(2),
			indicator: percent,
		}, displayIdx));
	}
}
