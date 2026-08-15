import { INGEST_PROFILE_NAMES } from '../shared/constants.js';
import { resolveServers } from '../shared/servers.js';
import { FormUtils, localizeUI } from './utils.js';

function escapeHtml(str) {
	return str.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[c]));
}

function getEligibleServers(globalSettings) {
	return resolveServers(globalSettings)
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

const INGEST_PROFILE_DEVICE_TYPES = Object.keys(INGEST_PROFILE_NAMES).map(Number);

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
