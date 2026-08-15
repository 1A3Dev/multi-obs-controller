import { sockets } from '../../plugin/sockets';
import { secondsToTimecode, timecodeToSeconds } from '../../plugin/utils';
import { AbstractStatefulAction } from '../BaseWsAction';
import { globalSettings, resolveServers } from '../globalSettings';
import { getOutputStatus, onIngestsUpdated } from '../irltkIngests';
import { StateEnum } from '../StateEnum';
import { ContextData, SocketSettings } from '../types';

type ActionSettings = { titleTemplate?: string }

/** Manifest state indexes - must match the "States" order in manifest.json for this action */
const enum KeyState {
	Online = 0,
	Offline = 1,
	Disconnected = 2,
}

export class StreamStatusAction extends AbstractStatefulAction<ActionSettings, 'StreamStateChanged'> {
	private _status: ('on' | 'reconnecting' | 'off')[] = new Array(sockets.length).fill('off');
	private _startTimestamp: number[] = new Array(sockets.length).fill(0);
	private _timerInterval: NodeJS.Timeout | undefined;

	constructor() {
		super('dev.theca11.multiobs.streamstatus', { statusEvent: 'StreamStateChanged' });
		this._attachListenersForTimer();
		onIngestsUpdated(socketIdx => this._refreshIrltkStatus(socketIdx));
	}

	override async fetchState(_socketSettings: SocketSettings<ActionSettings>, socketIdx: number): Promise<StateEnum.Active | StateEnum.Intermediate | StateEnum.Inactive> {
		return this._stateFromStatus(this._status[socketIdx]);
	}

	// IRLTK servers get their stream status from IRLTKStatusUpdate instead (see _refreshIrltkStatus) -
	// OBS's own StreamStateChanged/GetStreamStatus only reflects whether OBS's local output object thinks
	// it's started, not whether IRLToolkit is actually routing a live stream, so it's an unreliable proxy
	// for "online" on that path and is ignored there entirely rather than racing with the real source
	override async shouldUpdateState(_evtData: unknown, _socketSettings: SocketSettings<ActionSettings>, socketIdx: number): Promise<boolean> {
		return !this._isIrltkSocket(socketIdx);
	}

	override getStateFromEvent(evtData: { outputState: string }, _socketSettings: SocketSettings<ActionSettings>, _evtName: 'StreamStateChanged', socketIdx: number): StateEnum {
		switch (evtData.outputState) {
			case 'OBS_WEBSOCKET_OUTPUT_STARTED':
			case 'OBS_WEBSOCKET_OUTPUT_RECONNECTED':
				this._status[socketIdx] = 'on';
				break;
			case 'OBS_WEBSOCKET_OUTPUT_STARTING':
			case 'OBS_WEBSOCKET_OUTPUT_RECONNECTING':
			case 'OBS_WEBSOCKET_OUTPUT_STOPPING':
				this._status[socketIdx] = 'reconnecting';
				break;
			default:
				this._status[socketIdx] = 'off';
		}
		return this._stateFromStatus(this._status[socketIdx]);
	}

	override async onSocketConnected(socketIdx: number): Promise<void> {
		if (this._isIrltkSocket(socketIdx)) {
			this._refreshIrltkStatus(socketIdx);
			return;
		}
		const { outputActive, outputReconnecting, outputDuration } = await sockets[socketIdx].call('GetStreamStatus');
		this._status[socketIdx] = outputReconnecting ? 'reconnecting' : outputActive ? 'on' : 'off';
		this._startTimestamp[socketIdx] = outputReconnecting || outputActive ? Date.now() - outputDuration : 0;
		this._updateTimer();
	}

	override async onSocketDisconnected(socketIdx: number): Promise<void> {
		this._status[socketIdx] = 'off';
		this._updateTimer();
	}

	override async onContextAppear(context: string, contextData: ContextData<ActionSettings>): Promise<void> {
		this._setTimerTitle(context, contextData.settings);
	}

	override async onContextSettingsUpdated(context: string, contextData: ContextData<ActionSettings>): Promise<void> {
		this._setTimerTitle(context, contextData.settings);
	}

	// Relies entirely on the manifest's native States (Online/Offline/Disconnected, set via _updateSDState
	// below) instead of the shared per-pixel state-color renderer, so a user's own custom icon (right-click
	// a key > Set Image, per state) actually sticks instead of being redrawn over on every update
	protected override async updateKeyImage(): Promise<void> {
		return;
	}

	// Every targeted socket disconnected reads as its own dimmed state, rather than collapsing into
	// Offline like a targeted socket that's merely connected-but-not-streaming does. A mix (some connected,
	// some not) still reads as Offline - there's at least one server this key can meaningfully speak for
	protected override _updateSDState(context: string, contextData: ContextData<unknown>): void {
		const { targets, states } = contextData;
		const targetedStates = states.filter((_, i) => targets.includes(i + 1));
		const keyState = targetedStates.every(state => state === StateEnum.Active) ? KeyState.Online
			: targetedStates.every(state => state === StateEnum.Unavailable) ? KeyState.Disconnected
				: KeyState.Offline;
		$SD.setState(context, keyState);
	}

	private _stateFromStatus(status: 'on' | 'reconnecting' | 'off'): StateEnum.Active | StateEnum.Intermediate | StateEnum.Inactive {
		return status === 'on' ? StateEnum.Active : status === 'reconnecting' ? StateEnum.Intermediate : StateEnum.Inactive;
	}

	private _isIrltkSocket(socketIdx: number): boolean {
		return resolveServers(globalSettings)[socketIdx]?.irltk === 'true';
	}

	// Pulls this socket's status out of the shared IRLTKStatusUpdate cache (irltkIngests.ts) - a no-op for
	// non-IRLTK sockets, and for IRLTK ones before the first update has arrived (e.g. right after connecting)
	private _refreshIrltkStatus(socketIdx: number): void {
		if (!this._isIrltkSocket(socketIdx)) return;
		const outputStatus = getOutputStatus(socketIdx);
		if (!outputStatus) return;

		this._status[socketIdx] = outputStatus.stream_status ? 'on' : 'off';
		this._startTimestamp[socketIdx] = outputStatus.stream_status ? Date.now() - timecodeToSeconds(outputStatus.stream_timecode) * 1000 : 0;
		this._updateTimer();

		const newState = this._stateFromStatus(this._status[socketIdx]);
		for (const [context, { settings, states }] of this.contexts) {
			if (settings[socketIdx] && newState !== states[socketIdx]) {
				this.setContextSocketState(context, socketIdx, newState);
			}
		}
	}

	private _attachListenersForTimer() {
		sockets.forEach((socket, socketIdx) => {
			socket.on('StreamStateChanged', ({ outputState }) => {
				if (this._isIrltkSocket(socketIdx)) return; // driven by IRLTKStatusUpdate instead - see _refreshIrltkStatus
				if (outputState === 'OBS_WEBSOCKET_OUTPUT_STARTED') {
					this._startTimestamp[socketIdx] = Date.now();
				}
				this._updateTimer();
			});
		});
	}

	private _updateTimer() {
		if (this._status.every(s => s === 'off')) {
			clearInterval(this._timerInterval);
			this._timerInterval = undefined;
			for (const [context, { settings }] of this.contexts) {
				this._setTimerTitle(context, settings);
			}
		}
		else if (!this._timerInterval) {
			this._timerInterval = setInterval(() => {
				for (const [context, { settings }] of this.contexts) {
					this._setTimerTitle(context, settings);
				}
			}, 1000);
		}
	}

	// A line consisting of nothing but a variable that resolved empty is dropped entirely, rather than
	// left as a blank line, so e.g. a lone "{time}" line disappears while the stream is offline instead
	// of leaving a gap. A line that was already blank in the template (a deliberate spacer) is left
	// alone since it never contained a variable to begin with
	private _renderTitleTemplate(template: string, time: string): string {
		const templateLines = template.split('\n');
		return templateLines
		.map(line => line.replace(/\{time\}/g, time))
		.filter((line, i) => line !== '' || templateLines[i] === '')
		.join('\n');
	}

	private _setTimerTitle(context: string, settings: (SocketSettings<ActionSettings> | null)[]) {
		const blocks = settings
		.map((socketSettings, socketIdx) => {
			if (!socketSettings?.titleTemplate) return;
			const time = this._status[socketIdx] === 'on' ? secondsToTimecode((Date.now() - this._startTimestamp[socketIdx]) / 1000) : '';
			return this._renderTitleTemplate(socketSettings.titleTemplate, time);
		})
		.filter((block): block is string => !!block);
		$SD.setTitle(context, blocks.join('\n'));
	}
}
