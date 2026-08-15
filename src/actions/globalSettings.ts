import { MAX_SERVERS } from '../plugin/sockets';
import { DidReceiveGlobalSettingsData, GlobalSettings, ServerConfig } from './types';

export let globalSettings: GlobalSettings = {};

$SD.onDidReceiveGlobalSettings(({ payload }: DidReceiveGlobalSettingsData<GlobalSettings>) => {
	globalSettings = payload.settings;
});

/**
 * Short random id for a newly-created server - not persisted by this function itself, just generated
 * for a caller (resolveServers()'s in-memory backfill, or a PI's own new/legacy row) to attach and save.
 * Deliberately non-numeric so it can never collide with a legacy plain-index target value (see
 * resolveTargetIndex)
 */
export function genServerId(): string {
	return `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Resolve the configured server list from Global Settings, migrating in-memory from the legacy
 * flat ip{n}/port{n}/pwd{n} keys (pre-dynamic-server-list) if no `servers` array has been saved yet.
 * Falls back to two empty, default-named slots for a fresh install, matching the old out-of-box UI.
 * Also backfills a stable `id` onto any server that doesn't have one yet (pre-dates per-server ids,
 * or was just migrated from the legacy flat keys above) - callers that can persist settings (see
 * app.ts) are expected to save the backfilled ids back so they stop being re-randomized on every call
 */
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

/**
 * Resolve a persisted target value - a server's stable `id`, the literal '0' (All), or (from before
 * per-server ids existed) a plain 1-based position - to that server's CURRENT 1-based position, or 0
 * for All/unresolvable. Reordering `servers` never invalidates an id-based target since it's looked up
 * by identity, not position; a legacy plain-index target is still interpreted positionally exactly as
 * before (so already-saved buttons keep working) until it's resaved as an id by the property inspector
 */
export function resolveTargetIndex(target: string | undefined, servers: ServerConfig[]): number {
	if (!target || target === '0') return 0;
	const byId = servers.findIndex((server) => server.id === target);
	if (byId !== -1) return byId + 1;
	const legacyIndex = parseInt(target, 10);
	return Number.isInteger(legacyIndex) ? legacyIndex : 0;
}

/**
 * Resolve a persisted multi-select target value to the CURRENT 1-based positions of every server it
 * refers to. Accepts the current array-of-ids shape (each resolved the same way as resolveTargetIndex,
 * including its legacy-position fallback) as well as older single-value shapes from before multi-select
 * existed: a lone id/legacy position (-> that one server), or '0'/empty (the old "All" - every server
 * position, unfiltered; per-action eligibility is applied separately downstream)
 */
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

/**
 * Same as resolveTargetIndices, but resolved to the CURRENT stable `id` of every referenced server
 * instead of its position - used to rewrite a legacy positional target into its reorder-safe id-array
 * equivalent (see AbstractBaseWsAction's settings migration)
 */
export function resolveTargetIds(target: string | string[] | undefined, servers: ServerConfig[]): string[] {
	return resolveTargetIndices(target, servers)
	.map((index) => servers[index - 1]?.id)
	.filter((id): id is string => !!id);
}