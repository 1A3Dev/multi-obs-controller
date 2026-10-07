import { AbstractStatelessAction } from '../BaseWsAction';
import { StateEnum } from '../StateEnum';
import { ContextData } from '../types';

const CONNECTED_IMG = `data:image/svg+xml;base64,${btoa('<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144"><rect fill="#5a9b4a" width="144" height="144" rx="22"/><path fill="#EFEFEF" d="M60.8 85.6L46.2 71L41.2 75.9L60.8 95.5L102.8 53.5L97.9 48.6Z"/></svg>')}`;
const DISCONNECTED_IMG = `data:image/svg+xml;base64,${btoa('<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144"><rect fill="#2b2b2b" width="144" height="144" rx="22"/><path fill="#c94b4b" d="M107 44.05L99.95 37L72 64.95L44.05 37L37 44.05L64.95 72L37 99.95L44.05 107L72 79.05L99.95 107L107 99.95L79.05 72Z"/></svg>')}`;

export class ConnectionStatusAction extends AbstractStatelessAction<Record<string, never>> {

	constructor() {
		super('uk.1a3.multiobs.connectionstatus');
	}

	override async fetchState(): Promise<StateEnum.Active> {
		return StateEnum.Active;
	}

	protected override async updateKeyImage(context: string): Promise<void> {
		const contextData = this.contexts.get(context);
		if (!contextData) return;
		const { settings, states } = contextData;
		const targetedStates = states.filter((_, i) => settings[i] !== null);
		const connected = targetedStates.some(state => state === StateEnum.Active);
		$SD.setImage(context, connected ? CONNECTED_IMG : DISCONNECTED_IMG);
	}

	protected override _updateSDState(context: string, contextData: ContextData<unknown>): void {
		const { targets, states } = contextData;
		const connected = states.filter((_, i) => targets.includes(i + 1)).some(state => state === StateEnum.Active);
		$SD.setState(context, connected ? 0 : 1);
	}
}
