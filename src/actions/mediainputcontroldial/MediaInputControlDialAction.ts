import { sockets } from '../../plugin/sockets';
import { AbstractStatelessAction } from '../BaseWsAction';
import { getInputsLists } from '../lists';
import { ContextData, DialRotateData, DialUpData, Input, TouchTapData } from '../types';

const DEFAULT_STEP_SEC = 5;
const POLL_MS = 1000; // how often the playback position is re-polled - OBS doesn't push cursor updates as an event
// Grace period after a rotation during which polled positions are distrusted and dropped - OBS applies
// OffsetMediaInputCursor asynchronously on its end (the underlying media backend has to actually seek),
// so a poll landing shortly after the offset request can still report the pre-seek position even though
// it started after the rotation. Without this, that stale read clobbers the correct optimistic value
const ROTATE_SETTLE_MS = 700;

type ActionSettings = { inputName: string, action: 'play_stop' | 'play_pause' | 'restart' | 'stop', step: string };
type MediaStatus = { mediaState: string, mediaDuration: number, mediaCursor: number };
type PlaybackState = 'active' | 'intermediate' | 'inactive';

// Mirrors MediaInputControlAction.fetchState()'s mapping - used here to pick the right action when
// settings.action is 'play_stop'/'play_pause' (which need to know current playback state to decide)
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

// Short status label shown at the top of the dial when playback isn't in its normal "playing" state -
// OBS_MEDIA_STATE_NONE/PLAYING intentionally left out, both render as blank (nothing noteworthy to flag)
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

/**
 * Stream Deck + dial for a media source (video/audio file): rotate skips the playback position forward/
 * backward, push or tap triggers the same configurable play/pause/stop/restart behavior as the regular
 * (non-dial) Media Source Control action.
 *
 * OBS doesn't emit an event for playback position, so - unlike the volume/scene dials - the touch display
 * is kept current by polling GetMediaInputStatus at a fixed interval instead of reacting to a WS event.
 */
export class MediaInputControlDialAction extends AbstractStatelessAction<ActionSettings> {
	// Per-context: last polled status for the currently *displayed* socket only (the touch display only
	// ever shows one target even when this dial's common target is "All")
	private _statusCache = new Map<string, MediaStatus | undefined>();
	private _pollTimers = new Map<string, NodeJS.Timeout>();
	// Timestamp of the last rotate tick, per context - see ROTATE_SETTLE_MS and _poll()
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
				sockets[socketIdx].call('OffsetMediaInputCursor', { inputName: socketSettings.inputName, mediaCursorOffset: payload.ticks * stepMs }).catch(() => { /* ignore - next poll will resync */ });
			});

			// Optimistic local bump of the displayed socket's cursor, for snappy feedback between poll ticks
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

	// Dims the touch display immediately - _poll would otherwise only notice and do this itself on its
	// next tick, up to POLL_MS later
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

	/**
	 * Trigger the settings-configured action (play_stop/play_pause/restart/stop) on every targeted socket,
	 * mirroring MediaInputControlAction.getPayloadFromSettings()'s settings.action branches
	 */
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

	/**
	 * Poll the displayed socket's current media status and refresh the touch display
	 */
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

		// Distrust this poll's result if a rotation happened during the fetch, or happened too recently
		// before it even started for OBS's async seek to have settled yet - see ROTATE_SETTLE_MS
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
