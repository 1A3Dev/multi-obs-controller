import { MAX_SERVERS } from '../plugin/sockets';
import { DidReceiveGlobalSettingsData, GlobalSettings, ServerConfig } from './types';

export let globalSettings: GlobalSettings = {};

$SD.onDidReceiveGlobalSettings(({ payload }: DidReceiveGlobalSettingsData<GlobalSettings>) => {
	globalSettings = payload.settings;
});

export function genServerId(): string {
	return `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export function resolveServers(settings: GlobalSettings): ServerConfig[] {
	if (settings.servers?.length) return settings.servers.map((server) => (server.id ? server : { ...server, id: genServerId() }));

	const legacy: ServerConfig[] = [];
	for (let i = 1; i <= MAX_SERVERS; i++) {
		const ip = settings[`ip${i}`];
		const port = settings[`port${i}`];
		const pwd = settings[`pwd${i}`];
		if (ip || port || pwd) legacy.push({ id: genServerId(), name: `OBS #${i}`, ip, port, pwd });
	}
	if (legacy.length) return legacy;

	return [{ id: genServerId(), name: 'OBS #1' }, { id: genServerId(), name: 'OBS #2' }];
}

export function resolveTargetIndex(target: string | undefined, servers: ServerConfig[]): number {
	if (!target || target === '0') return 0;
	const byId = servers.findIndex((server) => server.id === target);
	if (byId !== -1) return byId + 1;
	const legacyIndex = parseInt(target, 10);
	return Number.isInteger(legacyIndex) ? legacyIndex : 0;
}

export function resolveTargetIndices(target: string | string[] | undefined, servers: ServerConfig[]): number[] {
	if (Array.isArray(target)) {
		return target
		.map((t) => resolveTargetIndex(t, servers))
		.filter((index) => index > 0);
	}
	if (!target || target === '0') return servers.map((_, i) => i + 1);
	const index = resolveTargetIndex(target, servers);
	return index > 0 ? [index] : [];
}

export function resolveTargetIds(target: string | string[] | undefined, servers: ServerConfig[]): string[] {
	return resolveTargetIndices(target, servers)
	.map((index) => servers[index - 1]?.id)
	.filter((id): id is string => !!id);
}