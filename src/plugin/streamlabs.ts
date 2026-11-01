import { OBSWebSocketError, RequestBatchOptions, RequestBatchRequest } from 'obs-websocket-js';

/**
 * Bridge to the Streamlabs Desktop remote control API (JSON-RPC over WebSocket, see
 * https://streamlabs.github.io/streamlabs-desktop-api-docs/docs/index.html).
 * It translates the subset of OBS WebSocket requests/events used by the actions, so they work unchanged
 * against Streamlabs Desktop. Anything without a Streamlabs equivalent rejects with an "unsupported" error.
 */

const RPC_TIMEOUT_MS = 5000;
const FRAME_MS = 1000 / 60;

// OBS WebSocket request status codes used in the emulated errors
const enum Code {
	MissingRequestField = 300,
	InvalidRequestField = 400,
	OutputRunning = 500,
	OutputNotRunning = 501,
	StudioModeNotActive = 506,
	ResourceNotFound = 600,
	UnknownRequestType = 204,
}

const OUTPUT = {
	starting: 'OBS_WEBSOCKET_OUTPUT_STARTING',
	started: 'OBS_WEBSOCKET_OUTPUT_STARTED',
	stopping: 'OBS_WEBSOCKET_OUTPUT_STOPPING',
	stopped: 'OBS_WEBSOCKET_OUTPUT_STOPPED',
	reconnecting: 'OBS_WEBSOCKET_OUTPUT_RECONNECTING',
	reconnected: 'OBS_WEBSOCKET_OUTPUT_RECONNECTED',
};

const MONITORING_TYPES = ['OBS_MONITORING_TYPE_NONE', 'OBS_MONITORING_TYPE_MONITOR_ONLY', 'OBS_MONITORING_TYPE_MONITOR_AND_OUTPUT'];

// Streamlabs events subscribed on connect: [resource, event]
const SUBSCRIPTIONS: [string, string][] = [
	['ScenesService', 'sceneSwitched'],
	['ScenesService', 'sceneAdded'],
	['ScenesService', 'sceneRemoved'],
	['ScenesService', 'itemUpdated'],
	['SourcesService', 'sourceUpdated'],
	['StreamingService', 'streamingStatusChange'],
	['StreamingService', 'recordingStatusChange'],
	['StreamingService', 'replayBufferStatusChange'],
	['TransitionsService', 'studioModeChanged'],
	['SceneCollectionsService', 'collectionWillSwitch'],
	['SceneCollectionsService', 'collectionSwitched'],
];

type SlobsScene = { id: string, name: string, resourceId?: string };
type SlobsSceneItem = { sceneItemId: string, sourceId: string, name: string, visible: boolean, resourceId: string };
type SlobsSource = { sourceId: string, name: string, type: string, muted: boolean, audio: boolean };
type SlobsStreamingModel = { streamingStatus: string, streamingStatusTime: string, recordingStatus: string, recordingStatusTime: string, replayBufferStatus: string };
type Pending = { resolve: (value: any) => void, reject: (reason: Error) => void };

/** IEC 60-268-18 fader curve used by Streamlabs Desktop (port of libobs iec_db_to_def) */
function dbToDeflection(db: number): number {
	if (db >= 0) return 1;
	if (!Number.isFinite(db)) return 0;
	if (db >= -9) return (db + 9) / 9 * 0.25 + 0.75;
	if (db >= -20) return (db + 20) / 11 * 0.15 + 0.6;
	if (db >= -30) return (db + 30) / 10 * 0.15 + 0.45;
	if (db >= -40) return (db + 40) / 10 * 0.15 + 0.3;
	if (db >= -50) return (db + 50) / 10 * 0.15 + 0.15;
	if (db >= -60) return (db + 60) / 10 * 0.075 + 0.075;
	if (db >= -114) return (db + 150) / 90 * 0.075;
	return 0;
}

function sinceMs(isoTime: string | undefined): number {
	const t = isoTime ? Date.parse(isoTime) : NaN;
	return Number.isFinite(t) ? Math.max(Date.now() - t, 0) : 0;
}

function timecode(ms: number): string {
	const pad = (n: number, len = 2) => String(Math.floor(n)).padStart(len, '0');
	return `${pad(ms / 3600000)}:${pad(ms / 60000 % 60)}:${pad(ms / 1000 % 60)}.${pad(ms % 1000, 3)}`;
}

function fail(code: number, message: string): never {
	throw new OBSWebSocketError(code, message);
}

export class StreamlabsConnection {
	private _ws: WebSocket | undefined;
	private _nextId = 1;
	private _pending = new Map<number, Pending>();
	private _promises = new Map<string, Pending>();

	private _studioMode = false;
	private _programSceneId: string | undefined;
	private _sceneNames = new Map<string, string>();	// <sceneId, sceneName>
	private _itemVisible = new Map<string, boolean>();	// <sceneItemId, visible>
	private _sourceMuted = new Map<string, boolean>();	// <sourceId, muted>
	private _streamingStatus = 'offline';
	private _replayBufferStatus = 'offline';
	private _outputBytes = 0;
	private _outputBytesAt = 0;

	/**
	 * @param _emit Emits an (OBS WebSocket shaped) event on the owning socket
	 */
	constructor(private readonly _emit: (event: string, data?: unknown) => void) {}

	get isOpen() {
		return !!this._ws;
	}

	/**
	 * Open the WebSocket, authenticate with the remote control token and subscribe to events.
	 * Emits ConnectionOpened, then Identified once ready; ConnectionClosed whenever the socket closes
	 */
	connect(url: string, token?: string): Promise<void> {
		if (this._ws) return Promise.reject(new OBSWebSocketError(-1, 'Already connected'));
		return new Promise<void>((resolve, reject) => {
			const ws = new WebSocket(url);
			this._ws = ws;
			let identified = false;

			ws.onopen = async () => {
				this._emit('ConnectionOpened');
				try {
					if (token) await this._rpc('auth', 'TcpServerService', [token]);
					await this._initialize();
					identified = true;
					this._emit('Identified', {});
					resolve();
				}
				catch (e) {
					const message = e instanceof Error ? e.message : 'Authentication failed';
					reject(new OBSWebSocketError(4009, message));
					ws.close(4009, message.slice(0, 120));
				}
			};
			ws.onmessage = (e) => this._onMessage(e.data);
			ws.onclose = (e) => {
				if (this._ws === ws) this._cleanup();
				const error = new OBSWebSocketError(e.code, e.reason);
				if (!identified) reject(error);
				this._emit('ConnectionClosed', error);
			};
		});
	}

	async disconnect(): Promise<void> {
		this._ws?.close();
	}

	private _cleanup() {
		this._ws = undefined;
		const error = new OBSWebSocketError(-1, 'Connection closed');
		this._pending.forEach(({ reject }) => reject(error));
		this._promises.forEach(({ reject }) => reject(error));
		this._pending.clear();
		this._promises.clear();
		this._sceneNames.clear();
		this._itemVisible.clear();
		this._sourceMuted.clear();
	}

	// -- JSON-RPC
	private _rpc<T = any>(method: string, resource: string, args: unknown[] = []): Promise<T> {
		const ws = this._ws;
		if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.reject(new OBSWebSocketError(-1, 'Not connected to Streamlabs Desktop'));
		const id = this._nextId++;
		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => {
				this._pending.delete(id);
				reject(new OBSWebSocketError(-1, `Streamlabs request ${resource}.${method} timed out`));
			}, RPC_TIMEOUT_MS);
			this._pending.set(id, {
				resolve: (value) => { clearTimeout(timer); resolve(value); },
				reject: (reason) => { clearTimeout(timer); reject(reason); },
			});
			ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params: { resource, args } }));
		});
	}

	private _onMessage(raw: unknown) {
		let message;
		try {
			message = JSON.parse(String(raw));
		}
		catch {
			return;
		}
		const { id, result, error } = message;

		if (result?._type === 'EVENT') {
			if (result.emitter === 'PROMISE') {
				const pending = this._promises.get(result.resourceId);
				if (!pending) return;
				this._promises.delete(result.resourceId);
				if (result.isRejected) pending.reject(new OBSWebSocketError(-1, typeof result.data === 'string' ? result.data : result.data?.message ?? 'Streamlabs request failed'));
				else pending.resolve(result.data);
			}
			else {
				try {
					this._onEvent(result.resourceId, result.data);
				}
				catch (e) {
					console.error(`Error handling Streamlabs event ${result.resourceId}: ${e}`);
				}
			}
			return;
		}

		const pending = this._pending.get(id);
		if (!pending) return;
		this._pending.delete(id);
		if (error) {
			pending.reject(new OBSWebSocketError(error.code ?? -1, error.message ?? 'Streamlabs request failed'));
		}
		else if (result?._type === 'SUBSCRIPTION' && result.emitter === 'PROMISE') {
			// Async method: the result arrives later as a PROMISE event
			this._promises.set(result.resourceId, pending);
		}
		else {
			pending.resolve(result);
		}
	}
	// --

	// -- State/cache helpers
	private async _initialize() {
		const [transitions, streaming, activeSceneId] = await Promise.all([
			this._rpc<{ studioMode: boolean }>('getModel', 'TransitionsService'),
			this._rpc<SlobsStreamingModel>('getModel', 'StreamingService'),
			this._rpc<string>('activeSceneId', 'ScenesService'),
			this._getScenes(),
		]);
		this._studioMode = !!transitions?.studioMode;
		this._programSceneId = activeSceneId;
		this._streamingStatus = streaming.streamingStatus;
		this._replayBufferStatus = streaming.replayBufferStatus;
		this._outputBytes = 0;
		this._outputBytesAt = 0;
		// Subscriptions are best effort - older Streamlabs versions may lack some events
		await Promise.allSettled(SUBSCRIPTIONS.map(([resource, event]) => this._rpc(event, resource)));
	}

	private async _getScenes(): Promise<SlobsScene[]> {
		const scenes = await this._rpc<SlobsScene[]>('getScenes', 'ScenesService');
		this._sceneNames = new Map(scenes.map(s => [s.id, s.name]));
		return scenes;
	}

	private async _getSceneByName(sceneName: unknown): Promise<SlobsScene> {
		if (!sceneName) fail(Code.MissingRequestField, 'Your request is missing the sceneName field');
		const scene = (await this._getScenes()).find(s => s.name === sceneName);
		if (!scene) fail(Code.ResourceNotFound, `No source was found by the name of \`${sceneName}\`.`);
		return scene;
	}

	private async _getActiveScene(): Promise<SlobsScene> {
		const activeSceneId = await this._rpc<string>('activeSceneId', 'ScenesService');
		const scenes = await this._getScenes();
		return scenes.find(s => s.id === activeSceneId) ?? { id: activeSceneId, name: '' };
	}

	private _programSceneName(fallback: SlobsScene): string {
		return (this._studioMode && this._programSceneId && this._sceneNames.get(this._programSceneId)) || fallback.name;
	}

	private async _getSceneItems(scene: SlobsScene): Promise<SlobsSceneItem[]> {
		return this._rpc<SlobsSceneItem[]>('getItems', scene.resourceId ?? `Scene${JSON.stringify([scene.id])}`);
	}

	private async _getSceneItem(sceneName: unknown, match: { sourceName?: unknown, sceneItemId?: unknown }): Promise<SlobsSceneItem> {
		const scene = await this._getSceneByName(sceneName);
		const items = await this._getSceneItems(scene);
		const item = match.sceneItemId !== undefined
			? items.find(i => i.sceneItemId === match.sceneItemId)
			: items.find(i => i.name === match.sourceName);
		if (!item) fail(Code.ResourceNotFound, `No scene items were found in scene \`${sceneName}\` matching the request.`);
		return item;
	}

	private async _getSourceByName(name: unknown, audioOnly = false): Promise<SlobsSource> {
		if (!name) fail(Code.MissingRequestField, 'Your request is missing the inputName field');
		const sources = await this._rpc<SlobsSource[]>('getSourcesByName', 'SourcesService', [name]);
		const source = (audioOnly ? sources.find(s => s.audio) : undefined) ?? sources[0];
		if (!source) fail(Code.ResourceNotFound, `No source was found by the name of \`${name}\`.`);
		return source;
	}

	private _audioResource(sourceId: string) {
		return `AudioSource${JSON.stringify([sourceId])}`;
	}

	private async _getStreamingModel(): Promise<SlobsStreamingModel> {
		return this._rpc<SlobsStreamingModel>('getModel', 'StreamingService');
	}

	private _sceneListResponse(scenes: SlobsScene[], programName: string, previewName: string | null) {
		// OBS lists scenes bottom-up (the last array entry is the top scene in the UI)
		return {
			currentProgramSceneName: programName,
			currentProgramSceneUuid: '',
			currentPreviewSceneName: previewName,
			currentPreviewSceneUuid: null,
			scenes: [...scenes].reverse().map((s, i) => ({ sceneIndex: i, sceneName: s.name, sceneUuid: s.id })),
		};
	}
	// --

	// -- Events
	private _onEvent(resourceId: string, data: any) {
		switch (resourceId) {
			case 'ScenesService.sceneSwitched': {
				this._sceneNames.set(data.id, data.name);
				if (this._studioMode) {
					this._emit('CurrentPreviewSceneChanged', { sceneName: data.name, sceneUuid: data.id });
				}
				else {
					this._programSceneId = data.id;
					this._emit('CurrentProgramSceneChanged', { sceneName: data.name, sceneUuid: data.id });
				}
				break;
			}
			case 'ScenesService.sceneAdded':
			case 'ScenesService.sceneRemoved':
				this._emitSceneList();
				break;
			case 'ScenesService.itemUpdated': {
				if (this._itemVisible.get(data.sceneItemId) === data.visible) break;
				this._itemVisible.set(data.sceneItemId, data.visible);
				this._emit('SceneItemEnableStateChanged', { sceneName: this._sceneNames.get(data.sceneId) ?? '', sceneUuid: data.sceneId, sceneItemId: data.sceneItemId, sceneItemEnabled: data.visible });
				break;
			}
			case 'SourcesService.sourceUpdated': {
				if (this._sourceMuted.get(data.sourceId) === data.muted) break;
				this._sourceMuted.set(data.sourceId, data.muted);
				this._emit('InputMuteStateChanged', { inputName: data.name, inputUuid: data.sourceId, inputMuted: data.muted });
				break;
			}
			case 'StreamingService.streamingStatusChange': {
				const previous = this._streamingStatus;
				this._streamingStatus = data;
				const outputState = data === 'live' ? (previous === 'reconnecting' ? OUTPUT.reconnected : OUTPUT.started)
					: data === 'starting' ? OUTPUT.starting
						: data === 'reconnecting' ? OUTPUT.reconnecting
							: data === 'ending' ? OUTPUT.stopping
								: OUTPUT.stopped;
				if (data === 'starting' || data === 'offline') this._outputBytes = 0;
				this._emit('StreamStateChanged', { outputActive: data === 'live' || data === 'reconnecting', outputState });
				break;
			}
			case 'StreamingService.recordingStatusChange': {
				const outputState = data === 'recording' ? OUTPUT.started
					: data === 'starting' ? OUTPUT.starting
						: data === 'stopping' ? OUTPUT.stopping
							: OUTPUT.stopped;
				this._emit('RecordStateChanged', { outputActive: data === 'recording', outputState, outputPath: null });
				break;
			}
			case 'StreamingService.replayBufferStatusChange': {
				const previous = this._replayBufferStatus;
				this._replayBufferStatus = data;
				if (data === 'saving') break;
				if (previous === 'saving' && data === 'running') {
					this._emit('ReplayBufferSaved', { savedReplayPath: '' });
					break;
				}
				const outputState = data === 'running' ? OUTPUT.started : data === 'stopping' ? OUTPUT.stopping : OUTPUT.stopped;
				this._emit('ReplayBufferStateChanged', { outputActive: data === 'running', outputState });
				break;
			}
			case 'TransitionsService.studioModeChanged': {
				this._studioMode = !!data;
				// Leaving studio mode keeps the edited (preview) scene live
				if (!this._studioMode) this._refreshProgramScene();
				this._emit('StudioModeStateChanged', { studioModeEnabled: this._studioMode });
				break;
			}
			case 'SceneCollectionsService.collectionWillSwitch':
				this._emit('CurrentSceneCollectionChanging', { sceneCollectionName: '' });
				break;
			case 'SceneCollectionsService.collectionSwitched': {
				this._itemVisible.clear();
				this._sourceMuted.clear();
				this._refreshProgramScene();
				this._emit('CurrentSceneCollectionChanged', { sceneCollectionName: data?.name ?? '' });
				this._emitSceneList();
				break;
			}
		}
	}

	private _refreshProgramScene() {
		this._rpc<string>('activeSceneId', 'ScenesService')
		.then(id => this._programSceneId = id)
		.catch(() => { /* Not connected */ });
	}

	private _emitSceneList() {
		this._getScenes()
		.then(scenes => this._emit('SceneListChanged', { scenes: this._sceneListResponse(scenes, '', null).scenes }))
		.catch(() => { /* Not connected */ });
	}
	// --

	// -- Requests
	async callBatch(requests: RequestBatchRequest[], options?: RequestBatchOptions) {
		const variables: Record<string, unknown> = {};
		const results = [];
		for (const request of requests as (RequestBatchRequest & { requestData?: Record<string, unknown>, inputVariables?: Record<string, string>, outputVariables?: Record<string, string> })[]) {
			const requestData: Record<string, unknown> = { ...request.requestData };
			Object.entries(request.inputVariables ?? {}).forEach(([field, variable]) => { requestData[field] = variables[variable]; });
			try {
				const responseData = await this.call(request.requestType, requestData) as Record<string, unknown> | undefined;
				Object.entries(request.outputVariables ?? {}).forEach(([variable, field]) => { variables[variable] = responseData?.[field]; });
				results.push({ requestType: request.requestType, requestId: request.requestId ?? '', requestStatus: { result: true, code: 100 }, responseData });
			}
			catch (e) {
				const code = e instanceof OBSWebSocketError ? e.code : -1;
				const comment = e instanceof Error ? e.message : 'Unknown error';
				results.push({ requestType: request.requestType, requestId: request.requestId ?? '', requestStatus: { result: false, code, comment } });
				if (options?.haltOnFailure) break;
			}
		}
		return results;
	}

	async call(requestType: string, data: Record<string, any> = {}): Promise<any> {
		switch (requestType) {
			case 'GetVersion':
				return { obsVersion: 'Streamlabs Desktop', obsWebSocketVersion: '', rpcVersion: 1, availableRequests: [], supportedImageFormats: [], platform: '', platformDescription: '' };

			case 'Sleep':
				await new Promise(resolve => setTimeout(resolve, Number(data.sleepMillis) || Number(data.sleepFrames) * FRAME_MS || 0));
				return;

			// -- Scenes
			case 'GetSceneList': {
				const active = await this._getActiveScene();
				const scenes = await this._getScenes();
				return this._sceneListResponse(scenes, this._programSceneName(active), this._studioMode ? active.name : null);
			}
			case 'GetCurrentProgramScene': {
				const active = await this._getActiveScene();
				const sceneName = this._programSceneName(active);
				return { sceneName, sceneUuid: '', currentProgramSceneName: sceneName, currentProgramSceneUuid: '' };
			}
			case 'SetCurrentProgramScene': {
				const scene = await this._getSceneByName(data.sceneName);
				await this._rpc('makeSceneActive', 'ScenesService', [scene.id]);
				if (this._studioMode) await this._transition();
				return;
			}
			case 'GetCurrentPreviewScene': {
				if (!this._studioMode) fail(Code.StudioModeNotActive, 'Studio mode is not active.');
				const active = await this._getActiveScene();
				return { sceneName: active.name, sceneUuid: active.id, currentPreviewSceneName: active.name, currentPreviewSceneUuid: active.id };
			}
			case 'SetCurrentPreviewScene': {
				if (!this._studioMode) fail(Code.StudioModeNotActive, 'Studio mode is not active.');
				const scene = await this._getSceneByName(data.sceneName);
				await this._rpc('makeSceneActive', 'ScenesService', [scene.id]);
				return;
			}
			case 'GetGroupList':
				return { groups: [] };

			// -- Studio mode
			case 'GetStudioModeEnabled':
				return { studioModeEnabled: this._studioMode };
			case 'SetStudioModeEnabled':
				await this._rpc(data.studioModeEnabled ? 'enableStudioMode' : 'disableStudioMode', 'TransitionsService');
				return;
			case 'TriggerStudioModeTransition':
				if (!this._studioMode) fail(Code.StudioModeNotActive, 'Studio mode is not active.');
				await this._transition();
				return;

			// -- Scene items
			case 'GetSceneItemList': {
				const scene = await this._getSceneByName(data.sceneName);
				const items = await this._getSceneItems(scene);
				return {
					sceneItems: items.map((item, i) => ({ sceneItemId: item.sceneItemId, sceneItemIndex: i, sourceName: item.name, sourceUuid: item.sourceId, sceneItemEnabled: item.visible, isGroup: false })),
				};
			}
			case 'GetGroupSceneItemList':
				return { sceneItems: [] };
			case 'GetSceneItemId': {
				const item = await this._getSceneItem(data.sceneName, { sourceName: data.sourceName });
				return { sceneItemId: item.sceneItemId };
			}
			case 'GetSceneItemEnabled': {
				const item = await this._getSceneItem(data.sceneName, { sceneItemId: data.sceneItemId });
				this._itemVisible.set(item.sceneItemId, item.visible);
				return { sceneItemEnabled: item.visible };
			}
			case 'SetSceneItemEnabled': {
				const item = await this._getSceneItem(data.sceneName, { sceneItemId: data.sceneItemId });
				await this._rpc('setVisibility', item.resourceId, [!!data.sceneItemEnabled]);
				return;
			}

			// -- Inputs/audio
			case 'GetInputList': {
				const sources = await this._rpc<SlobsSource[]>('getSources', 'SourcesService');
				return {
					inputs: sources
					.filter(s => s.type !== 'scene' && (!data.inputKind || s.type === data.inputKind))
					.map(s => ({ inputName: s.name, inputUuid: s.sourceId, inputKind: s.type, unversionedInputKind: s.type })),
				};
			}
			case 'GetInputMute': {
				const source = await this._getSourceByName(data.inputName, true);
				this._sourceMuted.set(source.sourceId, source.muted);
				return { inputMuted: source.muted };
			}
			case 'SetInputMute': {
				const source = await this._getSourceByName(data.inputName, true);
				await this._rpc('setMuted', this._audioResource(source.sourceId), [!!data.inputMuted]);
				return;
			}
			case 'ToggleInputMute': {
				const source = await this._getSourceByName(data.inputName, true);
				await this._rpc('setMuted', this._audioResource(source.sourceId), [!source.muted]);
				return { inputMuted: !source.muted };
			}
			case 'GetInputVolume': {
				const source = await this._getSourceByName(data.inputName, true);
				const { fader } = await this._rpc<{ fader: { db: number, mul: number } }>('getModel', this._audioResource(source.sourceId));
				return { inputVolumeMul: fader.mul, inputVolumeDb: fader.db };
			}
			case 'SetInputVolume': {
				const source = await this._getSourceByName(data.inputName, true);
				let db: number;
				if (data.inputVolumeDb !== undefined) db = Number(data.inputVolumeDb);
				else if (data.inputVolumeMul !== undefined) db = Number(data.inputVolumeMul) > 0 ? 20 * Math.log10(Number(data.inputVolumeMul)) : -Infinity;
				else fail(Code.MissingRequestField, 'Your request requires either inputVolumeMul or inputVolumeDb.');
				if (Number.isNaN(db)) fail(Code.InvalidRequestField, 'The volume value is invalid.');
				await this._rpc('setDeflection', this._audioResource(source.sourceId), [dbToDeflection(db)]);
				return;
			}
			case 'GetInputAudioMonitorType': {
				const source = await this._getSourceByName(data.inputName, true);
				const { monitoringType } = await this._rpc<{ monitoringType: number }>('getModel', this._audioResource(source.sourceId));
				return { monitorType: MONITORING_TYPES[monitoringType] ?? MONITORING_TYPES[0] };
			}

			// -- Stream
			case 'GetStreamStatus': {
				const model = await this._getStreamingModel();
				const active = model.streamingStatus === 'live' || model.streamingStatus === 'reconnecting';
				const duration = active ? sinceMs(model.streamingStatusTime) : 0;
				const perf = await this._rpc<{ numberDroppedFrames: number, percentageDroppedFrames: number, bandwidth: number }>('getModel', 'PerformanceService').catch(() => undefined);
				// Streamlabs only reports the current bandwidth (kbps), so accumulate it into a byte counter for bitrate calculations
				const now = Date.now();
				if (active && perf && this._outputBytesAt) this._outputBytes += perf.bandwidth * 1000 / 8 * (now - this._outputBytesAt) / 1000;
				this._outputBytesAt = active ? now : 0;
				const dropped = perf?.numberDroppedFrames ?? 0;
				const total = perf?.percentageDroppedFrames ? Math.round(dropped * 100 / perf.percentageDroppedFrames) : 0;
				return {
					outputActive: active,
					outputReconnecting: model.streamingStatus === 'reconnecting',
					outputTimecode: timecode(duration),
					outputDuration: duration,
					outputCongestion: 0,
					outputBytes: Math.round(this._outputBytes),
					outputSkippedFrames: dropped,
					outputTotalFrames: total,
				};
			}
			case 'StartStream': {
				const { streamingStatus } = await this._getStreamingModel();
				if (streamingStatus !== 'offline') fail(Code.OutputRunning, 'The stream output is already running.');
				await this._rpc('toggleStreaming', 'StreamingService');
				return;
			}
			case 'StopStream': {
				const { streamingStatus } = await this._getStreamingModel();
				if (streamingStatus === 'offline' || streamingStatus === 'ending') fail(Code.OutputNotRunning, 'The stream output is not running.');
				await this._rpc('toggleStreaming', 'StreamingService');
				return;
			}
			case 'ToggleStream': {
				const { streamingStatus } = await this._getStreamingModel();
				await this._rpc('toggleStreaming', 'StreamingService');
				return { outputActive: streamingStatus === 'offline' };
			}

			// -- Record
			case 'GetRecordStatus': {
				const model = await this._getStreamingModel();
				const active = model.recordingStatus === 'recording';
				const duration = active ? sinceMs(model.recordingStatusTime) : 0;
				return { outputActive: active, outputPaused: false, outputTimecode: timecode(duration), outputDuration: duration, outputBytes: 0 };
			}
			case 'StartRecord': {
				const { recordingStatus } = await this._getStreamingModel();
				if (recordingStatus !== 'offline') fail(Code.OutputRunning, 'The record output is already running.');
				await this._rpc('toggleRecording', 'StreamingService');
				return;
			}
			case 'StopRecord': {
				const { recordingStatus } = await this._getStreamingModel();
				if (recordingStatus === 'offline' || recordingStatus === 'stopping') fail(Code.OutputNotRunning, 'The record output is not running.');
				await this._rpc('toggleRecording', 'StreamingService');
				return { outputPath: '' };
			}
			case 'ToggleRecord': {
				const { recordingStatus } = await this._getStreamingModel();
				await this._rpc('toggleRecording', 'StreamingService');
				return { outputActive: recordingStatus === 'offline' };
			}

			// -- Replay buffer
			case 'GetReplayBufferStatus': {
				const { replayBufferStatus } = await this._getStreamingModel();
				return { outputActive: replayBufferStatus === 'running' || replayBufferStatus === 'saving' };
			}
			case 'StartReplayBuffer': {
				const { replayBufferStatus } = await this._getStreamingModel();
				if (replayBufferStatus !== 'offline') fail(Code.OutputRunning, 'The replay buffer output is already running.');
				await this._rpc('startReplayBuffer', 'StreamingService');
				return;
			}
			case 'StopReplayBuffer': {
				const { replayBufferStatus } = await this._getStreamingModel();
				if (replayBufferStatus === 'offline') fail(Code.OutputNotRunning, 'The replay buffer output is not running.');
				await this._rpc('stopReplayBuffer', 'StreamingService');
				return;
			}
			case 'ToggleReplayBuffer': {
				const { replayBufferStatus } = await this._getStreamingModel();
				const active = replayBufferStatus !== 'offline';
				await this._rpc(active ? 'stopReplayBuffer' : 'startReplayBuffer', 'StreamingService');
				return { outputActive: !active };
			}
			case 'SaveReplayBuffer': {
				const { replayBufferStatus } = await this._getStreamingModel();
				if (replayBufferStatus !== 'running') fail(Code.OutputNotRunning, 'The replay buffer output is not running.');
				await this._rpc('saveReplay', 'StreamingService');
				return;
			}

			// -- Scene collections
			case 'GetSceneCollectionList': {
				const [collections, active] = await Promise.all([
					this._rpc<{ id: string, name: string }[]>('collections', 'SceneCollectionsService'),
					this._rpc<{ id: string, name: string }>('activeCollection', 'SceneCollectionsService'),
				]);
				return { currentSceneCollectionName: active?.name ?? '', sceneCollections: collections.map(c => c.name) };
			}
			case 'SetCurrentSceneCollection': {
				const collections = await this._rpc<{ id: string, name: string }[]>('collections', 'SceneCollectionsService');
				const collection = collections.find(c => c.name === data.sceneCollectionName);
				if (!collection) fail(Code.ResourceNotFound, 'No scene collection was found by that name.');
				await this._rpc('load', 'SceneCollectionsService', [collection.id]);
				return;
			}

			// -- Stats
			case 'GetStats': {
				const perf = await this._rpc<{ CPU: number, numberDroppedFrames: number, percentageDroppedFrames: number, frameRate: number }>('getModel', 'PerformanceService');
				const total = perf.percentageDroppedFrames ? Math.round(perf.numberDroppedFrames * 100 / perf.percentageDroppedFrames) : 0;
				return {
					cpuUsage: perf.CPU,
					memoryUsage: 0,
					availableDiskSpace: 0,
					activeFps: perf.frameRate,
					averageFrameRenderTime: 0,
					renderSkippedFrames: 0,
					renderTotalFrames: 0,
					outputSkippedFrames: perf.numberDroppedFrames,
					outputTotalFrames: total,
					webSocketSessionIncomingMessages: 0,
					webSocketSessionOutgoingMessages: 0,
				};
			}

			// -- Browser sources
			case 'PressInputPropertiesButton': {
				if (data.propertyName !== 'refreshnocache') break;
				const source = await this._getSourceByName(data.inputName);
				await this._rpc('refresh', `Source${JSON.stringify([source.sourceId])}`);
				return;
			}
		}
		return fail(Code.UnknownRequestType, `${requestType} is not supported by Streamlabs Desktop`);
	}

	private async _transition() {
		this._emit('SceneTransitionStarted', { transitionName: '', transitionUuid: '' });
		await this._rpc('executeStudioModeTransition', 'TransitionsService');
		// The preview scene is now live
		const active = await this._getActiveScene().catch(() => undefined);
		if (active) {
			this._programSceneId = active.id;
			this._emit('CurrentProgramSceneChanged', { sceneName: active.name, sceneUuid: active.id });
		}
		this._emit('SceneTransitionEnded', { transitionName: '', transitionUuid: '' });
	}
	// --
}
