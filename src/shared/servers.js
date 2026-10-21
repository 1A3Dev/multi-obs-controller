// Shared between the plugin (bundled by webpack) and the property inspector (loaded as plain ES modules)
import { INGEST_CATEGORIES, MAX_SERVERS } from './constants.js';

export function genServerId() {
	return `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Resolve the configured servers from global settings, migrating the legacy ip1/port1/pwd1... format if needed
 * @param {Record<string, any>} settings Global settings
 * @returns {Record<string, any>[]}
 */
export function resolveServers(settings) {
	if (Array.isArray(settings.servers)) {
		const servers = settings.servers.map((server) => (server.id ? server : { ...server, id: genServerId() }));
		return migrateGlobalIngestAliases(settings, servers);
	}

	const legacy = [];
	for (let i = 1; i <= MAX_SERVERS; i++) {
		const ip = settings[`ip${i}`];
		const port = settings[`port${i}`];
		const pwd = settings[`pwd${i}`];
		if (ip || port || pwd) legacy.push({ id: genServerId(), name: `OBS #${i}`, ip, port, pwd });
	}
	return legacy;
}

/**
 * Fold the legacy global ingestAlias__<name> / ingestCategory__<name> settings into every IRLTK
 * server's own ingestAlias/ingestCategory (the server's own values win). The General Configuration
 * window drops the global keys the next time it saves, so this only matters until then.
 * @param {Record<string, any>} settings Global settings
 * @param {Record<string, any>[]} servers
 * @returns {Record<string, any>[]}
 */
function migrateGlobalIngestAliases(settings, servers) {
	const alias = {};
	const category = {};
	Object.entries(settings).forEach(([key, value]) => {
		if (!value) return;
		const aliasMatch = key.match(/^ingestAlias__(.+)$/);
		if (aliasMatch) alias[aliasMatch[1]] = value;
		const categoryMatch = key.match(/^ingestCategory__(.+)$/);
		if (categoryMatch) category[categoryMatch[1]] = value;
	});
	if (!Object.keys(alias).length && !Object.keys(category).length) return servers;
	return servers.map((server) => (server.irltk === 'true'
		? { ...server, ingestAlias: { ...alias, ...server.ingestAlias }, ingestCategory: { ...category, ...server.ingestCategory } }
		: server));
}

/**
 * Fetch a streamer's ingest settings from the 1a3.uk userscript-settings public API
 * @param {string} streamerName
 */
export async function fetchStreamerIngests(streamerName) {
	const response = await fetch(`https://1a3.uk/api/mediamtx/userscript-settings/${encodeURIComponent(streamerName)}/public`);
	if (!response.ok) throw new Error(`HTTP ${response.status}`);
	const data = await response.json();
	const ingests = data?.settings?.ingests;
	if (!data?.success || !ingests || typeof ingests !== 'object') throw new Error('Unexpected response format');
	return ingests;
}

/**
 * Turn a streamer's ingest settings into a server's pinned ingests (the streamer's own ingests),
 * aliases/categories (every ingest with a label/category) and linked scenes (ingest name -> scene)
 * @param {Record<string, any>} ingests
 * @returns {{ ingestPinned: string[], ingestAlias: Record<string, string>, ingestCategory: Record<string, string>, ingestScene: Record<string, string> }}
 */
export function parseStreamerIngests(ingests) {
	const ingestPinned = [];
	const ingestAlias = {};
	const ingestCategory = {};
	const ingestScene = {};
	Object.entries(ingests).forEach(([name, info]) => {
		if (info?.mine === true) ingestPinned.push(name);
		const label = typeof info?.label === 'string' ? info.label.trim() : '';
		const rawCategory = typeof info?.category === 'string' ? info.category.trim().toLowerCase() : '';
		const scene = typeof info?.scene === 'string' ? info.scene.trim() : '';
		if (label) ingestAlias[name] = label;
		if (INGEST_CATEGORIES.includes(rawCategory)) ingestCategory[name] = rawCategory;
		if (scene) ingestScene[name] = scene;
	});
	return { ingestPinned, ingestAlias, ingestCategory, ingestScene };
}

/**
 * Keep whichever copy of each server's plugin-maintained data is newest, so a save from a stale
 * General Configuration window can't wipe what the plugin fetched/cached in the meantime: the
 * streamer data (by streamerFetchedAt, only while the streamer is unchanged) and lastKnownScenes
 * @param {Record<string, any>[]} servers Servers about to be saved
 * @param {Record<string, any>[]} latestServers Servers as last received from the plugin
 * @returns {Record<string, any>[]}
 */
export function keepNewestPluginData(servers, latestServers) {
	return servers.map((server) => {
		const latest = latestServers.find((s) => s.id === server.id);
		if (!latest) return server;
		let merged = server.lastKnownScenes === undefined && latest.lastKnownScenes !== undefined
			? { ...server, lastKnownScenes: latest.lastKnownScenes }
			: server;
		if (server.streamer && latest.streamer === server.streamer && (latest.streamerFetchedAt ?? 0) > (server.streamerFetchedAt ?? 0)) {
			const { ingestPinned, ingestAlias, ingestCategory, ingestScene, streamerFetchedAt } = latest;
			merged = { ...merged, ingestPinned, ingestAlias, ingestCategory, ingestScene, streamerFetchedAt };
		}
		return merged;
	});
}

/**
 * Remove the legacy global ingest alias/category keys (now stored per server)
 * @param {Record<string, any>} settings Global settings
 * @returns {Record<string, any>}
 */
export function stripGlobalIngestAliases(settings) {
	return Object.fromEntries(Object.entries(settings).filter(([key]) => !/^ingest(Alias|Category)__/.test(key)));
}
