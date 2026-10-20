import { SDUtils } from '../plugin/utils';
import { fetchStreamerIngests, parseStreamerIngests } from '../shared/servers';
import { globalSettings, resolveServers } from './globalSettings';
import { ServerConfig } from './types';

const REFRESH_INTERVAL_MS = 15 * 60 * 1000;

let started = false;
let refreshing = false;

function streamerDataEqual(server: ServerConfig, data: ReturnType<typeof parseStreamerIngests>): boolean {
	const pinned = Array.isArray(server.ingestPinned) ? server.ingestPinned : server.ingestPinned ? [server.ingestPinned] : [];
	return JSON.stringify(pinned) === JSON.stringify(data.ingestPinned)
		&& JSON.stringify(server.ingestAlias ?? {}) === JSON.stringify(data.ingestAlias)
		&& JSON.stringify(server.ingestCategory ?? {}) === JSON.stringify(data.ingestCategory)
		&& JSON.stringify(server.ingestScene ?? {}) === JSON.stringify(data.ingestScene);
}

/**
 * Re-fetch the streamer's settings for every IRLTK server with a streamer set, persisting them to
 * global settings (only when something changed) so they survive a Stream Deck restart
 */
async function refreshStreamers() {
	if (refreshing) return;
	refreshing = true;
	try {
		const targets = resolveServers(globalSettings).filter((server) => server.irltk === 'true' && server.streamer?.trim());
		if (!targets.length) return;

		const results = await Promise.allSettled(targets.map(async (server) => {
			const streamer = server.streamer!.trim();
			return { id: server.id, streamer, data: parseStreamerIngests(await fetchStreamerIngests(streamer)) };
		}));
		results.forEach((result, i) => {
			if (result.status === 'rejected') SDUtils.log(`Failed to refresh streamer settings for ${targets[i].streamer}: ${result.reason}`);
		});

		// Settings may have changed while fetching - apply onto the latest ones, skipping any server whose streamer changed
		let changed = false;
		const servers = resolveServers(globalSettings).map((server) => {
			const result = results.find((r) => r.status === 'fulfilled' && r.value.id === server.id);
			if (result?.status !== 'fulfilled' || server.streamer?.trim() !== result.value.streamer) return server;
			if (streamerDataEqual(server, result.value.data)) return server;
			changed = true;
			return { ...server, ...result.value.data, streamerFetchedAt: Date.now() };
		});
		if (!changed) return;

		$SD.setGlobalSettings({ ...globalSettings, servers });
		// Not echoed back to the plugin by itself - request it so every action picks up the new data
		$SD.getGlobalSettings();
	}
	finally {
		refreshing = false;
	}
}

$SD.onDidReceiveGlobalSettings(() => {
	if (started) return;
	started = true;
	refreshStreamers();
	setInterval(refreshStreamers, REFRESH_INTERVAL_MS);
});
