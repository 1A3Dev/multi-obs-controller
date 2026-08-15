import { FormUtils, localizeUI } from './utils.js';

const MAX_SERVERS = 6;

function escapeHtml(str) {
	return str.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[c]));
}

function genServerId() {
	return `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

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

function getEligibleServers(globalSettings) {
	return resolveServersFromSettings(globalSettings)
	.map((server, i) => ({ index: i + 1, server }))
	.filter(({ server }) => server.irltk === 'true');
}

function legacyIndexToId(rawValue, eligibleServers) {
	const legacyIndex = parseInt(rawValue, 10);
	return eligibleServers.find((o) => o.index === legacyIndex)?.server.id;
}

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

const INGEST_PROFILE_DEVICE_TYPES = [7, 13];

function renderDeviceOptions(devices, currentDeviceId, currentValue) {
	const currentDeviceSupported = INGEST_PROFILE_DEVICE_TYPES.includes(devices.find((device) => device.id === currentDeviceId)?.type);
	const otherDevices = devices.filter((device) => INGEST_PROFILE_DEVICE_TYPES.includes(device.type) && device.id !== currentDeviceId);
	const select = document.querySelector('#deviceOptions');
	const resolvedCurrent = otherDevices.some((device) => device.id === currentValue)
		? currentValue
		: (currentDeviceSupported ? '' : (otherDevices[0]?.id ?? ''));
	select.innerHTML = [
		...(currentDeviceSupported ? ['<option value="">This Device</option>'] : []),
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

	form.addEventListener('input', Utils.debounce(150, () => {
		$PI.setSettings(FormUtils.getFormValue(form));
	}));

	if (!form.querySelector('input[name="server"]:checked') && eligibleServers.length) {
		form.querySelector(`input[name="server"][value="${eligibleServers[0].server.id}"]`).checked = true;
		form.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
	}

	localizeUI();
	document.querySelector('.sdpi-wrapper').style.visibility = 'visible';
});
