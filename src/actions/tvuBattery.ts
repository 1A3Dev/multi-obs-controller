import { globalSettings } from './globalSettings';
import { TvuCreds, TvuDevice, tvuFetchAllDevices } from './tvu/tvuApi';
import { SDUtils } from '../plugin/utils';

/** How often linked TVU packs are re-checked for their current battery level */
const POLL_INTERVAL_MS = 60_000;

function getCreds(): TvuCreds | undefined {
	const { tvuEmail, tvuPassword, tvuAppKey, tvuAppSecret } = globalSettings;
	if (!tvuEmail || !tvuPassword || !tvuAppKey || !tvuAppSecret) return undefined;
	return { email: tvuEmail, password: tvuPassword, appKey: tvuAppKey, appSecret: tvuAppSecret };
}

// context -> linked TVU device identifier (matched against a device's name, id or peerId, same as
// the original getDevice endpoint did), and the reverse cache of last known battery reading per
// identifier - kept separate since multiple contexts can link the same physical pack
const linksByContext = new Map<string, string>();
const batteryByDevice = new Map<string, number | undefined>();
const listeners = new Set<() => void>();

let pollTimer: ReturnType<typeof setInterval> | undefined;
let pollInFlight: Promise<void> | undefined;

/** Subscribe to battery readings changing for any linked device - callback re-derives whatever it needs from getTvuBatteryPercent */
export function onTvuBatteryUpdated(callback: () => void): void {
	listeners.add(callback);
}

export function getTvuBatteryPercent(deviceId: string): number | undefined {
	return batteryByDevice.get(deviceId);
}

/** Link (or unlink, by passing undefined/empty) a context to a TVU device identifier - its name, id or peerId */
export function setTvuDeviceLink(context: string, deviceId: string | undefined): void {
	const trimmed = deviceId?.trim() || undefined;
	if (linksByContext.get(context) === trimmed) return;
	if (trimmed) linksByContext.set(context, trimmed);
	else linksByContext.delete(context);

	if (linksByContext.size === 0) {
		if (pollTimer) {
			clearInterval(pollTimer);
			pollTimer = undefined;
		}
		return;
	}
	if (!pollTimer) pollTimer = setInterval(() => void poll(), POLL_INTERVAL_MS);
	// A newly-linked device with no cached reading yet gets checked right away instead of waiting for
	// the next scheduled tick, which could be up to a full minute away
	if (trimmed && !batteryByDevice.has(trimmed)) void poll();
}

function extractBatteryPercent(device: TvuDevice): number | undefined {
	const info = device.batteryInfo;
	if (typeof info === 'number') return info;
	if (info && typeof info === 'object') {
		for (const key of ['percentage', 'percent', 'level', 'battery', 'capacity']) {
			const value = (info as Record<string, unknown>)[key];
			if (typeof value === 'number') return value;
		}
	}
	return undefined;
}

async function poll(): Promise<void> {
	if (pollInFlight) return pollInFlight;
	pollInFlight = (async () => {
		const neededIds = new Set(linksByContext.values());
		// Drop cached readings for devices nothing links to anymore
		[...batteryByDevice.keys()].forEach(id => { if (!neededIds.has(id)) batteryByDevice.delete(id); });
		if (neededIds.size === 0) return;

		const creds = getCreds();
		if (!creds) {
			let changed = false;
			neededIds.forEach(id => {
				if (batteryByDevice.has(id)) changed = true;
				batteryByDevice.delete(id);
			});
			if (changed) listeners.forEach(fn => fn());
			return;
		}

		try {
			const devices = await tvuFetchAllDevices(creds);
			const byIdentifier = new Map<string, TvuDevice>();
			devices.forEach(device => {
				if (device.name) byIdentifier.set(device.name, device);
				if (device.id) byIdentifier.set(device.id, device);
				if (device.peerId) byIdentifier.set(device.peerId as string, device);
			});

			let changed = false;
			neededIds.forEach(id => {
				const device = byIdentifier.get(id);
				if (!device) SDUtils.log(`TVU device not found: ${id}`, 'warn');
				const percent = device ? extractBatteryPercent(device) : undefined;
				if (batteryByDevice.get(id) !== percent) changed = true;
				batteryByDevice.set(id, percent);
			});
			if (changed) listeners.forEach(fn => fn());
		}
		catch (e) {
			SDUtils.log(`Error polling TVU device battery levels: ${e}`, 'error');
		}
	})();
	try {
		await pollInFlight;
	}
	finally {
		pollInFlight = undefined;
	}
}
