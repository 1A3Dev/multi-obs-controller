import { sockets } from '../../plugin/sockets';
import { AbstractStatelessRequestAction } from '../BaseRequestAction';
import { StateEnum } from '../StateEnum';
import { getIngestDisplayName, getIngests, getThresholds, hasIngestTarget, IrltkTargetSettings, isIngestOnline, isIngestPagingActive, onIngestPageChanged, onIngestsUpdated, resolveIngest, sortIngests } from '../irltkIngests';
import { getTvuBatteryPercent, onTvuBatteryUpdated, setTvuDeviceLink } from '../tvuBattery';
import { ContextData, SingleRequestPayload, SocketSettings } from '../types';

type ActionSettings = IrltkTargetSettings & { titleTemplate?: string, tvuDevice?: string }

const enum KeyState {
	Online = 0,
	LowBitrate = 1,
	Offline = 2,
	Disconnected = 3,
}

export class IrltkIngestStatusAction extends AbstractStatelessRequestAction<ActionSettings> {
	constructor() {
		super('uk.1a3.multiobs.irltkingeststatus', { irltkCompat: 'only' });

		const refresh = (socketIdx: number) => {
			for (const [context, contextData] of this.contexts) {
				const socketSettings = contextData.settings[socketIdx];
				if (!socketSettings || !hasIngestTarget(socketSettings)) continue;
				this.setContextSocketState(context, socketIdx, this._computeState(socketIdx, socketSettings));
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
		const name = ingest ? getIngestDisplayName(ingest) : '';
		const bitrate = ingest && isIngestOnline(ingest, getThresholds(displayIdx)) ? `${ingest.router_bitrate.toLocaleString('en-US')} kbps` : '';
		const batteryPercent = socketSettings.tvuDevice ? getTvuBatteryPercent(socketSettings.tvuDevice.trim()) : undefined;
		const battery = batteryPercent !== undefined ? `${batteryPercent}%` : '';

		const templateLines = socketSettings.titleTemplate.split('\n');
		const title = templateLines
		.map(line => line.replace(/\{name\}/g, name).replace(/\{bitrate\}/g, bitrate).replace(/\{battery\}/g, battery))
		.filter((line, i) => line !== '' || templateLines[i] === '')
		.join('\n');
		$SD.setTitle(context, title);
	}
}
