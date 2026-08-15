import { sockets } from '../../plugin/sockets';
import { AbstractStatelessAction } from '../BaseWsAction';
import { getGroupSceneItemsList, getGroupsLists, getSceneItemsList, getScenesLists } from '../lists';
import { ContextData, DialRotateData, DialUpData, SendToPluginData, SocketSettings, TouchTapData } from '../types';

const ROTATE_SETTLE_MS = 150; // wait for rotation to settle before committing, so rapid ticks don't spam/race WS requests

type TransformProperty = 'positionX' | 'positionY' | 'rotation' | 'scaleX' | 'scaleY' | 'cropLeft' | 'cropTop' | 'cropRight' | 'cropBottom';
type ActionSettings = { sceneName: string, sourceName: string, property: TransformProperty, step: string };

type PropertyConfig = {
	label: string,
	defaultStep: number,
	resetValue: number,
	// Purely cosmetic window used to map the value onto the dial's 0-100 indicator bar - transform
	// values themselves are otherwise unbounded (position/rotation can legitimately go negative or past 360)
	displayMin: number,
	displayMax: number,
	wrap?: boolean,
	format: (value: number) => string,
};

const PROPERTY_CONFIG: Record<TransformProperty, PropertyConfig> = {
	positionX: { label: 'Position X', defaultStep: 5, resetValue: 0, displayMin: -1000, displayMax: 1000, format: v => `${Math.round(v)}px` },
	positionY: { label: 'Position Y', defaultStep: 5, resetValue: 0, displayMin: -1000, displayMax: 1000, format: v => `${Math.round(v)}px` },
	rotation: { label: 'Rotation', defaultStep: 5, resetValue: 0, displayMin: 0, displayMax: 360, wrap: true, format: v => `${Math.round(v)}°` },
	scaleX: { label: 'Scale X', defaultStep: 0.05, resetValue: 1, displayMin: 0, displayMax: 2, format: v => `${Math.round(v * 100)}%` },
	scaleY: { label: 'Scale Y', defaultStep: 0.05, resetValue: 1, displayMin: 0, displayMax: 2, format: v => `${Math.round(v * 100)}%` },
	cropLeft: { label: 'Crop Left', defaultStep: 5, resetValue: 0, displayMin: 0, displayMax: 500, format: v => `${Math.round(v)}px` },
	cropTop: { label: 'Crop Top', defaultStep: 5, resetValue: 0, displayMin: 0, displayMax: 500, format: v => `${Math.round(v)}px` },
	cropRight: { label: 'Crop Right', defaultStep: 5, resetValue: 0, displayMin: 0, displayMax: 500, format: v => `${Math.round(v)}px` },
	cropBottom: { label: 'Crop Bottom', defaultStep: 5, resetValue: 0, displayMin: 0, displayMax: 500, format: v => `${Math.round(v)}px` },
};

/**
 * Scale/crop can't go negative - position and rotation are left unrestricted (off-canvas framing and
 * multi-turn rotation are both legitimate)
 */
function clampValue(property: TransformProperty, value: number): number {
	return property.startsWith('scale') || property.startsWith('crop') ? Math.max(0, value) : value;
}

/**
 * Stream Deck + dial that adjusts one transform property (position/scale/rotation/crop) of a scene item,
 * for quick reframing (e.g. punching in on a camera) without leaving the stream to open OBS. Rotating
 * adjusts the value with optimistic local caching and a debounced commit; push or tap resets it to a
 * neutral default (0 for position/rotation/crop, 100% for scale).
 *
 * Unlike the volume/scene dials, there's no OBS event to keep this synced with transform changes made
 * elsewhere - SceneItemTransformChanged is a high-volume event not covered by the default subscription -
 * so the cached value is only ever refreshed on appear/settings update/reconnect/scene collection change.
 */
export class SceneItemTransformDialAction extends AbstractStatelessAction<ActionSettings> {
	// Per-context, per-socket: resolved scene item ID for the configured scene+source
	private _sceneItemIdCache = new Map<string, (number | undefined)[]>();
	// Per-context, per-socket: locally-tracked transform property value, optimistically updated on rotate
	private _valueCache = new Map<string, (number | undefined)[]>();
	private _rotateTimers = new Map<string, NodeJS.Timeout>();

	constructor() {
		super('dev.theca11.multiobs.sceneitemtransformdial', { hideTargetIndicators: true });

		this.onDialRotate((evtData: DialRotateData<unknown>) => {
			const { context, payload } = evtData;
			if (!this.contexts.has(context)) return;
			const { settings, displayIdx } = this.contexts.get(context)!;
			this._warnIfDisconnected(context, settings);
			const sceneItemIds = this._sceneItemIdCache.get(context);
			const cached = this._valueCache.get(context);
			if (!sceneItemIds || !cached) return;

			settings.forEach((socketSettings, socketIdx) => {
				if (!socketSettings || sceneItemIds[socketIdx] === undefined || cached[socketIdx] === undefined) return;
				const property = socketSettings.property || 'positionX';
				const step = Number(socketSettings.step) || PROPERTY_CONFIG[property].defaultStep;
				cached[socketIdx] = clampValue(property, cached[socketIdx]! + payload.ticks * step);
			});
			this._updateDialFeedback(context, displayIdx);

			clearTimeout(this._rotateTimers.get(context));
			this._rotateTimers.set(context, setTimeout(() => this._commitValue(context), ROTATE_SETTLE_MS));
		});

		// Push or tap - both reset to a neutral default, there's no meaningful "mute"/"commit" distinction here
		this.onDialUp((evtData: DialUpData<unknown>) => this._resetToDefault(evtData.context));
		this.onTouchTap((evtData: TouchTapData<unknown>) => this._resetToDefault(evtData.context));

		// Filter/source-specific events aren't emitted on scene collection change - refresh explicitly
		sockets.forEach((socket, socketIdx) => {
			socket.on('CurrentSceneCollectionChanged', () => this._refreshSocket(socketIdx));
		});

		this.onSendToPlugin(async ({ payload, context, action }: SendToPluginData<{ event: string, socketIdx: number, sceneName: string }>) => {
			if (payload.event === 'GetSceneItemsList') {
				const sceneItems = await getSceneItemsList(payload.socketIdx, payload.sceneName);
				const groupSceneItems = await getGroupSceneItemsList(payload.socketIdx, payload.sceneName);
				const piPayload = {
					event: 'SourceListLoaded',
					idx: payload.socketIdx,
					sourceList: [...sceneItems, ...groupSceneItems].map(o => o.sourceName),
				};
				$SD.sendToPropertyInspector(context, piPayload, action);
			}
		});
	}

	override async onContextAppear(context: string, { settings, displayIdx }: ContextData<ActionSettings>): Promise<void> {
		$SD.setFeedbackLayout(context, 'actions/dialLayout/layout.json');
		this._sceneItemIdCache.set(context, new Array(sockets.length).fill(undefined));
		this._valueCache.set(context, new Array(sockets.length).fill(undefined));
		await Promise.all(settings.map((socketSettings, socketIdx) => this._refreshTarget(context, socketIdx, socketSettings)));
		this._updateDialFeedback(context, displayIdx);
	}

	override async onContextDisappear(context: string): Promise<void> {
		clearTimeout(this._rotateTimers.get(context));
		this._rotateTimers.delete(context);
		this._sceneItemIdCache.delete(context);
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
		const groupsLists = await getGroupsLists();
		const scenesAndGroups = scenesLists.map((scenes, i) => [...groupsLists[i], ...scenes]);
		const payload = { event: 'SceneListLoaded', scenesLists: scenesAndGroups };
		$SD.sendToPropertyInspector(context, payload, action);
	}

	/**
	 * Re-resolve the scene item ID and re-fetch the current transform value for one socket, across every
	 * context targeting it (e.g. after a reconnect or a scene collection change elsewhere)
	 */
	private async _refreshSocket(socketIdx: number): Promise<void> {
		for (const [context, { settings, displayIdx }] of this.contexts) {
			if (!settings[socketIdx]) continue;
			await this._refreshTarget(context, socketIdx, settings[socketIdx]);
			if (socketIdx === displayIdx) this._updateDialFeedback(context, displayIdx);
		}
	}

	/**
	 * Resolve the scene item ID for a context/socket's configured scene+source and fetch its current
	 * transform value, updating both caches. Leaves both undefined (disabled) on any resolution failure
	 */
	private async _refreshTarget(context: string, socketIdx: number, socketSettings: SocketSettings<ActionSettings> | null): Promise<void> {
		const sceneItemIds = this._sceneItemIdCache.get(context);
		const values = this._valueCache.get(context);
		if (!sceneItemIds || !values) return;
		sceneItemIds[socketIdx] = undefined;
		values[socketIdx] = undefined;

		const { sceneName, sourceName, property } = socketSettings ?? {};
		if (!sceneName || !sourceName || !sockets[socketIdx].isConnected) return;
		try {
			const { sceneItemId } = await sockets[socketIdx].call('GetSceneItemId', { sceneName, sourceName });
			const { sceneItemTransform } = await sockets[socketIdx].call('GetSceneItemTransform', { sceneName, sceneItemId });
			sceneItemIds[socketIdx] = sceneItemId;
			values[socketIdx] = (sceneItemTransform as Record<string, number>)[property || 'positionX'];
		}
		catch {
			// Scene/source/item doesn't exist (yet) - leave undefined, already reset above
		}
	}

	/**
	 * Commit the locally-tracked (optimistic) value to OBS, once rotation has settled
	 */
	private async _commitValue(context: string): Promise<void> {
		this._rotateTimers.delete(context);
		if (!this.contexts.has(context)) return;
		const { settings } = this.contexts.get(context)!;
		const sceneItemIds = this._sceneItemIdCache.get(context);
		const values = this._valueCache.get(context);
		if (!sceneItemIds || !values) return;

		await Promise.allSettled(settings.map((socketSettings, socketIdx) => {
			const sceneItemId = sceneItemIds[socketIdx];
			const value = values[socketIdx];
			if (!socketSettings || sceneItemId === undefined || value === undefined || !sockets[socketIdx].isConnected) return Promise.resolve();
			const property = socketSettings.property || 'positionX';
			return sockets[socketIdx].call('SetSceneItemTransform', {
				sceneName: socketSettings.sceneName,
				sceneItemId,
				sceneItemTransform: { [property]: value },
			});
		}));
	}

	private async _resetToDefault(context: string): Promise<void> {
		if (!this.contexts.has(context)) return;
		const { settings, displayIdx } = this.contexts.get(context)!;
		this._warnIfDisconnected(context, settings);
		clearTimeout(this._rotateTimers.get(context));
		this._rotateTimers.delete(context);

		const values = this._valueCache.get(context);
		if (values) {
			settings.forEach((socketSettings, socketIdx) => {
				if (!socketSettings || values[socketIdx] === undefined) return;
				values[socketIdx] = PROPERTY_CONFIG[socketSettings.property || 'positionX'].resetValue;
			});
		}
		await this._commitValue(context);
		this._updateDialFeedback(context, displayIdx);
	}

	/**
	 * Render the current transform value on the dial's touch display: the source name and property as the
	 * title, the formatted value, and an indicator bar mapped onto that property's cosmetic display range
	 */
	private _updateDialFeedback(context: string, displayIdx: number): void {
		if (!this.contexts.has(context)) return;
		const { settings } = this.contexts.get(context)!;
		const socketSettings = settings[displayIdx];
		const value = this._valueCache.get(context)?.[displayIdx];

		if (!socketSettings?.sourceName || value === undefined) {
			$SD.setFeedback(context, this._dimFeedback({ status: '', title: ' ', value: '', indicator: 0 }, displayIdx));
			return;
		}
		const property = socketSettings.property || 'positionX';
		const config = PROPERTY_CONFIG[property];
		const displayValue = config.wrap ? ((value % 360) + 360) % 360 : value;
		const percent = Math.round(Math.min(100, Math.max(0, ((displayValue - config.displayMin) / (config.displayMax - config.displayMin)) * 100)));
		$SD.setFeedback(context, this._dimFeedback({
			status: '',
			title: `${socketSettings.sourceName} — ${config.label}`,
			value: config.format(value),
			indicator: percent,
		}, displayIdx));
	}
}
