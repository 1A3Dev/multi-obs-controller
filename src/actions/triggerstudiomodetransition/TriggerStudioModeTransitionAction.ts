import { RequestBatchRequest } from 'obs-websocket-js';
import { sockets } from '../../plugin/sockets';
import { SDUtils } from '../../plugin/utils';
import { AbstractStatefulRequestAction } from '../BaseRequestAction';
import { StateEnum } from '../StateEnum';
import { getTransitionsLists } from '../lists';
import { BatchRequestPayload, SocketSettings } from '../types';

type ActionSettings = { transitionName?: string, transitionDuration?: string }
type PreviousTransition = { transitionName: string, transitionFixed: boolean, transitionDuration: number | null }
type TransitionListItem = { transitionName: string, transitionFixed: boolean }

export class TriggerStudioModeTransitionAction extends AbstractStatefulRequestAction<ActionSettings, 'StudioModeStateChanged'> {
	private _status: boolean[] = new Array(sockets.length).fill(false);

	constructor() {
		super('dev.theca11.multiobs.triggerstudiomodetransition', { statusEvent: 'StudioModeStateChanged' });
		this._showSuccess = true; // force showing success icon

		sockets.forEach((socket, socketIdx) => {
			socket.on('StudioModeStateChanged', ({ studioModeEnabled }) => {
				this._status[socketIdx] = studioModeEnabled;
			});
		});
	}

	override async getPayloadFromSettings(socketIdx: number, settings: Record<string, never> | Partial<ActionSettings>): Promise<BatchRequestPayload> {
		const { transitionName } = settings;

		// No transition configured yet (fresh button) - just trigger whatever's already selected in OBS,
		// nothing to override or restore
		if (!transitionName) {
			return { requests: [{ requestType: 'TriggerStudioModeTransition' }] };
		}

		const [previousTransition, transitionList] = await Promise.all([
			sockets[socketIdx].call('GetCurrentSceneTransition'),
			sockets[socketIdx].call('GetSceneTransitionList'),
		]);
		const transitions = transitionList.transitions as unknown as TransitionListItem[];
		const isFixed = transitions.find(t => t.transitionName === transitionName)?.transitionFixed ?? true;

		const transitionDuration = Number(settings.transitionDuration) || 250;
		const requests: RequestBatchRequest[] = [
			{ requestType: 'SetCurrentSceneTransition', requestData: { transitionName } },
		];
		if (!isFixed) {
			requests.push({ requestType: 'SetCurrentSceneTransitionDuration', requestData: { transitionDuration } });
		}
		requests.push({ requestType: 'TriggerStudioModeTransition' });

		// Restore once OBS actually reports the transition as finished (SceneTransitionEnded), rather
		// than guessing how long that takes - a guessed delay was consistently too short (correction
		// wasn't reliably applying even ~1s in)
		this._restoreAfterTransitionEnds(socketIdx, previousTransition);

		return { requests };
	}

	override async onPropertyInspectorReady({ context, action }: { context: string; action: string; }): Promise<void> {
		const transitionsLists = await getTransitionsLists();
		const payload = { event: 'TransitionListLoaded', transitionsLists };
		$SD.sendToPropertyInspector(context, payload, action);
	}

	/**
	 * Waits for OBS's SceneTransitionEnded event (falling back to a timeout if it never arrives) before
	 * restoring the previous transition - see comment above
	 */
	private _restoreAfterTransitionEnds(socketIdx: number, previousTransition: PreviousTransition) {
		const socket = sockets[socketIdx];
		const startedAt = Date.now();
		let done = false;

		const restore = (reason: string) => {
			if (done) return;
			done = true;
			socket.off('SceneTransitionEnded', onEnded);
			SDUtils.logDebug(`[OBS_${socketIdx + 1}][triggerstudiomodetransition] Restoring transition ${Date.now() - startedAt}ms after press (${reason})`);
			this._verifyAndCorrectTransition(socketIdx, previousTransition);
		};

		const onEnded = () => restore('SceneTransitionEnded');
		socket.on('SceneTransitionEnded', onEnded);
		setTimeout(() => restore('fallback timeout, SceneTransitionEnded never arrived'), 1000);
	}

	/**
	 * Applies the restore and confirms (via GetCurrentSceneTransition) that it actually took, retrying a
	 * few times if not
	 */
	private async _verifyAndCorrectTransition(socketIdx: number, previousTransition: PreviousTransition) {
		const socket = sockets[socketIdx];
		const startedAt = Date.now();
		const pollIntervalMs = 200;
		const maxAttempts = 3;

		for (let attempt = 1; attempt <= maxAttempts; attempt++) {
			await socket.call('SetCurrentSceneTransition', { transitionName: previousTransition.transitionName }).catch(() => { /* best effort */ });
			if (!previousTransition.transitionFixed && previousTransition.transitionDuration != null) {
				await socket.call('SetCurrentSceneTransitionDuration', { transitionDuration: previousTransition.transitionDuration }).catch(() => { /* best effort */ });
			}

			let current;
			try {
				current = await socket.call('GetCurrentSceneTransition');
			}
			catch {
				return;
			}

			const durationOk = previousTransition.transitionFixed || previousTransition.transitionDuration == null || current.transitionDuration === previousTransition.transitionDuration;
			if (current.transitionName === previousTransition.transitionName && durationOk) {
				SDUtils.logDebug(`[OBS_${socketIdx + 1}][triggerstudiomodetransition] Restore confirmed ${Date.now() - startedAt}ms after being asked to restore (attempt ${attempt})`);
				return;
			}

			SDUtils.logDebug(`[OBS_${socketIdx + 1}][triggerstudiomodetransition] Restore not applied ${Date.now() - startedAt}ms after being asked to restore (attempt ${attempt}): current=${current.transitionName}/${current.transitionDuration}ms, expected=${previousTransition.transitionName}/${previousTransition.transitionDuration}ms - retrying`);
			await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
		}

		SDUtils.logDebug(`[OBS_${socketIdx + 1}][triggerstudiomodetransition] Gave up restoring transition after ${Date.now() - startedAt}ms and ${maxAttempts} attempts`);
	}

	override async onSocketConnected(socketIdx: number): Promise<void> {
		const { studioModeEnabled } = await sockets[socketIdx].call('GetStudioModeEnabled');
		this._status[socketIdx] = studioModeEnabled;
	}

	override async onSocketDisconnected(socketIdx: number): Promise<void> {
		this._status[socketIdx] = false;
	}

	override async fetchState(socketSettings: NonNullable<SocketSettings<ActionSettings>>, socketIdx: number): Promise<StateEnum.Active | StateEnum.Intermediate | StateEnum.Inactive> {
		return this._status[socketIdx] ? StateEnum.Active : StateEnum.Inactive;
	}

	override async shouldUpdateState(): Promise<boolean> {
		return true;
	}

	override getStateFromEvent(evtData: { studioModeEnabled: boolean; }): StateEnum {
		return evtData.studioModeEnabled ? StateEnum.Active : StateEnum.Inactive;
	}
}
