import { sockets } from '../../plugin/sockets';
import { SDUtils } from '../../plugin/utils';
import { globalSettings, resolveServers, resolveTargetIndex } from '../globalSettings';
import { INGEST_PROFILE_NAME, setIngestContextOverride, setIngestPage } from '../irltkIngests';
import { DidReceiveSettingsData, KeyUpData, WillAppearData, WillDisappearData } from '../types';

type ActionSettings = {
	server?: string;
	includeOffline?: 'true';
	device?: string;
}

// Same static icon declared as the manifest's default key image, plus a dimmed variant - matching the
// dim treatment other actions use for a disconnected/unavailable target - shown while this button's
// configured server is unreachable
const KEY_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144"><rect fill="#517a96" width="144" height="144" rx="22"/><rect fill="#efefef" x="40" y="40" width="28" height="28" rx="4"/><rect fill="#efefef" x="76" y="40" width="28" height="28" rx="4"/><rect fill="#efefef" x="40" y="76" width="28" height="28" rx="4"/><rect fill="#efefef" x="76" y="76" width="28" height="28" rx="4"/></svg>';
const DIMMED_KEY_SVG = KEY_SVG.replace('</svg>', '<rect x="0" y="0" width="144" height="144" fill="black" fill-opacity="0.5" rx="22"/></svg>');
const CONNECTED_IMG = `data:image/svg+xml;base64,${btoa(KEY_SVG)}`;
const DISCONNECTED_IMG = `data:image/svg+xml;base64,${btoa(DIMMED_KEY_SVG)}`;

/**
 * Switches to the plugin's bundled "IRLToolkit Ingests (Auto)" profile (full of Ingest Status/Volume
 * actions set to Dynamic Position, which page automatically while reached this way - see
 * isIngestPagingActive), while also setting the shared ingest context override (see irltkIngests.ts)
 * from this button's own Server/Include Offline Ingests settings - overriding whatever each individual
 * button on that destination profile is itself configured with.
 * That lets the same profile be repointed at a different server (or offline-inclusion) depending on
 * which Open Ingest Profile button was used to get there, instead of needing every button on it
 * reconfigured by hand. The target profile itself isn't configurable - switchToProfile can only reach
 * profiles this plugin declares (see manifest.json's "Profiles"), so there's only ever this one to pick.
 * Doesn't use the shared OBS-target property inspector (this has nothing to do with per-instance state,
 * just which server the override should point at) - see propertyInspector/openingestprofile.html.
 * Paired with Previous Profile, which clears the override again on the way back out.
 *
 * Stream Deck has no API to check whether a plugin-declared profile is actually installed on a given
 * device, and switchToProfile gives no feedback either way if it isn't - so the first time this button
 * is ever pressed, it also opens the bundled .streamDeckProfile file itself, via its OS file association
 * (which Stream Deck registers to handle), triggering Stream Deck's own "Install profile?" prompt, same
 * as double-clicking the file manually. Only actually needed once (or again after the profile's been
 * removed, or on a device the plugin wasn't installed on yet), so it's gated by a persisted flag rather
 * than firing on every press, which would otherwise re-prompt forever after the first real install
 */
export class OpenIngestProfileAction extends Action {
	private _contexts = new Map<string, number>(); // <context, targetIndex>

	constructor() {
		super('dev.theca11.multiobs.openingestprofile');

		this.onWillAppear(({ context, payload }: WillAppearData<ActionSettings>) => {
			this._trackContext(context, payload.settings);
		});

		this.onDidReceiveSettings(({ context, payload }: DidReceiveSettingsData<ActionSettings>) => {
			this._trackContext(context, payload.settings);
		});

		this.onWillDisappear(({ context }: WillDisappearData<ActionSettings>) => {
			this._contexts.delete(context);
		});

		// Redraw affected buttons' icons as their configured server connects/disconnects
		sockets.forEach((socket, socketIdx) => {
			socket.on('Identified', () => this._updateContextsForSocket(socketIdx));
			// @ts-expect-error Disconnected event is custom of the Socket class, not part of the OBS WS protocol
			socket.on('Disconnected', () => this._updateContextsForSocket(socketIdx));
		});

		// Server list may have been reordered, invalidating cached target indices - refetch each
		// context's settings to recompute them (mirrors the same pattern in BaseWsAction)
		$SD.onDidReceiveGlobalSettings(() => {
			for (const context of this._contexts.keys()) $SD.getSettings(context);
		});

		this.onKeyUp(({ context, device, payload }: KeyUpData<ActionSettings>) => {
			const { settings } = payload;
			const targetIndex = this._resolveTargetIndex(settings);
			if (!targetIndex) {
				$SD.showAlert(context);
				return;
			}

			setIngestContextOverride({ target: targetIndex, includeOffline: settings.includeOffline === 'true' });
			// Always land on page 1 of the destination profile, rather than wherever paging was last left
			// (e.g. from a previous visit, or another Open Ingest Profile button targeting the same server)
			setIngestPage(targetIndex - 1, 1);

			// The actual navigation must never be blocked by the install-prompt nudge below - it's a
			// best-effort side effect, not something the core feature should depend on
			$SD.switchToProfile(settings.device || device, INGEST_PROFILE_NAME);
			if (globalSettings.feedback !== 'hide') setTimeout(() => $SD.showOk(context), 150);

			if (globalSettings.ingestProfileInstallPrompted !== 'true') {
				try {
					$SD.openUrl(new URL(`../${encodeURIComponent(INGEST_PROFILE_NAME)}.streamDeckProfile`, location.href).href);
					$SD.setGlobalSettings({ ...globalSettings, ingestProfileInstallPrompted: 'true' });
				}
				catch (e) {
					SDUtils.logError(`Failed to prompt for ingest profile install: ${e}`);
				}
			}
		});
	}

	// Falls back to the first IRLTK-flagged server if none is saved yet - the property inspector
	// auto-picks one too, but only once it's been opened at least once, so this keeps the button
	// working even for a key placed via an imported profile whose PI was never opened locally
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

/**
 * First IRLTK-flagged server's stable id, matching the "server" settings convention - or undefined if
 * none is flagged yet
 */
function getDefaultIrltkServer(): string | undefined {
	return resolveServers(globalSettings).find(server => server.irltk === 'true')?.id;
}
