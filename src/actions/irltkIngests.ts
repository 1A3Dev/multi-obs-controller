import { sockets } from '../plugin/sockets';
import { globalSettings } from './globalSettings';
import { IngestCategory } from './types';

export type IrltkIngest = {
	id: string;
	name: string;
	obs_source_name: string;
	main_source: boolean;
	muted: boolean;
	router_bitrate: number;
	router_rtt: number;
	type: string;
	volume: number;
	media_state?: string;
}
export type IrltkOutputStatus = {
	stream_status: boolean;
	stream_timecode: string;
}
export type IrltkStatusUpdate = {
	ingests: IrltkIngest[];
	low_bitrate_trigger: number;
	offline_bitrate_trigger: number;
	main_ingest_id: string;
	output_status: IrltkOutputStatus;
}

export type IrltkTargetSettings = {
	ingestTargetMode?: 'dynamic';
	ingestSourceName?: string;
	ingestIndex?: string;
	ingestOnlineOnly?: 'true';
}

export type IngestThresholds = { low: number, offline: number };

/** Number of ingest slots per virtual page, matching the Prev/Next/Page Number paging actions */
export const INGEST_PAGE_SIZE = 4;

/** Name of the plugin-bundled profile Open Ingest Profile switches to - must match both its "Profiles"
 * entry in manifest.json and the Name baked into src/IRLToolkit Ingests (Auto).streamDeckProfile itself */
export const INGEST_PROFILE_NAME = 'IRLToolkit Ingests (Auto)';

// Shared per-socket ingest cache, kept up to date from IRLTKStatusUpdate. Centralized here (rather than
// duplicated per action class) so every consumer - dial/status actions, and the general configuration
// window's alias editor - sees the same live data without each maintaining its own subscription
const ingestsBySource: Map<string, IrltkIngest>[] = new Array(sockets.length).fill(null).map(() => new Map());
const thresholds: IngestThresholds[] = new Array(sockets.length).fill(null).map(() => ({ low: 0, offline: 0 }));
const updateListeners = new Set<(socketIdx: number) => void>();

// Per-socket output/stream status, from the same IRLTKStatusUpdate payload as the ingests above -
// IRLToolkit's own view of whether it's actually receiving a live stream, which is what StreamStatusAction
// targets for IRLTK servers instead of OBS's native StreamStateChanged/GetStreamStatus. Undefined until the
// first update arrives (or again after a disconnect), rather than defaulting to "offline", so a consumer
// can tell "unknown yet" apart from a confirmed-offline reading
const outputStatusBySocket: (IrltkOutputStatus | undefined)[] = new Array(sockets.length).fill(undefined);

// Timestamp each ingest was last seen online, per socket - lets online-only filtering (see
// isIngestOnlineWithGrace) keep a just-dropped ingest in place for a short grace period instead of
// yanking it out of the list/paging immediately, so a dynamic-position button doesn't suddenly resolve
// to a different ingest out from under the user. Set comfortably above the observed ~2.2s IRLTKStatusUpdate
// interval so a dropped ingest reliably survives at least one refresh tick showing Offline before it's
// actually removed, rather than the grace window elapsing before the next update even arrives
const OFFLINE_GRACE_MS = 3000;
const lastOnlineAt: Map<string, number>[] = new Array(sockets.length).fill(null).map(() => new Map());

// Last known data for every ingest, per socket, regardless of online state - IRLToolkit stops reporting
// an ingest in `data.ingests` entirely once it disconnects, rather than continuing to report it with a
// degraded bitrate, so there's nothing left in the fresh map to apply the offline grace period to. This
// keeps enough of a snapshot to synthesize a placeholder (see the IRLTKStatusUpdate handler below) that
// fills that gap for OFFLINE_GRACE_MS, forced to read as offline rather than replaying its last real state
const lastSeenIngest: Map<string, IrltkIngest>[] = new Array(sockets.length).fill(null).map(() => new Map());

// Last known obs_source_name -> IRLToolkit name for every ingest ever seen on a socket this session -
// unlike ingestsBySource above, this is never cleared on disconnect, so the general configuration
// window's ingest alias editor can still show (and let the user edit aliases for) ingests that existed
// the last time the socket was connected, rather than going blank while it's offline
const lastKnownIngestNames: Map<string, string>[] = new Array(sockets.length).fill(null).map(() => new Map());

// Shared per-socket "virtual page" for dynamic-position actions while ingest paging is active (see
// isIngestPagingActive) - lets a single fixed row of status/volume actions page through however many
// ingests are online, driven by dedicated Prev/Next actions, instead of needing multiple real Stream
// Deck profile pages
const currentPage: number[] = new Array(sockets.length).fill(1);
const pageListeners = new Set<(socketIdx: number) => void>();

/**
 * Runtime override set by an Open Ingest Profile action right before it switches to the Stream Deck
 * profile it's configured for, and cleared by Previous Profile on the way back out. While active, it
 * overrides both the OBS target (`target`, matching the "target" settings convention - 1-based socket
 * index) and the online/offline filtering (`includeOffline`) for every IRLTK-only action currently on
 * screen, regardless of each individual button's own settings - letting one "auto" profile be repointed
 * at a different server/filtering mode per Open Ingest Profile button instead of needing its buttons
 * reconfigured by hand. Its mere presence also drives ingest paging (see isIngestPagingActive) - that
 * profile is only ever reached via Open Ingest Profile, so there's no case where paging should be on
 * without the rest of the override, or vice versa
 */
export type IngestContextOverride = { target?: number, includeOffline?: boolean };
let ingestContextOverride: IngestContextOverride = {};

export function setIngestContextOverride(override: IngestContextOverride): void {
	ingestContextOverride = override;
}

export function clearIngestContextOverride(): void {
	ingestContextOverride = {};
}

export function getIngestContextOverride(): IngestContextOverride {
	return ingestContextOverride;
}

/**
 * Whether dynamic-position ingest actions should follow the shared virtual page (see getIngestPage)
 * instead of a fixed position - true exactly while an Open Ingest Profile override is active, since
 * that's the only way onto the profile paging is meant for. Replaces what used to be a manual
 * per-button "Follow Page Navigation" setting
 */
export function isIngestPagingActive(): boolean {
	return ingestContextOverride.target !== undefined;
}

/**
 * Whether offline ingests should be included, wherever online/offline filtering is applied - from the
 * active Open Ingest Profile override's own Include Offline Ingests setting. Defaults to false (online
 * only) when no override is active
 */
function shouldIncludeOfflineIngests(): boolean {
	return !!ingestContextOverride.includeOffline;
}

sockets.forEach((socket, socketIdx) => {
	(socket as any).on('IRLTKStatusUpdate', (data: IrltkStatusUpdate) => {
		thresholds[socketIdx] = { low: data.low_bitrate_trigger, offline: data.offline_bitrate_trigger };
		outputStatusBySocket[socketIdx] = data.output_status;

		const onlineAt = lastOnlineAt[socketIdx];
		const lastSeen = lastSeenIngest[socketIdx];
		const now = Date.now();
		const seen = new Set<string>();
		const merged = new Map(data.ingests.map(i => [i.obs_source_name, i]));
		data.ingests.forEach(i => {
			seen.add(i.obs_source_name);
			lastSeen.set(i.obs_source_name, i);
			lastKnownIngestNames[socketIdx].set(i.obs_source_name, i.name);
			if (isIngestOnline(i, thresholds[socketIdx])) onlineAt.set(i.obs_source_name, now);
		});
		// Names IRLToolkit has stopped reporting altogether but were online recently still get a
		// synthesized offline placeholder for OFFLINE_GRACE_MS, so they stay resolvable (and correctly
		// read as offline) instead of disappearing from the map the instant they're dropped from the payload
		[...onlineAt.keys()].forEach(name => {
			if (seen.has(name)) return;
			if (now - onlineAt.get(name)! < OFFLINE_GRACE_MS) {
				const last = lastSeen.get(name);
				if (last) merged.set(name, { ...last, router_bitrate: 0, media_state: undefined });
			} else {
				onlineAt.delete(name);
				lastSeen.delete(name);
			}
		});
		ingestsBySource[socketIdx] = merged;

		// Clamp the current page down first (before notifying updateListeners) if it now exceeds the new
		// page count, so page-following actions recompute against the corrected page in a single pass
		const maxPage = getIngestPageCount(socketIdx);
		const pageChanged = currentPage[socketIdx] > maxPage;
		if (pageChanged) currentPage[socketIdx] = maxPage;

		updateListeners.forEach(fn => fn(socketIdx));
		if (pageChanged) pageListeners.forEach(fn => fn(socketIdx));
	});
	// @ts-expect-error Disconnected event is custom of the Socket class, not part of the OBS WS protocol
	socket.on('Disconnected', () => {
		ingestsBySource[socketIdx] = new Map();
		lastOnlineAt[socketIdx] = new Map();
		lastSeenIngest[socketIdx] = new Map();
		outputStatusBySocket[socketIdx] = undefined;
		updateListeners.forEach(fn => fn(socketIdx));

		if (currentPage[socketIdx] !== 1) {
			currentPage[socketIdx] = 1;
			pageListeners.forEach(fn => fn(socketIdx));
		}
	});
});

/**
 * Current 1-based virtual page for a socket's paginated ingest actions
 */
export function getIngestPage(socketIdx: number): number {
	return currentPage[socketIdx];
}

/**
 * Total number of virtual pages for a socket, based on how many ingests are currently online - or every
 * ingest regardless of state, if offline ingests are being included (see shouldIncludeOfflineIngests)
 * (always at least 1 either way, so a page-number display never shows "0/0")
 */
export function getIngestPageCount(socketIdx: number): number {
	const ingests = [...getIngests(socketIdx).values()];
	const count = shouldIncludeOfflineIngests() ? ingests.length : ingests.filter(i => isIngestOnlineWithGrace(i, getThresholds(socketIdx), socketIdx)).length;
	return Math.max(1, Math.ceil(count / INGEST_PAGE_SIZE));
}

/**
 * Set a socket's current virtual page, clamped to [1, pageCount]. No-ops (and doesn't notify listeners) if
 * the clamped value doesn't actually change
 */
export function setIngestPage(socketIdx: number, page: number): void {
	const clamped = Math.min(Math.max(1, page), getIngestPageCount(socketIdx));
	if (clamped === currentPage[socketIdx]) return;
	currentPage[socketIdx] = clamped;
	pageListeners.forEach(fn => fn(socketIdx));
}

/**
 * Subscribe to virtual page changes (including automatic clamping) for any socket
 */
export function onIngestPageChanged(callback: (socketIdx: number) => void): void {
	pageListeners.add(callback);
}

export function getIngests(socketIdx: number): Map<string, IrltkIngest> {
	return ingestsBySource[socketIdx];
}

/**
 * Last known obs_source_name -> IRLToolkit name for every ingest ever seen on this socket this
 * session, regardless of current connection state - see lastKnownIngestNames
 */
export function getLastKnownIngestNames(socketIdx: number): Map<string, string> {
	return lastKnownIngestNames[socketIdx];
}

export function getThresholds(socketIdx: number): IngestThresholds {
	return thresholds[socketIdx];
}

/**
 * IRLToolkit's own view of the socket's output/stream status, from the latest IRLTKStatusUpdate -
 * undefined if none has been received yet (or the socket is currently disconnected)
 */
export function getOutputStatus(socketIdx: number): IrltkOutputStatus | undefined {
	return outputStatusBySocket[socketIdx];
}

/**
 * Subscribe to ingest data changes (new IRLTKStatusUpdate, or the socket disconnecting) for any socket
 */
export function onIngestsUpdated(callback: (socketIdx: number) => void): void {
	updateListeners.add(callback);
}

/**
 * Whether an ingest is currently live: for media-backed ingests, actually playing/opening/buffering;
 * otherwise, its router bitrate is above the "offline" threshold (still counts if merely low bitrate)
 */
export function isIngestOnline(ingest: IrltkIngest, ingestThresholds: IngestThresholds): boolean {
	if (ingest.media_state) {
		return ingest.media_state === 'OBS_MEDIA_STATE_PLAYING' || ingest.media_state === 'OBS_MEDIA_STATE_OPENING' || ingest.media_state === 'OBS_MEDIA_STATE_BUFFERING';
	}
	return ingest.router_bitrate > ingestThresholds.offline;
}

/**
 * Like isIngestOnline, but an ingest that just dropped offline still counts as online for
 * OFFLINE_GRACE_MS after its last confirmed-online update - so online-only filtering (dynamic-position
 * status/volume actions, and ingest paging) doesn't immediately drop it out of the list/page and land a
 * key on a different ingest out from under the user
 */
function isIngestOnlineWithGrace(ingest: IrltkIngest, ingestThresholds: IngestThresholds, socketIdx: number): boolean {
	if (isIngestOnline(ingest, ingestThresholds)) return true;
	const lastOnline = lastOnlineAt[socketIdx].get(ingest.obs_source_name);
	return lastOnline !== undefined && Date.now() - lastOnline < OFFLINE_GRACE_MS;
}

/**
 * Like sortIngests, but groups online (or recently-online, within OFFLINE_GRACE_MS - see
 * isIngestOnlineWithGrace) ingests before offline ones, pinned+alphabetical order preserved within each
 * group. Used to resolve dynamic-position ingest status/volume actions, so they fill with live ingests
 * first instead of a plain alphabetical mix. Reuses the same grace window as online-only filtering
 * (rather than a shorter one of its own) since that window is deliberately sized above the observed
 * ~2.2s IRLTKStatusUpdate interval - a shorter grace here would already have expired by the very next
 * update tick, the earliest point a drop can even be noticed, and so would never actually delay anything
 */
function sortIngestsOnlineFirst(ingests: IrltkIngest[], ingestThresholds: IngestThresholds, socketIdx: number): IrltkIngest[] {
	const online = ingests.filter(i => isIngestOnlineWithGrace(i, ingestThresholds, socketIdx));
	const offline = ingests.filter(i => !isIngestOnlineWithGrace(i, ingestThresholds, socketIdx));
	return [...sortIngests(online), ...sortIngests(offline)];
}

// Rank for each category selectable in the general configuration window's IRLToolkit Ingests section
// (see ingestCategory__ in GlobalSettings) - lower sorts first. An ingest with no category assigned (or
// one that doesn't match a known category) ranks last, after every categorized ingest
const CATEGORY_ORDER: Record<IngestCategory, number> = { backpack: 1, phone: 2, desktop: 3 };
const UNCATEGORIZED_RANK = 9;

function getIngestCategoryRank(ingest: IrltkIngest): number {
	const category = globalSettings[`ingestCategory__${ingest.obs_source_name}`];
	return category ? CATEGORY_ORDER[category] ?? UNCATEGORIZED_RANK : UNCATEGORIZED_RANK;
}

/**
 * Sort ingests: names pinned in the general configuration come first, in that configured order, then
 * the rest grouped by their configured category (see getIngestCategoryRank; uncategorized last), and
 * alphabetically by name within each category
 */
export function sortIngests(ingests: IrltkIngest[]): IrltkIngest[] {
	const pinnedSetting = globalSettings.ingestPinned;
	const pinned = (Array.isArray(pinnedSetting) ? pinnedSetting : pinnedSetting ? [pinnedSetting] : [])
	.map(name => name?.trim().toLowerCase())
	.filter((name): name is string => !!name);

	return [...ingests].sort((a, b) => {
		const aPin = pinned.indexOf(a.name.trim().toLowerCase());
		const bPin = pinned.indexOf(b.name.trim().toLowerCase());
		if (aPin !== -1 || bPin !== -1) {
			if (aPin === -1) return 1;
			if (bPin === -1) return -1;
			return aPin - bPin;
		}
		const aCategory = getIngestCategoryRank(a);
		const bCategory = getIngestCategoryRank(b);
		if (aCategory !== bCategory) return aCategory - bCategory;
		return a.name.localeCompare(b.name);
	});
}

/**
 * Resolve which ingest a given action's settings currently point to: either a fixed OBS source name,
 * or the Nth ingest (1-based) in the pinned+alphabetical sort order. In dynamic mode with "online only"
 * enabled, offline ingests are skipped entirely so the position always lands on a currently live one -
 * this requires the socket's current bitrate thresholds, needed to tell live ingests from offline ones.
 * While ingest paging is active (see isIngestPagingActive), `ingestIndex` is instead a 1-4 slot within
 * the socket's current virtual page (see getIngestPage) - this implies "online only" too, since page
 * math only makes sense against the online-filtered list. The active Open Ingest Profile override's own
 * Include Offline Ingests setting (see shouldIncludeOfflineIngests) can include offline ingests in that
 * filter while paging specifically; it does not affect a plain "online only" checkbox used outside of
 * paging
 *
 * Within the resolved set, online (or recently-online within OFFLINE_GRACE_MS, see
 * sortIngestsOnlineFirst) ingests are always sorted first, so a dynamic position preferentially lands on
 * a live ingest
 */
export function resolveIngest(ingestsBySourceMap: Map<string, IrltkIngest>, settings: IrltkTargetSettings, socketIdx: number, ingestThresholds?: IngestThresholds): IrltkIngest | undefined {
	if (settings.ingestTargetMode === 'dynamic') {
		let pos = Number(settings.ingestIndex);
		if (!Number.isInteger(pos) || pos < 1) return undefined;
		let ingests = [...ingestsBySourceMap.values()];
		const paging = isIngestPagingActive();
		const includeOfflineOverride = paging && shouldIncludeOfflineIngests();
		if ((settings.ingestOnlineOnly === 'true' || paging) && ingestThresholds && !includeOfflineOverride) {
			ingests = ingests.filter(i => isIngestOnlineWithGrace(i, ingestThresholds, socketIdx));
		}
		if (paging) {
			pos += (getIngestPage(socketIdx) - 1) * INGEST_PAGE_SIZE;
		}
		const sorted = ingestThresholds ? sortIngestsOnlineFirst(ingests, ingestThresholds, socketIdx) : sortIngests(ingests);
		return sorted[pos - 1];
	}
	return settings.ingestSourceName ? ingestsBySourceMap.get(settings.ingestSourceName) : undefined;
}

/**
 * Whether the settings have enough information to resolve to an ingest (regardless of whether one currently does)
 */
export function hasIngestTarget(settings: IrltkTargetSettings): boolean {
	return settings.ingestTargetMode === 'dynamic' ? !!settings.ingestIndex : !!settings.ingestSourceName;
}

/**
 * The name to display for an ingest: its general-configuration alias if set, otherwise its IRLToolkit name
 */
export function getIngestDisplayName(ingest: IrltkIngest): string {
	return globalSettings[`ingestAlias__${ingest.obs_source_name}`] || ingest.name;
}
