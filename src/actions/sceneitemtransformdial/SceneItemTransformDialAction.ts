import { sockets } from '../../plugin/sockets';
import { AbstractStatelessAction } from '../BaseWsAction';
import { getGroupSceneItemsList, getGroupsLists, getSceneItemsList, getScenesLists } from '../lists';
import { ContextData, DialRotateData, DialUpData, SendToPluginData, SocketSettings, TouchTapData } from '../types';

const ROTATE_SETTLE_MS = 150;

type TransformProperty = 'positionX' | 'positionY' | 'rotation' | 'scaleX' | 'scaleY' | 'cropLeft' | 'cropTop' | 'cropRight' | 'cropBottom';
type ActionSettings = { sceneName: string, sourceName: string, property: TransformProperty, step: string };

type PropertyConfig = {
	label: string,
	defaultStep: number,
	resetValue: number,
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

function clampValue(property: TransformProperty, value: number): number {
	return property.startsWith('scale') || property.startsWith('crop') ? Math.max(0, value) : value;
}

export class SceneItemTransformDialAction extends AbstractStatelessAction<ActionSettings> {
	private _sceneItemIdCache = new Map<string, (number | undefined)[]>();
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

		this.onDialUp((evtData: DialUpData<unknown>) => this._resetToDefault(evtData.context));
		this.onTouchTap((evtData: TouchTapData<unknown>) => this._resetToDefault(evtData.context));

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

	private async _refreshSocket(socketIdx: number): Promise<void> {
		for (const [context, { settings, displayIdx }] of this.contexts) {
			if (!settings[socketIdx]) continue;
			await this._refreshTarget(context, socketIdx, settings[socketIdx]);
			if (socketIdx === displayIdx) this._updateDialFeedback(context, displayIdx);
		}
	}

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
