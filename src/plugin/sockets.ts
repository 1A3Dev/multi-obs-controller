import OBSWebSocket, { OBSRequestTypes, OBSResponseTypes, RequestBatchOptions, RequestBatchRequest } from 'obs-websocket-js';
import { MAX_SERVERS } from '../shared/constants';
import { StreamlabsConnection } from './streamlabs';
import { SDUtils } from './utils';

const CONNECT_TIMEOUT_MS = 5000;
const DEFAULT_RETRY_INTERVAL_S = 10;
const MIN_RETRY_INTERVAL_S = 2;
const MAX_RETRY_INTERVAL_S = 30;

class Socket extends OBSWebSocket {
	_ip;
	_port;
	_password;
	_secure;
	_software: Software;
	_isConnected = false;
	private _pendingConnect: Promise<void> | undefined;
	private _retryIntervalMs = DEFAULT_RETRY_INTERVAL_S * 1000;
	private _nextAttemptAt = 0;
	// Emulated events are OBS WS shaped, but not all of them are typed (e.g. ConnectionClosed with a plain error)
	private _streamlabs = new StreamlabsConnection((event, data) => (this.emit as (...args: unknown[]) => boolean).call(this, event, data));

	constructor(ip?: string, port?: string | number, password?: string, secure?: boolean, software: Software = 'obs') {
		super();
		this._ip = ip;
		this._port = port;
		this._password = password;
		this._secure = secure;
		this._software = software;

		this.on('ConnectionOpened', () => SDUtils.logDebug(`WS initial connection opened to server at ${this._ip}:${this._port}`));
		this.on('Hello', (data) => SDUtils.logDebug(`WS server at ${this._ip}:${this._port} sent Hello message - OBS WS Version: ${data.obsWebSocketVersion} | RPC Version: ${data.rpcVersion}`));

		this.on('Identified', () => {
			this._isConnected = true;
			this._nextAttemptAt = 0;
			const logStr = `[CONNECTED] ${this._serverLabel} at ${this._ip}:${this._port}`;
			SDUtils.logDebug(`Identified to WS server at ${this._ip}:${this._port}`);
			SDUtils.log(logStr);
		});

		this.on('ConnectionClosed', (e) => {
			if (!e.message) {
				SDUtils.logDebug(`WS server at ${this._ip}:${this._port} unreachable/closed connection (${e.code})`);
			}
			else {
				SDUtils.logDebug(`WS server at ${this._ip}:${this._port} closed connection: ${e.message} (${e.code})`);
			}

			if (this._isConnected) {
				const logStr = `[DISCONNECTED] ${this._serverLabel} at ${this._ip}:${this._port}`;
				SDUtils.log(logStr);
				this._isConnected = false;
				// @ts-expect-error Disconnected event is custom, not part of the OBS WS protocol
				this.emit('Disconnected');	// custom event for internal purposes
			}
			else {
				this._isConnected = false;
			}
		});
	}

	get isConnected() {
		return this._isConnected;
	}

	get _url() {
		return `${this._secure ? 'wss' : 'ws'}://${this._ip}:${this._port}${this._software === 'streamlabs' ? '/api/websocket' : ''}`;
	}

	get _serverLabel() {
		return this._software === 'streamlabs' ? 'Streamlabs Desktop server' : 'OBS Websocket server';
	}

	// -- Streamlabs Desktop servers go through the emulation bridge instead of the OBS WS protocol
	override async connect(url?: string, password?: string, identificationParams?: Parameters<OBSWebSocket['connect']>[2]) {
		if (this._software !== 'streamlabs') return super.connect(url, password, identificationParams);
		await this._streamlabs.connect(url ?? this._url, password);
		return { obsWebSocketVersion: '', rpcVersion: 1, negotiatedRpcVersion: 1 };
	}

	override async disconnect() {
		if (this._streamlabs.isOpen) await this._streamlabs.disconnect();
		return super.disconnect();
	}

	override async call<Type extends keyof OBSRequestTypes>(requestType: Type, requestData?: OBSRequestTypes[Type]): Promise<OBSResponseTypes[Type]> {
		if (this._software !== 'streamlabs') return super.call(requestType, requestData);
		return this._streamlabs.call(requestType, requestData as Record<string, unknown>);
	}

	override async callBatch(requests: RequestBatchRequest[], options?: RequestBatchOptions) {
		if (this._software !== 'streamlabs') return super.callBatch(requests, options);
		return this._streamlabs.callBatch(requests, options) as ReturnType<OBSWebSocket['callBatch']>;
	}
	// --

	/**
	 * Connect WS, if not already connected, if valid ip/port and if the retry interval since the last failed attempt has elapsed
	 */
	tryConnect() {
		if (this._isConnected || this._pendingConnect || !this._ip || !this._port) return;
		if (Date.now() < this._nextAttemptAt) return;
		this._attemptConnect();
	}

	/**
	 * Connect and schedule the next retry on failure
	 */
	private _attemptConnect() {
		this._pendingConnect = this._connectWithTimeout()
		.catch(() => {
			// Error while connecting - logs on socket events
			this._nextAttemptAt = Date.now() + this._retryIntervalMs;
		})
		.finally(() => { this._pendingConnect = undefined; });
	}

	/**
	 * Set how often this server is retried while disconnected, clamped to 5-30s (defaults to 10s if invalid)
	 */
	setRetryInterval(seconds: string | number | undefined) {
		const parsed = Number(seconds);
		const s = Number.isFinite(parsed) && parsed > 0 ? Math.min(Math.max(parsed, MIN_RETRY_INTERVAL_S), MAX_RETRY_INTERVAL_S) : DEFAULT_RETRY_INTERVAL_S;
		this._retryIntervalMs = s * 1000;
		// Apply a shorter interval to the pending wait right away
		if (this._nextAttemptAt) this._nextAttemptAt = Math.min(this._nextAttemptAt, Date.now() + this._retryIntervalMs);
	}

	private async _connectWithTimeout() {
		const timer = setTimeout(() => { this.disconnect().catch(() => { /* Error while disconnecting */ }); }, CONNECT_TIMEOUT_MS);
		try {
			await this.connect(this._url, this._password);
		}
		finally {
			clearTimeout(timer);
		}
	}

	/**
	 * Force Reconnect WS
	 */
	async tryReconnect() {
		await this.disconnect().catch(() => { /* Error while disconnecting */ });
		await this._pendingConnect;	// let an aborted in-flight attempt settle, so its failure doesn't delay this one
		this._nextAttemptAt = 0;
		this.tryConnect();
	}

	/**
	 * Update ip/port/pwd/secure/software settings, and reconnect if needed
	 * @param {string} ip
	 * @param {string} port
	 * @param {string?} password
	 * @param {boolean} secure
	 * @param {Software} software
	 */
	updateSettings(ip: string, port: string | number, password?: string, secure?: boolean, software: Software = 'obs') {
		if (this._ip !== ip || this._port !== port || this._password !== password || this._secure !== secure || this._software !== software) {
			if (this._software !== software) {
				// Close the connection made with the previous protocol before switching
				this.disconnect().catch(() => { /* Error while disconnecting */ });
				this._software = software;
			}
			this._ip = ip;
			this._port = port;
			this._password = password;
			this._secure = secure;
			if (!this._ip || !this._port) {
				this._nextAttemptAt = 0;
				this.disconnect().catch(() => { /* Error while disconnecting */ });
			}
			else {
				this.tryReconnect().catch(() => { /* Error while reconnecting - logs on socket events */ });
			}
		}
	}
}

export type Software = 'obs' | 'streamlabs';

export const sockets = new Array(MAX_SERVERS).fill(null).map(() => new Socket());
