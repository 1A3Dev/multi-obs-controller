import { sockets } from '../plugin/sockets';
import { globalSettings, resolveServers } from './globalSettings';
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

export const INGEST_PAGE_SIZE = 4;

export const INGEST_PROFILE_NAMES: Record<number, string> = {
	7: 'IRLToolkit Ingests (+)',
	13: 'IRLToolkit Ingests (+XL)',
};

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

const currentPage: number[] = new Array(sockets.length).fill(1);
const pageListeners = new Set<(socketIdx: number) => void>();

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

export function isIngestPagingActive(): boolean {
	return ingestContextOverride.target !== undefined;
}

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

export function getIngestPage(socketIdx: number): number {
	return currentPage[socketIdx];
}

export function getIngestPageCount(socketIdx: number): number {
	const ingests = [...getIngests(socketIdx).values()];
	const count = shouldIncludeOfflineIngests() ? ingests.length : ingests.filter(i => isIngestOnlineWithGrace(i, getThresholds(socketIdx), socketIdx)).length;
	return Math.max(1, Math.ceil(count / INGEST_PAGE_SIZE));
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

function sortIngestsOnlineFirst(ingests: IrltkIngest[], ingestThresholds: IngestThresholds, socketIdx: number): IrltkIngest[] {
	const online = ingests.filter(i => isIngestOnlineWithGrace(i, ingestThresholds, socketIdx));
	const offline = ingests.filter(i => !isIngestOnlineWithGrace(i, ingestThresholds, socketIdx));
	return [...sortIngests(online, socketIdx), ...sortIngests(offline, socketIdx)];
}

const CATEGORY_ORDER: Record<IngestCategory, number> = { backpack: 1, phone: 2, desktop: 3 };
const UNCATEGORIZED_RANK = 9;

function getIngestCategoryRank(ingest: IrltkIngest): number {
	const category = globalSettings[`ingestCategory__${ingest.obs_source_name}`];
	return category ? CATEGORY_ORDER[category] ?? UNCATEGORIZED_RANK : UNCATEGORIZED_RANK;
}

export function sortIngests(ingests: IrltkIngest[], socketIdx?: number): IrltkIngest[] {
	const server = socketIdx !== undefined ? resolveServers(globalSettings)[socketIdx] : undefined;
	const pinnedSetting = server?.ingestPinned !== undefined ? server.ingestPinned : globalSettings.ingestPinned;
	const pinned = (Array.isArray(pinnedSetting) ? pinnedSetting : pinnedSetting ? [pinnedSetting] : [])
	.map(name => name?.trim().toLowerCase())
	.filter((name): name is string => !!name);

	return [...ingests].sort((a, b) => {
		const aCategory = getIngestCategoryRank(a);
		const bCategory = getIngestCategoryRank(b);
		if (aCategory !== bCategory) return aCategory - bCategory;

		const aPin = pinned.indexOf(a.name.trim().toLowerCase());
		const bPin = pinned.indexOf(b.name.trim().toLowerCase());
		if (aPin !== -1 || bPin !== -1) {
			if (aPin === -1) return 1;
			if (bPin === -1) return -1;
			return aPin - bPin;
		}

		return getIngestDisplayName(a).localeCompare(getIngestDisplayName(b));
	});
}

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
		const sorted = ingestThresholds ? sortIngestsOnlineFirst(ingests, ingestThresholds, socketIdx) : sortIngests(ingests, socketIdx);
		return sorted[pos - 1];
	}
	return settings.ingestSourceName ? ingestsBySourceMap.get(settings.ingestSourceName) : undefined;
}

export function hasIngestTarget(settings: IrltkTargetSettings): boolean {
	return settings.ingestTargetMode === 'dynamic' ? !!settings.ingestIndex : !!settings.ingestSourceName;
}

export function getIngestDisplayName(ingest: IrltkIngest): string {
	return globalSettings[`ingestAlias__${ingest.obs_source_name}`] || ingest.name;
}
