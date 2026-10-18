import { AbstractFilterDialAction } from '../AbstractFilterDialAction';
import { getInputsLists, getScenesLists } from '../lists';
import { SocketSettings } from '../types';

type ActionSettings = { sourceName: string };

export class FilterDialAction extends AbstractFilterDialAction<ActionSettings> {
	constructor() {
		super('uk.1a3.multiobs.filterdial');
	}

	protected resolveSourceName(socketIdx: number, socketSettings: SocketSettings<ActionSettings> | null | undefined): string | undefined {
		return socketSettings?.sourceName || undefined;
	}

	override async onPropertyInspectorReady({ context, action }: { context: string; action: string; }): Promise<void> {
		const scenesLists = await getScenesLists();
		const inputsLists = await getInputsLists();
		const payload = { event: 'SourceListLoaded', scenesLists, inputsLists };
		$SD.sendToPropertyInspector(context, payload, action);
	}
}
