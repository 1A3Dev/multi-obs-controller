import { sockets } from '../../plugin/sockets';
import { AbstractStatefulRequestAction } from '../BaseRequestAction';
import { StateEnum } from '../StateEnum';
import { getIngests, getThresholds, IrltkTargetSettings, isIngestPagingActive, onIngestPageChanged, onIngestsUpdated, resolveIngest, sortIngests } from '../irltkIngests';
import { getSourceFilterList } from '../lists';
import { ContextData, SendToPluginData, SingleRequestPayload, SocketSettings } from '../types';

type ActionSettings = IrltkTargetSettings & { filterName: string }

function resolveSourceName(socketIdx: number, settings: Partial<ActionSettings> | null | undefined): string | undefined {
	if (!settings) return undefined;
	return resolveIngest(getIngests(socketIdx), settings, socketIdx, getThresholds(socketIdx))?.obs_source_name;
}

export class IrltkIngestFilterAction extends AbstractStatefulRequestAction<ActionSettings, 'SourceFilterEnableStateChanged'> {
	private _lastResolvedSources = new Map<string, (string | undefined)[]>();	// <context, resolved ingest source per socket>

	constructor() {
		super('dev.theca11.multiobs.irltkingestfilter', { titleParam: 'filterName', statusEvent: 'SourceFilterEnableStateChanged' });

		this.onSendToPlugin(async ({ payload, context, action }: SendToPluginData<{ event: string, socketIdx: number, sourceName?: string }>) => {
			if (payload.event === 'GetIngestFilterList') {
				// No specific ingest (dynamic position): offer the filters of every ingest, since the resolved one changes over time
				const sourceNames = payload.sourceName ? [payload.sourceName] : [...getIngests(payload.socketIdx).keys()];
				const filterLists = await Promise.all(sourceNames.map(sourceName => getSourceFilterList(payload.socketIdx, sourceName)));
				const filterList = [...new Set(filterLists.flat().map(o => String(o.filterName)))];
				$SD.sendToPropertyInspector(context, { event: 'FilterListLoaded', idx: payload.socketIdx, filterList }, action);
			}
		});

		// Only refetch when the resolved ingest changes, not on every IRLToolkit status update
		const refresh = async (socketIdx: number) => {
			for (const [context, contextData] of this.contexts) {
				const socketSettings = contextData.settings[socketIdx];
				const lastSources = this._lastResolvedSources.get(context);
				if (!socketSettings || !lastSources) continue;
				const sourceName = resolveSourceName(socketIdx, socketSettings);
				if (lastSources[socketIdx] === sourceName) continue;
				lastSources[socketIdx] = sourceName;
				await this._refreshState(context, socketIdx);
			}
		};
		onIngestsUpdated(refresh);
		onIngestPageChanged(refresh);

		// Refetch states on scene collection changed, since source-specific events are not emitted
		sockets.forEach((socket, socketIdx) => {
			socket.on('CurrentSceneCollectionChanged', async () => {
				for (const [context] of this.contexts) await this._refreshState(context, socketIdx);
			});
		});
	}

	override getPayloadFromSettings(socketIdx: number, settings: Record<string, never> | Partial<ActionSettings>, state: StateEnum, desiredState?: number | undefined): SingleRequestPayload<'SetSourceFilterEnabled'> {
		return {
			requestType: 'SetSourceFilterEnabled',
			requestData: {
				sourceName: resolveSourceName(socketIdx, settings) as string,
				filterName: settings.filterName as string,
				filterEnabled: desiredState !== undefined ? !desiredState : state !== StateEnum.Active,
			},
		};
	}

	override async onPropertyInspectorReady({ context, action }: { context: string; action: string; }): Promise<void> {
		const ingestsLists = sockets.map((_, socketIdx) => sortIngests([...getIngests(socketIdx).values()], socketIdx));
		const payload = { event: 'IngestListLoaded', ingestsLists, pagingActive: isIngestPagingActive() };
		$SD.sendToPropertyInspector(context, payload, action);
	}

	override async onContextAppear(context: string, { settings }: ContextData<ActionSettings>): Promise<void> {
		this._lastResolvedSources.set(context, settings.map((socketSettings, socketIdx) => resolveSourceName(socketIdx, socketSettings)));
	}

	override async onContextSettingsUpdated(context: string, { settings }: ContextData<ActionSettings>): Promise<void> {
		this._lastResolvedSources.set(context, settings.map((socketSettings, socketIdx) => resolveSourceName(socketIdx, socketSettings)));
	}

	override async onContextDisappear(context: string): Promise<void> {
		this._lastResolvedSources.delete(context);
	}

	override async fetchState(socketSettings: NonNullable<SocketSettings<ActionSettings>>, socketIdx: number): Promise<StateEnum.Active | StateEnum.Intermediate | StateEnum.Inactive> {
		const sourceName = resolveSourceName(socketIdx, socketSettings);
		const { filterName } = socketSettings;
		if (!sourceName || !filterName) return StateEnum.Inactive;
		const { filterEnabled } = await sockets[socketIdx].call('GetSourceFilter', { sourceName, filterName });
		return filterEnabled ? StateEnum.Active : StateEnum.Inactive;
	}

	override async shouldUpdateState(evtData: { sourceName: string, filterName: string, filterEnabled: boolean; }, socketSettings: SocketSettings<ActionSettings>, socketIdx: number): Promise<boolean> {
		return socketSettings.filterName === evtData.filterName && resolveSourceName(socketIdx, socketSettings) === evtData.sourceName;
	}

	override getStateFromEvent(evtData: { sourceName: string, filterName: string, filterEnabled: boolean; }): StateEnum {
		return evtData.filterEnabled ? StateEnum.Active : StateEnum.Inactive;
	}

	private async _refreshState(context: string, socketIdx: number): Promise<void> {
		const contextData = this.contexts.get(context);
		const socketSettings = contextData?.settings[socketIdx];
		if (!contextData || !socketSettings || !sockets[socketIdx].isConnected) return;
		const newState = await this.fetchState(socketSettings, socketIdx).catch(() => StateEnum.Inactive);
		if (newState === contextData.states[socketIdx]) return;
		this.setContextSocketState(context, socketIdx, newState);
		this.updateKeyImage(context);
	}
}
