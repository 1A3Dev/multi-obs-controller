import OBSWebSocket from 'obs-websocket-js';
import { MAX_SERVERS } from '../shared/constants';
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
	_isConnected = false;
	private _pendingConnect: Promise<void> | undefined;
	private _retryIntervalMs = DEFAULT_RETRY_INTERVAL_S * 1000;
	private _nextAttemptAt = 0;

	constructor(ip?: string, port?: string | number, password?: string, secure?: boolean) {
		super();
		this._ip = ip;
		this._port = port;
		this._password = password;
		this._secure = secure;

		this.on('ConnectionOpened', () => SDUtils.logDebug(`WS initial connection opened to server at ${this._ip}:${this._port}`));
		this.on('Hello', (data) => SDUtils.logDebug(`WS server at ${this._ip}:${this._port} sent Hello message - OBS WS Version: ${data.obsWebSocketVersion} | RPC Version: ${data.rpcVersion}`));

		this.on('Identified', () => {
			this._isConnected = true;
			this._nextAttemptAt = 0;
			const logStr = `[CONNECTED] OBS Websocket server at ${this._ip}:${this._port}`;
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
				const logStr = `[DISCONNECTED] OBS Websocket server at ${this._ip}:${this._port}`;
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
		return `${this._secure ? 'wss' : 'ws'}://${this._ip}:${this._port}`;
	}

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
	 * Update ip/port/pwd/secure settings, and reconnect if needed
	 * @param {string} ip
	 * @param {string} port
	 * @param {string?} password
	 * @param {boolean} secure
	 */
	updateSettings(ip: string, port: string | number, password?: string, secure?: boolean) {
		if (this._ip !== ip || this._port !== port || this._password !== password || this._secure !== secure) {
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

export const sockets = new Array(MAX_SERVERS).fill(null).map(() => new Socket());
