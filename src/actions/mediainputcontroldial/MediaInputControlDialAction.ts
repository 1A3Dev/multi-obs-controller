import { sockets } from '../../plugin/sockets';
import { AbstractStatelessAction } from '../BaseWsAction';
import { getInputsLists } from '../lists';
import { ContextData, DialRotateData, DialUpData, Input, TouchTapData } from '../types';

const DEFAULT_STEP_SEC = 5;
const POLL_MS = 1000;
const ROTATE_SETTLE_MS = 700;

type ActionSettings = { inputName: string, action: 'play_stop' | 'play_pause' | 'restart' | 'stop', step: string };
type MediaStatus = { mediaState: string, mediaDuration: number, mediaCursor: number };
type PlaybackState = 'active' | 'intermediate' | 'inactive';

function mapMediaState(mediaState: string): PlaybackState {
	switch (mediaState) {
		case 'OBS_MEDIA_STATE_PLAYING':
			return 'active';
		case 'OBS_MEDIA_STATE_OPENING':
		case 'OBS_MEDIA_STATE_BUFFERING':
		case 'OBS_MEDIA_STATE_PAUSED':
			return 'intermediate';
		default:
			return 'inactive';
	}
}

const STATUS_LABELS: Partial<Record<string, string>> = {
	OBS_MEDIA_STATE_OPENING: 'OPENING',
	OBS_MEDIA_STATE_BUFFERING: 'BUFFERING',
	OBS_MEDIA_STATE_PAUSED: 'PAUSED',
	OBS_MEDIA_STATE_STOPPED: 'STOPPED',
	OBS_MEDIA_STATE_ENDED: 'ENDED',
	OBS_MEDIA_STATE_ERROR: 'ERROR',
};

function formatTime(ms: number | undefined): string {
	if (ms === undefined || Number.isNaN(ms) || ms < 0) return '--:--';
	const totalSec = Math.floor(ms / 1000);
	const m = Math.floor(totalSec / 60);
	const s = totalSec % 60;
	return `${m}:${String(s).padStart(2, '0')}`;
}

export class MediaInputControlDialAction extends AbstractStatelessAction<ActionSettings> {
	private _statusCache = new Map<string, MediaStatus | undefined>();
	private _pollTimers = new Map<string, NodeJS.Timeout>();
	private _lastRotateAt = new Map<string, number>();

	constructor() {
		super('dev.theca11.multiobs.mediainputcontroldial', { titleParam: 'inputName', hideTargetIndicators: true });

		this.onDialRotate((evtData: DialRotateData<unknown>) => {
			const { context, payload } = evtData;
			if (!this.contexts.has(context)) return;
			const { settings, displayIdx } = this.contexts.get(context)!;
			this._warnIfDisconnected(context, settings);
			this._lastRotateAt.set(context, Date.now());

			settings.forEach((socketSettings, socketIdx) => {
				if (!socketSettings?.inputName || !sockets[socketIdx].isConnected) return;
				const stepMs = (Number(socketSettings.step) || DEFAULT_STEP_SEC) * 1000;
				sockets[socketIdx].call('OffsetMediaInputCursor', { inputName: socketSettings.inputName, mediaCursorOffset: payload.ticks * stepMs }).catch(() => {});
			});

			const cache = this._statusCache.get(context);
			const displaySettings = settings[displayIdx];
			if (cache && displaySettings?.inputName) {
				const stepMs = (Number(displaySettings.step) || DEFAULT_STEP_SEC) * 1000;
				let cursor = cache.mediaCursor + payload.ticks * stepMs;
				if (cache.mediaDuration) cursor = Math.min(cache.mediaDuration, Math.max(0, cursor));
				cache.mediaCursor = cursor;
				this._renderFeedback(context, displayIdx);
			}
		});

		this.onDialUp((evtData: DialUpData<unknown>) => this._triggerAction(evtData.context));
		this.onTouchTap((evtData: TouchTapData<unknown>) => this._triggerAction(evtData.context));
	}

	override async onContextAppear(context: string, { displayIdx }: ContextData<ActionSettings>): Promise<void> {
		$SD.setFeedbackLayout(context, 'actions/dialLayout/layout.json');
		clearInterval(this._pollTimers.get(context));
		this._pollTimers.set(context, setInterval(() => this._poll(context), POLL_MS));
		await this._poll(context, displayIdx);
	}

	override async onContextDisappear(context: string): Promise<void> {
		clearInterval(this._pollTimers.get(context));
		this._pollTimers.delete(context);
		this._statusCache.delete(context);
		this._lastRotateAt.delete(context);
	}

	override async onContextSettingsUpdated(context: string, { displayIdx }: ContextData<ActionSettings>): Promise<void> {
		await this._poll(context, displayIdx);
	}

	override async onSocketConnected(socketIdx: number): Promise<void> {
		for (const [context, { displayIdx }] of this.contexts) {
			if (displayIdx === socketIdx) await this._poll(context, displayIdx);
		}
	}

	override async onSocketDisconnected(socketIdx: number): Promise<void> {
		for (const [context, { displayIdx }] of this.contexts) {
			if (displayIdx === socketIdx) await this._poll(context, displayIdx);
		}
	}

	override async onPropertyInspectorReady({ context, action }: { context: string; action: string; }): Promise<void> {
		const inputsLists = await getInputsLists() as Input[][];
		const payload = {
			event: 'InputListLoaded',
			inputsLists: inputsLists.map((list) => list.filter((i) => i.unversionedInputKind === 'ffmpeg_source')),
		};
		$SD.sendToPropertyInspector(context, payload, action);
	}

	private async _triggerAction(context: string): Promise<void> {
		if (!this.contexts.has(context)) return;
		const { settings, displayIdx } = this.contexts.get(context)!;
		this._warnIfDisconnected(context, settings);

		await Promise.allSettled(settings.map(async (socketSettings, socketIdx) => {
			if (!socketSettings?.inputName || !sockets[socketIdx].isConnected) return;
			let playbackState: PlaybackState = 'inactive';
			try {
				const { mediaState } = await sockets[socketIdx].call('GetMediaInputStatus', { inputName: socketSettings.inputName });
				playbackState = mapMediaState(mediaState);
			}
			catch { /* assume inactive */ }

			let mediaAction = 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_NONE';
			if (socketSettings.action === 'stop') {
				mediaAction = 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_STOP';
			}
			else if (socketSettings.action === 'restart') {
				mediaAction = 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_RESTART';
			}
			else if (socketSettings.action === 'play_pause') {
				mediaAction = playbackState === 'active' ? 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_PAUSE' : playbackState === 'intermediate' ? 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_PLAY' : 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_RESTART';
			}
			else {
				mediaAction = playbackState === 'active' ? 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_STOP' : playbackState === 'intermediate' ? 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_PLAY' : 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_RESTART';
			}
			await sockets[socketIdx].call('TriggerMediaInputAction', { inputName: socketSettings.inputName, mediaAction });
		}));

		await this._poll(context, displayIdx);
	}

	private async _poll(context: string, displayIdx?: number): Promise<void> {
		if (!this.contexts.has(context)) return;
		const { settings, displayIdx: contextDisplayIdx } = this.contexts.get(context)!;
		const idx = displayIdx ?? contextDisplayIdx;
		const socketSettings = settings[idx];

		if (!socketSettings?.inputName || !sockets[idx].isConnected) {
			this._statusCache.set(context, undefined);
			this._renderFeedback(context, idx);
			return;
		}

		const rotatedAtStart = this._lastRotateAt.get(context) ?? 0;
		const isStale = () => this._lastRotateAt.get(context) !== rotatedAtStart || Date.now() - rotatedAtStart < ROTATE_SETTLE_MS;
		try {
			const { mediaState, mediaDuration, mediaCursor } = await sockets[idx].call('GetMediaInputStatus', { inputName: socketSettings.inputName });
			if (isStale()) return;
			this._statusCache.set(context, { mediaState, mediaDuration: mediaDuration ?? 0, mediaCursor: mediaCursor ?? 0 });
		}
		catch {
			if (isStale()) return;
			this._statusCache.set(context, undefined);
		}
		this._renderFeedback(context, idx);
	}

	private _renderFeedback(context: string, displayIdx: number): void {
		if (!this.contexts.has(context)) return;
		const { settings } = this.contexts.get(context)!;
		const socketSettings = settings[displayIdx];
		const cache = this._statusCache.get(context);

		if (!socketSettings?.inputName || !cache) {
			$SD.setFeedback(context, this._dimFeedback({ status: '', title: ' ', value: '', indicator: 0 }, displayIdx));
			return;
		}
		const percent = cache.mediaDuration ? Math.round(Math.min(100, Math.max(0, (cache.mediaCursor / cache.mediaDuration) * 100))) : 0;
		$SD.setFeedback(context, this._dimFeedback({
			status: STATUS_LABELS[cache.mediaState] ?? '',
			title: socketSettings.inputName,
			value: `${formatTime(cache.mediaCursor)} / ${formatTime(cache.mediaDuration)}`,
			indicator: percent,
		}, displayIdx));
	}
}
