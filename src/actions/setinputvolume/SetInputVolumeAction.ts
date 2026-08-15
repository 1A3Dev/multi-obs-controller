import { AbstractVolumeDialAction } from '../AbstractVolumeDialAction';
import { getInputsLists } from '../lists';
import { Input, SocketSettings } from '../types';

type ActionSettings = { inputName: string, stepDb: string, maxDb: string }

export class SetInputVolumeAction extends AbstractVolumeDialAction<ActionSettings> {
	constructor() {
		super('dev.theca11.multiobs.setinputvolume', { titleParam: 'inputName' });
	}

	protected resolveInputName(_socketIdx: number, socketSettings: SocketSettings<ActionSettings> | null | undefined): string | undefined {
		return socketSettings?.inputName;
	}

	override async onPropertyInspectorReady({ context, action }: { context: string; action: string; }): Promise<void> {
		const inputsLists = await getInputsLists() as Input[][];
		const payload = {
			event: 'InputListLoaded',
			inputsLists: inputsLists.map((list) =>
				list.filter((i) => ['dshow_input', 'wasapi_input_capture', 'wasapi_output_capture'].includes(i.unversionedInputKind)),
			),
		};
		$SD.sendToPropertyInspector(context, payload, action);
	}
}
