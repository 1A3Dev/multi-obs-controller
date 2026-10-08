import { sockets } from '../../plugin/sockets';
import { AbstractStatelessAction } from '../BaseWsAction';
import { StateEnum } from '../StateEnum';
import { globalSettings } from '../globalSettings';
import { KeyDownData, KeyUpData } from '../types';

export class ReconnectAction extends AbstractStatelessAction<Record<string, never>> {

	constructor() {
		super('uk.1a3.multiobs.reconnect');
		this.onSinglePress((evtData: KeyUpData<unknown>) => this._reconnect(evtData.context));
		this.onLongPress((evtData: KeyDownData<unknown>) => this._reconnect(evtData.context));
	}

	/** Connected servers show as active, disconnected ones are dimmed */
	override async fetchState(): Promise<StateEnum.Active> {
		return StateEnum.Active;
	}

	private _reconnect(context: string) {
		const contextData = this.contexts.get(context);
		if (!contextData) return;
		contextData.targets.forEach(target => { sockets[target - 1]?.tryReconnect(); });
		if (globalSettings.feedback !== 'hide') setTimeout(() => $SD.showOk(context), 150);
	}
}
