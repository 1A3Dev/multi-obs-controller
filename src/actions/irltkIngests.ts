import { sockets } from '../plugin/sockets';
import { INGEST_CATEGORIES, INGEST_PROFILE_NAMES } from '../shared/constants';
import { globalSettings, resolveServers } from './globalSettings';
import { ServerConfig } from './types';

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
	/** Dynamic positions only resolve on the ingest page (opened via Open Ingest Profile) */
	ingestTargetMode?: 'dynamic';
	ingestSourceName?: string;
	ingestIndex?: string;
}

export type IngestThresholds = { low: number, offline: number };

const DEFAULT_INGEST_PAGE_SIZE = 4;

export function getIngestProfileName(deviceType: number | undefined): string | undefined {
	return deviceType !== undefined ? INGEST_PROFILE_NAMES[deviceType] : undefined;
}

const ingestsBySource: Map<string, IrltkIngest>[] = new Array(sockets.length).fill(null).map(() => new Map());
const thresholds: IngestThresholds[] = new Array(sockets.length).fill(null).map(() => ({ low: 0, offline: 0 }));
const updateListeners = new Set<(socketIdx: number) => void>();

const outputStatusBySocket: (IrltkOutputStatus | undefined)[] = new Array(sockets.length).fill(undefined);

const OFFLINE_GRACE_MS = 3000;
const lastOnlineAt: Map<string, number>[] = new Array(sockets.length).fill(null).map(() => new Map());

const lastSeenIngest: Map<string, IrltkIngest>[] = new Array(sockets.length).fill(null).map(() => new Map());

const lastKnownIngestNames: Map<string, string>[] = new Array(sockets.length).fill(null).map(() => new Map());

export const BITRATE_HISTORY_LENGTH = 30;
const bitrateHistory: Map<string, number[]>[] = new Array(sockets.length).fill(null).map(() => new Map());

const currentPage: number[] = new Array(sockets.length).fill(1);

/**
 * Fixed slot layout of the ingest page, per socket: the OBS source name shown at each position. Ingests keep
 * their slot (shown offline if they go offline or drop out of IRLToolkit's list) and newly listed ingests are
 * added at the end, so nothing on the page moves until it's re-sorted by refreshIngestPage (or reopening the page)
 */
let pageSlots: string[][] = sockets.map(() => []);
/** Last known data of every ingest in pageSlots, to keep showing ingests that dropped out of IRLToolkit's list */
let pageSlotIngests: Map<string, IrltkIngest>[] = sockets.map(() => new Map());
const pageListeners = new Set<(socketIdx: number) => void>();

/** Dynamic-position ingest buttons currently on screen: <context, ingestIndex per socket (0 if none)>. The page size follows the highest one, so it matches the open profile's layout */
const dynamicIngestPositions = new Map<string, number[]>();

export type IngestContextOverride = { target?: number, includeOffline?: boolean, studioTarget?: 'preview' | 'program' };
let ingestContextOverride: IngestContextOverride = {};
const studioTargetListeners = new Set<() => void>();

export function setIngestContextOverride(override: IngestContextOverride): void {
	ingestContextOverride = override;
	// Opening the ingest page starts again from the sorted order
	pageSlots = sockets.map((_, socketIdx) => getPageListedIngests(socketIdx));
	pageSlotIngests = sockets.map((_, socketIdx) => new Map(pageSlots[socketIdx].map(name => [name, ingestsBySource[socketIdx].get(name)!])));
	studioTargetListeners.forEach(fn => fn());
}

export function clearIngestContextOverride(): void {
	ingestContextOverride = {};
	studioTargetListeners.forEach(fn => fn());
}

export function setIngestStudioTargetOverride(studioTarget: 'preview' | 'program' | undefined): void {
	ingestContextOverride = { ...ingestContextOverride, studioTarget };
	studioTargetListeners.forEach(fn => fn());
}

export function onIngestStudioTargetOverrideChanged(callback: () => void): void {
	studioTargetListeners.add(callback);
}

export function getIngestContextOverride(): IngestContextOverride {
	return ingestContextOverride;
}

export function isIngestPagingActive(): boolean {
	return ingestContextOverride.target !== undefined;
}

function shouldIncludeOfflineIngests(): boolean {
	return !!ingestContextOverride.includeOffline;
}

/** Source names of the ingests the ingest page lists, in sorted order */
function getPageListedIngests(socketIdx: number): string[] {
	let ingests = [...ingestsBySource[socketIdx].values()];
	if (!shouldIncludeOfflineIngests()) ingests = ingests.filter(i => isIngestOnlineWithGrace(i, thresholds[socketIdx], socketIdx));
	return sortIngestsOnlineFirst(ingests, thresholds[socketIdx], socketIdx).map(i => i.obs_source_name);
}

/** Add newly listed ingests at the end of the page, and keep the last known data of the ones already on it */
function updatePageSlots(socketIdx: number): void {
	const slots = pageSlots[socketIdx];
	const placed = new Set(slots);
	getPageListedIngests(socketIdx).forEach(name => {
		if (!placed.has(name)) slots.push(name);
	});
	slots.forEach(name => {
		const ingest = ingestsBySource[socketIdx].get(name);
		if (ingest) pageSlotIngests[socketIdx].set(name, ingest);
	});
}

/** Re-sort the ingest page: offline ingests are dropped (unless the page includes them) and the rest re-ordered */
export function refreshIngestPage(socketIdx: number): void {
	pageSlots[socketIdx] = getPageListedIngests(socketIdx);
	pageSlotIngests[socketIdx] = new Map(pageSlots[socketIdx].map(name => [name, ingestsBySource[socketIdx].get(name)!]));
	currentPage[socketIdx] = Math.min(currentPage[socketIdx], getIngestPageCount(socketIdx));
	updateListeners.forEach(fn => fn(socketIdx));
	pageListeners.forEach(fn => fn(socketIdx));
	refreshListeners.forEach(fn => fn(socketIdx));
}

const refreshListeners = new Set<(socketIdx: number) => void>();

/** Called after refreshIngestPage re-sorts a socket's ingest page (not on page changes or ingest updates) */
export function onIngestPageRefreshed(callback: (socketIdx: number) => void): void {
	refreshListeners.add(callback);
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

		const history = bitrateHistory[socketIdx];
		merged.forEach((ingest, name) => {
			const samples = history.get(name) ?? [];
			samples.push(ingest.router_bitrate);
			if (samples.length > BITRATE_HISTORY_LENGTH) samples.splice(0, samples.length - BITRATE_HISTORY_LENGTH);
			history.set(name, samples);
		});
		[...history.keys()].forEach(name => {
			if (!merged.has(name)) history.delete(name);
		});

		updatePageSlots(socketIdx);

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
		bitrateHistory[socketIdx] = new Map();
		outputStatusBySocket[socketIdx] = undefined;
		pageSlots[socketIdx] = [];
		pageSlotIngests[socketIdx] = new Map();
		updateListeners.forEach(fn => fn(socketIdx));

		if (currentPage[socketIdx] !== 1) {
			currentPage[socketIdx] = 1;
			pageListeners.forEach(fn => fn(socketIdx));
		}
	});
});

export function getIngestPage(socketIdx: number): number {
	return currentPage[socketIdx];
}

export function getIngestPageSize(socketIdx: number): number {
	const positions = [...dynamicIngestPositions.values()].map(perSocket => perSocket[socketIdx] ?? 0);
	return Math.max(0, ...positions) || DEFAULT_INGEST_PAGE_SIZE;
}

/**
 * Track the dynamic ingest positions of a visible button (or remove it, with no settings), re-paging
 * every socket whose page size changes as a result
 */
export function setDynamicIngestPositions(context: string, settings?: (Partial<IrltkTargetSettings> | null)[]): void {
	const before = sockets.map((_, socketIdx) => getIngestPageSize(socketIdx));
	const positions = settings?.map(socketSettings => {
		const pos = socketSettings?.ingestTargetMode === 'dynamic' ? Number(socketSettings.ingestIndex) : 0;
		return Number.isInteger(pos) && pos > 0 ? pos : 0;
	});
	if (positions?.some(pos => pos > 0)) dynamicIngestPositions.set(context, positions);
	else dynamicIngestPositions.delete(context);

	before.forEach((size, socketIdx) => {
		if (getIngestPageSize(socketIdx) === size) return;
		currentPage[socketIdx] = Math.min(currentPage[socketIdx], getIngestPageCount(socketIdx));
		pageListeners.forEach(fn => fn(socketIdx));
	});
}

export function getIngestPageCount(socketIdx: number): number {
	return Math.max(1, Math.ceil(pageSlots[socketIdx].length / getIngestPageSize(socketIdx)));
}

export function setIngestPage(socketIdx: number, page: number): void {
	const clamped = Math.min(Math.max(1, page), getIngestPageCount(socketIdx));
	if (clamped === currentPage[socketIdx]) return;
	currentPage[socketIdx] = clamped;
	pageListeners.forEach(fn => fn(socketIdx));
}

export function onIngestPageChanged(callback: (socketIdx: number) => void): void {
	pageListeners.add(callback);
}

export function getIngests(socketIdx: number): Map<string, IrltkIngest> {
	return ingestsBySource[socketIdx];
}

export function getLastKnownIngestNames(socketIdx: number): Map<string, string> {
	return lastKnownIngestNames[socketIdx];
}

export function getBitrateHistory(socketIdx: number, sourceName: string): number[] {
	return bitrateHistory[socketIdx].get(sourceName) ?? [];
}

export function getThresholds(socketIdx: number): IngestThresholds {
	return thresholds[socketIdx];
}

export function getOutputStatus(socketIdx: number): IrltkOutputStatus | undefined {
	return outputStatusBySocket[socketIdx];
}

export function onIngestsUpdated(callback: (socketIdx: number) => void): void {
	updateListeners.add(callback);
}

export function isIngestOnline(ingest: IrltkIngest, ingestThresholds: IngestThresholds): boolean {
	if (ingest.media_state) {
		return ingest.media_state === 'OBS_MEDIA_STATE_PLAYING' || ingest.media_state === 'OBS_MEDIA_STATE_OPENING' || ingest.media_state === 'OBS_MEDIA_STATE_BUFFERING';
	}
	return ingest.router_bitrate > ingestThresholds.offline;
}

function isIngestOnlineWithGrace(ingest: IrltkIngest, ingestThresholds: IngestThresholds, socketIdx: number): boolean {
	if (isIngestOnline(ingest, ingestThresholds)) return true;
	const lastOnline = lastOnlineAt[socketIdx].get(ingest.obs_source_name);
	return lastOnline !== undefined && Date.now() - lastOnline < OFFLINE_GRACE_MS;
}

export function isIngestSourceOnline(socketIdx: number, sourceName: string): boolean | undefined {
	const ingests = ingestsBySource[socketIdx];
	if (!ingests.size) return undefined;
	const ingest = ingests.get(sourceName);
	return !!ingest && isIngestOnlineWithGrace(ingest, thresholds[socketIdx], socketIdx);
}

function sortIngestsOnlineFirst(ingests: IrltkIngest[], ingestThresholds: IngestThresholds, socketIdx: number): IrltkIngest[] {
	const online = ingests.filter(i => isIngestOnlineWithGrace(i, ingestThresholds, socketIdx));
	const offline = ingests.filter(i => !isIngestOnlineWithGrace(i, ingestThresholds, socketIdx));
	return [...sortIngests(online, socketIdx), ...sortIngests(offline, socketIdx)];
}

function getIngestCategoryRank(ingest: IrltkIngest, server: ServerConfig | undefined): number {
	const category = server?.ingestCategory?.[ingest.name];
	const rank = category ? INGEST_CATEGORIES.indexOf(category) : -1;
	return rank !== -1 ? rank : INGEST_CATEGORIES.length;	// uncategorized last
}

export function sortIngests(ingests: IrltkIngest[], socketIdx?: number): IrltkIngest[] {
	const server = socketIdx !== undefined ? resolveServers(globalSettings)[socketIdx] : undefined;
	const pinnedSetting = server?.ingestPinned !== undefined ? server.ingestPinned : globalSettings.ingestPinned;
	const pinned = (Array.isArray(pinnedSetting) ? pinnedSetting : pinnedSetting ? [pinnedSetting] : [])
	.map(name => name?.trim().toLowerCase())
	.filter((name): name is string => !!name);

	return [...ingests].sort((a, b) => {
		const aCategory = getIngestCategoryRank(a, server);
		const bCategory = getIngestCategoryRank(b, server);
		if (aCategory !== bCategory) return aCategory - bCategory;

		const aPin = pinned.indexOf(a.name.trim().toLowerCase());
		const bPin = pinned.indexOf(b.name.trim().toLowerCase());
		if (aPin !== -1 || bPin !== -1) {
			if (aPin === -1) return 1;
			if (bPin === -1) return -1;
			return aPin - bPin;
		}

		return getIngestDisplayName(a, server).localeCompare(getIngestDisplayName(b, server));
	});
}

export function resolveIngest(ingestsBySourceMap: Map<string, IrltkIngest>, settings: IrltkTargetSettings, socketIdx: number): IrltkIngest | undefined {
	if (settings.ingestTargetMode === 'dynamic') {
		const pos = Number(settings.ingestIndex);
		if (!isIngestPagingActive() || !Number.isInteger(pos) || pos < 1) return undefined;
		const name = pageSlots[socketIdx][pos - 1 + (getIngestPage(socketIdx) - 1) * getIngestPageSize(socketIdx)];
		if (name === undefined) return undefined;
		// An ingest that dropped out of IRLToolkit's list keeps its slot, shown as offline
		const last = pageSlotIngests[socketIdx].get(name);
		return ingestsBySourceMap.get(name) ?? (last && { ...last, router_bitrate: 0, media_state: undefined });
	}
	return settings.ingestSourceName ? ingestsBySourceMap.get(settings.ingestSourceName) : undefined;
}

export function hasIngestTarget(settings: IrltkTargetSettings): boolean {
	return settings.ingestTargetMode === 'dynamic' ? !!settings.ingestIndex : !!settings.ingestSourceName;
}

export function getIngestDisplayName(ingest: IrltkIngest, server?: ServerConfig): string {
	return server?.ingestAlias?.[ingest.name] || ingest.name;
}

/** The server's Ingest → Scene mapping configured in General Configuration, by OBS source name */
export function getIngestSceneMap(socketIdx: number): { ingest: string, scene: string }[] {
	const server = resolveServers(globalSettings)[socketIdx];
	return (server?.ingestSceneMap ?? []).filter((m): m is { ingest: string, scene: string } => !!m.ingest && !!m.scene);
}
