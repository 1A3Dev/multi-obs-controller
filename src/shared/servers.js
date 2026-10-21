// Shared between the plugin (bundled by webpack) and the property inspector (loaded as plain ES modules)
import { MAX_SERVERS } from './constants.js';

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
 * Keep the plugin-maintained data of each server, so a save from a stale General Configuration
 * window can't wipe what the plugin cached in the meantime (lastKnownScenes)
 * @param {Record<string, any>[]} servers Servers about to be saved
 * @param {Record<string, any>[]} latestServers Servers as last received from the plugin
 * @returns {Record<string, any>[]}
 */
export function keepNewestPluginData(servers, latestServers) {
	return servers.map((server) => {
		const latest = latestServers.find((s) => s.id === server.id);
		if (!latest) return server;
		return server.lastKnownScenes === undefined && latest.lastKnownScenes !== undefined
			? { ...server, lastKnownScenes: latest.lastKnownScenes }
			: server;
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
