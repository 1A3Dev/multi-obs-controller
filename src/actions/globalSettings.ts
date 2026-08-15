import { resolveServers as resolveSharedServers } from '../shared/servers';
import { DidReceiveGlobalSettingsData, GlobalSettings, ServerConfig } from './types';

export let globalSettings: GlobalSettings = {};

$SD.onDidReceiveGlobalSettings(({ payload }: DidReceiveGlobalSettingsData<GlobalSettings>) => {
	globalSettings = payload.settings;
});

export function resolveServers(settings: GlobalSettings): ServerConfig[] {
	return resolveSharedServers(settings) as ServerConfig[];
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