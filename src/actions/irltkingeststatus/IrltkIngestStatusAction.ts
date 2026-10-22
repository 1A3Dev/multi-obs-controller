import { sockets } from '../../plugin/sockets';
import { AbstractStatelessRequestAction } from '../BaseRequestAction';
import { StateEnum } from '../StateEnum';
import { globalSettings, resolveServers } from '../globalSettings';
import { BITRATE_HISTORY_LENGTH, getBitrateHistory, getIngestDisplayName, getIngests, getThresholds, hasIngestTarget, IrltkTargetSettings, isIngestOnline, isIngestPagingActive, onIngestPageChanged, onIngestsUpdated, resolveIngest, sortIngests } from '../irltkIngests';
import { getTvuBatteryPercent, onTvuBatteryUpdated, setTvuDeviceLink } from '../tvuBattery';
import { ContextData, SingleRequestPayload, SocketSettings } from '../types';

type ActionSettings = IrltkTargetSettings & { titleTemplate?: string, tvuDevice?: string, bitrateGraph?: 'hide' }

const enum KeyState {
	Online = 0,
	LowBitrate = 1,
	Offline = 2,
	Disconnected = 3,
}

const KEY_COLORS = {
	[KeyState.Online]: '#28d629',
	[KeyState.LowBitrate]: '#fcdc1b',
	[KeyState.Offline]: '#f61011',
};

const GRAPH = { left: 16, right: 128, top: 28, bottom: 128 };

function renderGraphKey(samples: number[], color: string): string {
	let graph = '';
	if (samples.length >= 2) {
		const max = Math.max(...samples, 1) * 1.1;
		const step = (GRAPH.right - GRAPH.left) / (BITRATE_HISTORY_LENGTH - 1);
		const points = samples.map((value, i) => {
			const x = GRAPH.right - (samples.length - 1 - i) * step;
			const y = GRAPH.bottom - (value / max) * (GRAPH.bottom - GRAPH.top);
			return `${x.toFixed(1)},${y.toFixed(1)}`;
		});
		const [firstX] = points[0].split(',');
		graph = `<polygon points="${firstX},${GRAPH.bottom} ${points.join(' ')} ${GRAPH.right},${GRAPH.bottom}" fill="${color}" fill-opacity="0.25"/>`
			+ `<polyline points="${points.join(' ')}" fill="none" stroke="${color}" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"/>`;
	}
	return '<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">'
		+ '<rect x="0" y="0" width="144" height="144" fill="#000"/>'
		+ graph
		+ `<rect x="10" y="10" width="124" height="124" rx="12" fill="none" stroke="${color}" stroke-width="4"/>`
		+ '</svg>';
}

export class IrltkIngestStatusAction extends AbstractStatelessRequestAction<ActionSettings> {
	constructor() {
		super('dev.theca11.multiobs.irltkingeststatus');

		const refresh = (socketIdx: number) => {
			for (const [context, contextData] of this.contexts) {
				const socketSettings = contextData.settings[socketIdx];
				if (!socketSettings || !hasIngestTarget(socketSettings)) continue;
				const newState = sockets[socketIdx].isConnected ? this._computeState(socketIdx, socketSettings) : StateEnum.Unavailable;
				this.setContextSocketState(context, socketIdx, newState);
				if (contextData.displayIdx === socketIdx) this._updateIngestTitle(context, contextData);
			}
		};
		onIngestsUpdated(refresh);
		onIngestPageChanged(refresh);

		onTvuBatteryUpdated(() => {
			for (const [context, contextData] of this.contexts) {
				this._updateIngestTitle(context, contextData);
			}
		});
	}

	override getPayloadFromSettings(socketIdx: number, settings: Record<string, never> | Partial<ActionSettings>): SingleRequestPayload<'PressInputPropertiesButton'> {
		const ingest = resolveIngest(getIngests(socketIdx), settings, socketIdx, getThresholds(socketIdx));
		return {
			requestType: 'PressInputPropertiesButton',
			requestData: { inputName: ingest?.obs_source_name, propertyName: 'resetplayer' },
		};
	}

	override async fetchState(socketSettings: NonNullable<SocketSettings<ActionSettings>>, socketIdx: number): Promise<StateEnum.Active | StateEnum.Intermediate | StateEnum.Inactive> {
		if (!hasIngestTarget(socketSettings)) return StateEnum.Inactive;
		return this._computeState(socketIdx, socketSettings);
	}

	override async onPropertyInspectorReady({ context, action }: { context: string; action: string; }): Promise<void> {
		const ingestsLists = sockets.map((_, socketIdx) => sortIngests([...getIngests(socketIdx).values()], socketIdx));
		const payload = { event: 'IngestListLoaded', ingestsLists, pagingActive: isIngestPagingActive() };
		$SD.sendToPropertyInspector(context, payload, action);
	}

	override async onContextAppear(context: string, contextData: ContextData<ActionSettings>): Promise<void> {
		setTvuDeviceLink(context, contextData.settings[contextData.displayIdx]?.tvuDevice);
		this._updateIngestTitle(context, contextData);
	}

	override async onContextSettingsUpdated(context: string, contextData: ContextData<ActionSettings>): Promise<void> {
		setTvuDeviceLink(context, contextData.settings[contextData.displayIdx]?.tvuDevice);
		this._updateIngestTitle(context, contextData);
	}

	override async onContextDisappear(context: string): Promise<void> {
		setTvuDeviceLink(context, undefined);
	}

	protected override async updateKeyImage(): Promise<void> {
		return;
	}

	protected override _updateSDState(context: string, contextData: ContextData<unknown>): void {
		const { states, displayIdx } = contextData;
		const state = states[displayIdx];
		const keyState = state === StateEnum.Active ? KeyState.Online
			: state === StateEnum.Intermediate ? KeyState.LowBitrate
				: state === StateEnum.Unavailable ? KeyState.Disconnected
					: KeyState.Offline;
		$SD.setState(context, keyState);
		if (keyState !== KeyState.Disconnected) this._updateGraphImage(context, contextData as ContextData<ActionSettings>, keyState);
	}

	private _updateGraphImage(context: string, contextData: ContextData<ActionSettings>, keyState: Exclude<KeyState, KeyState.Disconnected>): void {
		const { displayIdx, settings } = contextData;
		const socketSettings = settings[displayIdx];
		const ingest = socketSettings && socketSettings.bitrateGraph !== 'hide' && hasIngestTarget(socketSettings)
			? resolveIngest(getIngests(displayIdx), socketSettings, displayIdx, getThresholds(displayIdx))
			: undefined;
		const samples = ingest ? getBitrateHistory(displayIdx, ingest.obs_source_name) : [];
		if (!ingest || samples.every(value => value <= 0)) {
			$SD.setImage(context, undefined, keyState);
			return;
		}
		const svg = renderGraphKey(samples, KEY_COLORS[keyState]);
		$SD.setImage(context, `data:image/svg+xml;base64,${btoa(svg)}`, keyState);
	}

	private _computeState(socketIdx: number, socketSettings: ActionSettings): StateEnum.Active | StateEnum.Intermediate | StateEnum.Inactive {
		const ingest = resolveIngest(getIngests(socketIdx), socketSettings, socketIdx, getThresholds(socketIdx));
		if (!ingest) return StateEnum.Inactive;

		if (ingest.media_state) {
			if (ingest.media_state === 'OBS_MEDIA_STATE_PLAYING') return StateEnum.Active;
			if (ingest.media_state === 'OBS_MEDIA_STATE_OPENING' || ingest.media_state === 'OBS_MEDIA_STATE_BUFFERING') return StateEnum.Intermediate;
			return StateEnum.Inactive;
		}
		const { low, offline } = getThresholds(socketIdx);
		if (ingest.router_bitrate > low) return StateEnum.Active;
		if (ingest.router_bitrate > offline) return StateEnum.Intermediate;
		return StateEnum.Inactive;
	}

	private _updateIngestTitle(context: string, contextData: ContextData<ActionSettings>): void {
		const { displayIdx, settings } = contextData;
		const socketSettings = settings[displayIdx];
		if (!socketSettings?.titleTemplate || !hasIngestTarget(socketSettings)) {
			$SD.setTitle(context, '');
			return;
		}

		const ingest = resolveIngest(getIngests(displayIdx), socketSettings, displayIdx, getThresholds(displayIdx));
		const name = ingest ? getIngestDisplayName(ingest, resolveServers(globalSettings)[displayIdx]) : '';
		const online = !!ingest && isIngestOnline(ingest, getThresholds(displayIdx));
		const useMbps = globalSettings.bitrateUnit === 'mbps';
		const bitrateValue = !online ? ''
			: useMbps ? (ingest.router_bitrate / 1000).toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })
				: ingest.router_bitrate.toLocaleString('en-US');
		const bitrateUnit = !online ? '' : useMbps ? 'Mbps' : 'Kbps';
		const bitrate = online ? `${bitrateValue} ${bitrateUnit}` : '';
		const batteryPercent = socketSettings.tvuDevice ? getTvuBatteryPercent(socketSettings.tvuDevice.trim()) : undefined;
		const battery = batteryPercent !== undefined ? `${batteryPercent}%` : '';

		const templateLines = socketSettings.titleTemplate.split('\n');
		const title = templateLines
		.map(line => line.replace(/\{name\}/g, name).replace(/\{bitrate\}/g, bitrate).replace(/\{bitrateValue\}/g, bitrateValue).replace(/\{bitrateUnit\}/g, bitrateUnit).replace(/\{battery\}/g, battery))
		.filter((line, i) => line !== '' || templateLines[i] === '')
		.join('\n');
		$SD.setTitle(context, title);
	}
}
