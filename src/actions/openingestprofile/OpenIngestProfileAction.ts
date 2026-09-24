import { getDeviceType } from '../../plugin/devices';
import { sockets } from '../../plugin/sockets';
import { SDUtils } from '../../plugin/utils';
import { globalSettings, resolveServers, resolveTargetIndex } from '../globalSettings';
import { getIngestProfileName, setIngestContextOverride, setIngestPage } from '../irltkIngests';
import { DidReceiveSettingsData, KeyUpData, WillAppearData, WillDisappearData } from '../types';

type ActionSettings = {
	server?: string;
	includeOffline?: 'true';
	device?: string;
}

const KEY_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144"><rect fill="#517a96" width="144" height="144" rx="22"/><rect fill="#efefef" x="40" y="40" width="28" height="28" rx="4"/><rect fill="#efefef" x="76" y="40" width="28" height="28" rx="4"/><rect fill="#efefef" x="40" y="76" width="28" height="28" rx="4"/><rect fill="#efefef" x="76" y="76" width="28" height="28" rx="4"/></svg>';
const DIMMED_KEY_SVG = KEY_SVG.replace('</svg>', '<rect x="0" y="0" width="144" height="144" fill="black" fill-opacity="0.5" rx="22"/></svg>');
const CONNECTED_IMG = `data:image/svg+xml;base64,${btoa(KEY_SVG)}`;
const DISCONNECTED_IMG = `data:image/svg+xml;base64,${btoa(DIMMED_KEY_SVG)}`;

export class OpenIngestProfileAction extends Action {
	private _contexts = new Map<string, number>();

	constructor() {
		super('uk.1a3.multiobs.openingestprofile');

		this.onWillAppear(({ context, payload }: WillAppearData<ActionSettings>) => {
			this._trackContext(context, payload.settings);
		});

		this.onDidReceiveSettings(({ context, payload }: DidReceiveSettingsData<ActionSettings>) => {
			this._trackContext(context, payload.settings);
		});

		this.onWillDisappear(({ context }: WillDisappearData<ActionSettings>) => {
			this._contexts.delete(context);
		});

		sockets.forEach((socket, socketIdx) => {
			socket.on('Identified', () => this._updateContextsForSocket(socketIdx));
			// @ts-expect-error Disconnected event is custom of the Socket class, not part of the OBS WS protocol
			socket.on('Disconnected', () => this._updateContextsForSocket(socketIdx));
		});

		$SD.onDidReceiveGlobalSettings(() => {
			for (const context of this._contexts.keys()) $SD.getSettings(context);
		});

		this.onKeyUp(({ context, device, payload }: KeyUpData<ActionSettings>) => {
			const { settings } = payload;
			const targetIndex = this._resolveTargetIndex(settings);
			const targetDevice = settings.device || device;
			const profileName = getIngestProfileName(getDeviceType(targetDevice));
			if (!targetIndex || !profileName) {
				$SD.showAlert(context);
				return;
			}

			setIngestContextOverride({ target: targetIndex, includeOffline: settings.includeOffline === 'true' });
			setIngestPage(targetIndex - 1, 1);

			$SD.switchToProfile(targetDevice, profileName);
			if (globalSettings.feedback !== 'hide') setTimeout(() => $SD.showOk(context), 150);

			const promptedKey = `ingestProfileInstallPrompted__${profileName}` as const;
			if (globalSettings[promptedKey] !== 'true') {
				try {
					$SD.openUrl(new URL(`../${encodeURIComponent(profileName)}.streamDeckProfile`, location.href).href);
					$SD.setGlobalSettings({ ...globalSettings, [promptedKey]: 'true' });
				}
				catch (e) {
					SDUtils.logError(`Failed to prompt for ingest profile install: ${e}`);
				}
			}
		});
	}

	private _resolveTargetIndex(settings: ActionSettings): number {
		const server = settings.server ?? getDefaultIrltkServer();
		return server ? resolveTargetIndex(server, resolveServers(globalSettings)) : 0;
	}

	private _trackContext(context: string, settings: ActionSettings) {
		const targetIndex = this._resolveTargetIndex(settings);
		this._contexts.set(context, targetIndex);
		this._updateImage(context, targetIndex);
	}

	private _updateContextsForSocket(socketIdx: number) {
		for (const [context, targetIndex] of this._contexts) {
			if (targetIndex - 1 === socketIdx) this._updateImage(context, targetIndex);
		}
	}

	private _updateImage(context: string, targetIndex: number) {
		const connected = !!targetIndex && sockets[targetIndex - 1]?.isConnected;
		$SD.setImage(context, connected ? CONNECTED_IMG : DISCONNECTED_IMG);
	}
}

function getDefaultIrltkServer(): string | undefined {
	return resolveServers(globalSettings).find(server => server.irltk === 'true')?.id;
}
