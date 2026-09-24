import { sockets } from '../../plugin/sockets';
import { AbstractVolumeDialAction } from '../AbstractVolumeDialAction';
import { getIngestDisplayName, getIngests, getThresholds, IrltkTargetSettings, isIngestPagingActive, onIngestPageChanged, onIngestsUpdated, resolveIngest, sortIngests } from '../irltkIngests';
import { SocketSettings } from '../types';

type ActionSettings = IrltkTargetSettings & { stepDb: string, maxDb: string }

export class IrltkIngestVolumeAction extends AbstractVolumeDialAction<ActionSettings> {
	constructor() {
		super('uk.1a3.multiobs.irltkingestvolume', { irltkCompat: 'only' });

		onIngestsUpdated((socketIdx) => this.notifyTargetsChanged(socketIdx));
		onIngestPageChanged((socketIdx) => this.notifyTargetsChanged(socketIdx));
	}

	protected resolveInputName(socketIdx: number, socketSettings: SocketSettings<ActionSettings> | null | undefined): string | undefined {
		if (!socketSettings) return undefined;
		return resolveIngest(getIngests(socketIdx), socketSettings, socketIdx, getThresholds(socketIdx))?.obs_source_name;
	}

	protected override resolveDisplayName(socketIdx: number, socketSettings: SocketSettings<ActionSettings> | null | undefined): string | undefined {
		if (!socketSettings) return undefined;
		const ingest = resolveIngest(getIngests(socketIdx), socketSettings, socketIdx, getThresholds(socketIdx));
		return ingest && getIngestDisplayName(ingest);
	}

	override async onPropertyInspectorReady({ context, action }: { context: string; action: string; }): Promise<void> {
		const ingestsLists = sockets.map((_, socketIdx) => sortIngests([...getIngests(socketIdx).values()], socketIdx));
		const payload = { event: 'IngestListLoaded', ingestsLists, pagingActive: isIngestPagingActive() };
		$SD.sendToPropertyInspector(context, payload, action);
	}
}
