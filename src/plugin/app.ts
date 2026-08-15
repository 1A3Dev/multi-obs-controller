import { resolveServers } from '../actions/globalSettings';
import * as pluginActions from '../actions/index';
import { DidReceiveGlobalSettingsData, GlobalSettings } from '../actions/types';
import { sockets } from './sockets';
import { SDUtils } from './utils';

// Initialize all plugin actions
for (const PluginAction of Object.values(pluginActions)) {
	new PluginAction();
}

// SD starts
$SD.onConnected(({ appInfo }: any) => {
	SDUtils.log(`Stream Deck connected (v${appInfo.application.version}) | ${appInfo.application.platform} ${appInfo.application.platformVersion} | Plugin version ${appInfo.plugin.version}`);
	$SD.getGlobalSettings();

	// Check OBS WS connections every 10s
	setInterval(() => {
		sockets.forEach(socket => socket.tryConnect());
	}, 10 * 1000);
});

// Global settings received
$SD.onDidReceiveGlobalSettings(({ payload }: DidReceiveGlobalSettingsData<GlobalSettings>) => {
	const { settings } = payload;
	SDUtils.debugEnabled = settings.debug === 'enabled';
	const servers = resolveServers(settings);
	sockets.forEach((socket, idx) => {
		const server = servers[idx];
		socket.updateSettings(server?.ip ?? '', server?.port ?? '', server?.pwd, server?.secure === 'true');
	});

	// One-time migration: persist the resolved `servers` array (with each server's id assigned, and
	// any legacy flat ip{n}/port{n}/pwd{n} keys folded in) the moment it doesn't already match what's
	// saved, so ids stop being re-randomized by resolveServers() on every settings read from here on.
	// setGlobalSettings round-trips back through this same handler, so this only ever fires once
	if (!settings.servers?.length || settings.servers.some((server) => !server.id)) {
		const migrated: GlobalSettings = { ...settings, servers };
		Object.keys(migrated).forEach((key) => {
			if (/^(ip|port|pwd)\d+$/.test(key)) delete migrated[key as keyof GlobalSettings];
		});
		$SD.setGlobalSettings(migrated);
	}
});