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
	if (Array.isArray(settings.servers) && settings.servers.length) {
		return settings.servers.map((server) => (server.id ? server : { ...server, id: genServerId() }));
	}

	const legacy = [];
	for (let i = 1; i <= MAX_SERVERS; i++) {
		const ip = settings[`ip${i}`];
		const port = settings[`port${i}`];
		const pwd = settings[`pwd${i}`];
		if (ip || port || pwd) legacy.push({ id: genServerId(), name: `OBS #${i}`, ip, port, pwd });
	}
	if (legacy.length) return legacy;

	return [{ id: genServerId(), name: 'OBS #1' }, { id: genServerId(), name: 'OBS #2' }];
}
