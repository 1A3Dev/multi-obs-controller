import { AbstractStatelessAction } from '../BaseWsAction';
import { StateEnum } from '../StateEnum';
import { ContextData } from '../types';

export class ConnectionStatusAction extends AbstractStatelessAction<Record<string, never>> {

	constructor() {
		super('uk.1a3.multiobs.connectionstatus');
	}

	override async fetchState(): Promise<StateEnum.Active> {
		return StateEnum.Active;
	}

	protected override async updateKeyImage(): Promise<void> {
		// Images are driven by manifest states via setState
	}

	protected override _updateSDState(context: string, contextData: ContextData<unknown>): void {
		const { targets, states } = contextData;
		const connected = states.filter((_, i) => targets.includes(i + 1)).some(state => state === StateEnum.Active);
		$SD.setState(context, connected ? 0 : 1);
	}
}
