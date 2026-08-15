import { FormUtils, localizeUI } from './utils.js';

// Must match MAX_SERVERS in src/plugin/sockets.ts
const MAX_SERVERS = 6;

function escapeHtml(str) {
	return str.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[c]));
}

// Short random id for a newly-created server - mirrors genServerId() in src/actions/globalSettings.ts
// (duplicated here since this file isn't part of the plugin's TS bundle). Non-numeric so it never
// collides with a legacy plain-index `server` value (see legacyIndexToId)
function genServerId() {
	return `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

// Resolve the configured server list, migrating in-memory from the legacy flat ip{n}/port{n}/pwd{n}
// keys (pre-dynamic-server-list) if no `servers` array has been saved yet, and backfilling a stable
// `id` onto any server that doesn't have one yet. Mirrors resolveServers() in
// src/actions/globalSettings.ts - duplicated here since this file isn't part of the plugin's TS bundle
// (same pattern as inspector.js/configuration.js)
function resolveServersFromSettings(settings) {
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

// Only servers flagged "IRLTK" are valid - this action only ever overrides IRLTK-only ingest actions
function getEligibleServers(globalSettings) {
	return resolveServersFromSettings(globalSettings)
	.map((server, i) => ({ index: i + 1, server }))
	.filter(({ server }) => server.irltk === 'true');
}

// Translate a legacy plain-index `server` value (from before servers had stable ids) to the id of
// whichever eligible server currently sits at that position, or undefined if none does
function legacyIndexToId(rawValue, eligibleServers) {
	const legacyIndex = parseInt(rawValue, 10);
	return eligibleServers.find((o) => o.index === legacyIndex)?.server.id;
}

// Radio values are each server's stable id (not its position) so a saved server survives reordering
function renderServerOptions(eligibleServers, currentValue) {
	document.querySelector('#noServersNotice').style.display = eligibleServers.length ? 'none' : '';
	const resolvedCurrent = eligibleServers.some(({ server }) => server.id === currentValue)
		? currentValue
		: legacyIndexToId(currentValue, eligibleServers);
	document.querySelector('#serverOptions').innerHTML = eligibleServers.map(({ index, server }) => `
		<input id="server${server.id}" type="radio" name="server" value="${server.id}" ${server.id === resolvedCurrent ? 'checked' : ''}>
		<label for="server${server.id}"><span></span>${escapeHtml(server.name || `OBS #${index}`)}</label>
	`).join('');
}

const STREAMDECK_PLUS_DEVICE_TYPE = 7;

function renderDeviceOptions(devices, currentDeviceId, currentValue) {
	const currentDeviceIsPlus = devices.find((device) => device.id === currentDeviceId)?.type === STREAMDECK_PLUS_DEVICE_TYPE;
	const otherDevices = devices.filter((device) => device.type === STREAMDECK_PLUS_DEVICE_TYPE && device.id !== currentDeviceId);
	const select = document.querySelector('#deviceOptions');
	const resolvedCurrent = (currentDeviceIsPlus && !currentValue) || otherDevices.some((device) => device.id === currentValue)
		? currentValue
		: (otherDevices[0]?.id ?? '');
	select.innerHTML = [
		...(currentDeviceIsPlus ? ['<option value="">This Device</option>'] : []),
		...otherDevices.map((device, i) => `<option value="${device.id}">${escapeHtml(device.name || `Device ${i + 1}`)}</option>`),
	].join('');
	select.value = resolvedCurrent;
}

$PI.onConnected(async ({ actionInfo, appInfo }) => {
	const { payload, device: currentDeviceId } = actionInfo;
	const { settings } = payload;
	const form = document.querySelector('#action-fields');

	$PI.getGlobalSettings();
	const globalSettings = await new Promise((resolve) => {
		$PI.onDidReceiveGlobalSettings(({ payload: gsPayload }) => resolve(gsPayload.settings));
	});

	const eligibleServers = getEligibleServers(globalSettings);
	renderServerOptions(eligibleServers, settings.server);
	renderDeviceOptions(appInfo?.devices ?? [], currentDeviceId, settings.device);
	FormUtils.setFormValue(settings, form);

	// Registered before the auto-select default below dispatches its synthetic "input" event, so that
	// event actually gets caught and saved - otherwise the auto-picked server only ever exists in the
	// DOM, never persisted, until the user happens to touch the form themselves
	form.addEventListener('input', Utils.debounce(150, () => {
		$PI.setSettings(FormUtils.getFormValue(form));
	}));

	// Default to the first eligible server if none is selected yet (e.g. this button was just added)
	if (!form.querySelector('input[name="server"]:checked') && eligibleServers.length) {
		form.querySelector(`input[name="server"][value="${eligibleServers[0].server.id}"]`).checked = true;
		form.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
	}

	localizeUI();
	document.querySelector('.sdpi-wrapper').style.visibility = 'visible';
});
