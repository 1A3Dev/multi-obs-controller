// / <reference path="../libs/js/property-inspector.js" />
// / <reference path="../libs/js/utils.js" />
import { FormUtils, localizeUI } from './utils.js';

const MAX_SERVERS = 6;
const IRLTK_ONLY_ACTIONS = new Set(['irltkingeststatus', 'irltkingestvolume', 'irltkingestscene', 'irltkingestpageprev', 'irltkingestpagenext', 'irltkingestpagenumber']);
const IRLTK_EXCLUDED_ACTIONS = new Set(['togglereplaybuffer', 'savereplaybuffer', 'togglerecord', 'togglestream', 'togglevirtualcam', 'setprofile', 'refreshcapturedevice']);
const NO_TARGET_ACTIONS = new Set(['irltkingestpageprev', 'irltkingestpagenext', 'irltkingestpagenumber', 'previousprofile']);
const DYNAMIC_TARGET_ACTIONS = new Set(['triggerstudiomodetransition']);
const forms = new Map(); // common form and per OBS instance forms
let globalSettings = {};
let pendingGlobalListsResolvers = [];
let isNoTargetAction = false;

function isTargetless() {
	return isNoTargetAction || !!document.querySelector('#dynamicTargetCheck')?.checked;
}

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

function getEligibleServers(actionName, servers) {
	return servers
	.map((server, i) => ({ index: i + 1, server }))
	.filter(({ server }) => {
		const isIrltk = server.irltk === 'true';
		if (IRLTK_ONLY_ACTIONS.has(actionName)) return isIrltk;
		if (IRLTK_EXCLUDED_ACTIONS.has(actionName)) return !isIrltk;
		return true;
	});
}

function resolveCheckedIds(rawTarget, eligibleServers) {
	const eligibleIds = eligibleServers.map(({ server }) => server.id);
	if (Array.isArray(rawTarget)) return rawTarget.filter((id) => eligibleIds.includes(id));
	if (!rawTarget || rawTarget === '0') return eligibleIds;
	if (eligibleIds.includes(rawTarget)) return [rawTarget];
	const legacyIndex = parseInt(rawTarget, 10);
	const match = eligibleServers.find((o) => o.index === legacyIndex);
	return match ? [match.server.id] : [];
}

function renderTargetOptions(eligibleServers) {
	const container = document.querySelector('#targetOptions');
	const options = eligibleServers.map(({ index, server }) => ({ value: server.id, label: server.name || `OBS #${index}` }));
	container.innerHTML = options.map(({ value, label }) => `
		<input id="obs${value}" type="checkbox" name="target" value="${value}">
		<label for="obs${value}"><span></span>${escapeHtml(label)}</label>
	`).join('');
	return options;
}

// Initialization when PI connects
$PI.onConnected(async (jsn) => {
	const { actionInfo } = jsn;
	const { payload, action } = actionInfo;
	const { settings } = payload;
	const actionName = action.split('.').at(-1);
	isNoTargetAction = NO_TARGET_ACTIONS.has(actionName);
	const isDynamicTargetAction = DYNAMIC_TARGET_ACTIONS.has(actionName);

	$PI.getGlobalSettings();

	$PI.onSendToPropertyInspector(action, ({ payload: sentPayload }) => {
		if (sentPayload.event !== 'GlobalListsLoaded') return;
		pendingGlobalListsResolvers.forEach((resolve) => resolve(sentPayload));
		pendingGlobalListsResolvers = [];
	});

	globalSettings = await new Promise((resolve) => {
		$PI.onDidReceiveGlobalSettings(({ payload: gsPayload }) => resolve(gsPayload.settings));
	});
	const servers = resolveServersFromSettings(globalSettings);
	const eligibleServers = getEligibleServers(actionName, servers);
	const targetOptions = renderTargetOptions(eligibleServers);

	let settingsForForms = settings;
	if (settings.common?.target !== undefined) {
		const resolvedTargetIds = resolveCheckedIds(settings.common.target, eligibleServers);
		settingsForForms = { ...settings, common: { ...settings.common, target: resolvedTargetIds } };
	}

	// Insert tabs and action fields
	const { fields, generateFields } = await import(`../actions/${actionName}/fields.js`)
	.catch(() => { console.log('No custom fields loaded'); return {}; });
	if (fields || generateFields) {
		const tabs = [];
		const tabsContents = [];
		settingsForForms = { ...settingsForForms };
		for (const { index, server } of eligibleServers) {
			const { id } = server;
			const legacyKey = `params${index}`;
			const idKey = `params_${id}`;
			const resolvedParams = settings[idKey] ?? settings[legacyKey] ?? {};
			settingsForForms[idKey] = resolvedParams;
			settingsForForms[legacyKey] = resolvedParams;

			tabs.push(`
				<div class="tab" data-target="#tab_${id}">
					${escapeHtml(server.name || `OBS ${index}`)}
				</div>
			`);
			tabsContents.push(`
				<div id="tab_${id}" class="tab-container" data-id="${id}" data-index="${index}" data-socket-idx="${index - 1}">
					<form id="action-fields-${id}">
						${indexHtmlFields(fields ?? generateFields(resolvedParams), id)}
					</form>
				</div>
			`);
			forms.set(idKey, `#action-fields-${id}`);
			forms.set(legacyKey, `#action-fields-${id}`);
		}

		const sharedParams = settings.params_shared ?? settings.params1 ?? {};
		settingsForForms.params_shared = sharedParams;
		tabsContents.push(`
			<div id="tab_shared" class="tab-container">
				<form id="action-fields-shared">
					${indexHtmlFields(fields ?? generateFields(sharedParams), 'shared')}
				</form>
			</div>
		`);
		forms.set('params_shared', '#action-fields-shared');
		forms.set('params1', '#action-fields-shared');

		document.querySelector('.tabs').innerHTML = tabs.join('');
		document.querySelector('.tabs-contents').innerHTML = tabsContents.join('');
		activateTabs();
		document.querySelector('#first-separator').style.display = 'block';
	}
	else {
		document.querySelector('#indivParams').style.display = 'none'; // hide indiv params box if not fields
	}

	// Load all forms with action settings
	forms.set('common', '#common-fields');
	forms.set('advanced', '#advanced-fields');
	initForms(settingsForForms);

	if (isNoTargetAction) {
		document.querySelector('#target').style.display = 'none';
		const footerDetails = document.querySelector('#footer > details');
		if (footerDetails) footerDetails.style.display = 'none';
		const indivCheck = document.querySelector('#indivParamsCheck');
		if (indivCheck.checked) {
			indivCheck.checked = false;
			document.querySelector('#common-fields').dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
		}
	}
	else if (isDynamicTargetAction) {
		document.querySelector('#dynamicTarget').style.display = 'flex';
		document.querySelector('#target').style.display = document.querySelector('#dynamicTargetCheck').checked ? 'none' : '';
	}

	if (!isTargetless() && !document.querySelector('input[name="target"]:checked')) {
		const wantedIds = resolveCheckedIds(globalSettings.defaultTarget, eligibleServers);
		const toCheck = wantedIds.length ? wantedIds : (targetOptions[0] ? [targetOptions[0].value] : []);
		if (toCheck.length) {
			toCheck.forEach((id) => {
				const el = document.querySelector(`input[name="target"][value="${id}"]`);
				if (el) el.checked = true;
			});
			document.querySelector('#common-fields').dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
		}
	}

	onTargetChange();
	Array.from(document.querySelectorAll('#target input')).forEach((i) => {
		i.addEventListener('click', (e) => {
			if (!e.target.checked && !document.querySelector('input[name="target"]:checked')) {
				e.preventDefault();
			}
		});
		i.addEventListener('change', () => onTargetChange());
	});
	document.querySelector('#indivParamsCheck').addEventListener('change', () => updateTargetTabs());

	// Hide long press options if inside multiaction (not supported)
	$PI.onDidReceiveSettings(action, ({ payload: receiveSettingsPayload }) => {
		if (receiveSettingsPayload.isInMultiAction) {
			document.querySelector('#longPress').style.display = 'none';
			document.querySelector('#customImgDiv').style.display = 'none';
		}
	});
	$PI.getSettings();

	// Load custom action PI JS, if it exists
	await import(`../actions/${actionName}/pi.js`).catch(() => console.log('No custom action JS loaded'));

	// Signal plugin that PI is ready after importing everything
	$PI.sendToPlugin({ event: 'ready' });

	// Localize UI
	localizeUI();

	// Show PI contents
	document.querySelector('.sdpi-wrapper').style.visibility = 'visible';
});

// Update global settings variable on change
$PI.onDidReceiveGlobalSettings(({ payload }) => {
	globalSettings = payload.settings;
	document.querySelector('#longPressMs').placeholder = globalSettings.longPressMs;
});

// Dynamic target (Open Ingest Profile server) toggle
document.querySelector('#dynamicTargetCheck').addEventListener('change', (e) => {
	document.querySelector('#target').style.display = e.target.checked ? 'none' : '';
	const indivCheck = document.querySelector('#indivParamsCheck');
	if (e.target.checked && indivCheck.checked) {
		indivCheck.checked = false;
	}
	onTargetChange();
});

// Open external configuration window
document.querySelector('#open-config').addEventListener('click', () => {
	window.open('./configuration.html');
});

// Custom image picker functions/listeners
document.querySelector('input[name="customImg"]').addEventListener('click', (e) => {
	e.preventDefault();
	document.querySelector('#customImgFilePicker').click();
});

document.querySelector('#customImgFilePicker').addEventListener('input', (e) => {
	const imgPath = decodeURIComponent(e.target.value.replace(/^C:\\fakepath\\/, ''));

	if (imgPath) {
		const img = new Image();
		img.onload = function() {
			let x, y, width, height;
			if (this.width < 72 && this.height < 72) {
				width = this.width * 2;
				height = this.height * 2;
				x = Math.floor(72 - width / 2);
				y = Math.floor(72 - height / 2);
			}
			else if (this.width > this.height) {
				width = 144;
				height = Math.floor(this.height * 144 / this.width);
				x = 0;
				y = Math.floor(72 - height / 2);
			}
			else {
				height = 144;
				width = Math.floor(this.width * 144 / this.height);
				y = 0;
				x = Math.floor(72 - width / 2);
			}
			document.querySelector('input[name="customImg"]').value = imgPath;
			document.querySelector('input[name="customImgPos"]').value = [x, y, width, height].join(',');
			document.querySelector('#advanced-fields').dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
		};
		img.onerror = function() {
			document.querySelector('input[name="customImg"]').placeholder = $PI.localize('Error loading image');
			setTimeout(() => {
				document.querySelector('input[name="customImg"]').placeholder = $PI.localize('No custom icon image set');
			}, 3000);
		};
		img.src = imgPath;
	}
});

document.querySelector('#customImgRemoveButton').addEventListener('click', (e) => {
	e.preventDefault();
	document.querySelector('#customImgFilePicker').value = '';
	document.querySelector('input[name="customImg"]').value = '';
	document.querySelector('input[name="customImgPos"]').value = '';
	document.querySelector('#advanced-fields').dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
});
// --

// Custom bg colors
document.querySelectorAll('.colors button.icon-remove').forEach(el => el.addEventListener('click', (ev) => {
	ev.preventDefault();
	el.previousElementSibling.value = '#fefefe';
	document.querySelector('#advanced-fields').dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
}));

/**
 * Load all forms, and set listener to update settings on forms change
 * @param {object} settings Action settings
 */
function initForms(settings) {
	const saveAll = Utils.debounce(150, () => {
		let updatedSettings = {};
		forms.forEach((form, key) => {
			const formValue = FormUtils.getFormValue(form);
			if (Object.keys(formValue).length === 0 && formValue.constructor === Object) {
				return;
			}
			updatedSettings = { ...updatedSettings, [key]: formValue };
		});
		$PI.setSettings(updatedSettings);
	});

	const seenSelectors = new Set();
	forms.forEach((formSelector, settingsKey) => {
		const formEl = document.querySelector(formSelector);
		FormUtils.setFormValue(settings[settingsKey], formEl);

		if (seenSelectors.has(formSelector)) return;
		seenSelectors.add(formSelector);
		formEl.addEventListener('input', saveAll);
	});
}

/**
 * Updates an HTML string by adding unique indexes to id/for/list attributes
 * @param {string} fields Fields HTML string to modify
 * @param {number} index Index number to use
 * @returns Updated fields HTML string
 */
function indexHtmlFields(fields, index) {
	return fields.replace(/(id="|for="|list=")(\S+?)(")/g, `$1$2-${index}$3`);
}

/**
 * Window level functions to use in the external configuration window
 */
window.getGlobalSettings = () => {
	return globalSettings;
};

window.sendGlobalSettingsToInspector = (settings) => {
	$PI.setGlobalSettings(settings);
	globalSettings = settings;
	document.querySelector('#longPressMs').placeholder = globalSettings.longPressMs;
};

window.reconnect = () => {
	$PI.sendToPlugin({ event: 'reconnect' });
};

window.getGlobalLists = () => new Promise((resolve) => {
	pendingGlobalListsResolvers.push(resolve);
	$PI.sendToPlugin({ event: 'getGlobalLists' });
});

window.openUrl = (url) => {
	$PI.openUrl(url);
};

// --- Tabs logic ---
function activateTabs(activeTab) {
	const allTabs = Array.from(document.querySelectorAll('.tab'));
	let activeTabEl = null;
	allTabs.forEach((el) => {
		el.onclick = () => clickTab(el);
		if (el.dataset?.target === activeTab) {
			activeTabEl = el;
		}
	});
	if (activeTabEl) {
		clickTab(activeTabEl);
	}
	else if (allTabs.length) {
		clickTab(allTabs[0]);
	}
}

function clickTab(clickedTab) {
	const allTabs = Array.from(document.querySelectorAll('.tab'));
	allTabs.forEach((el) => el.classList.remove('selected'));
	clickedTab.classList.add('selected');
	allTabs.forEach((el) => {
		if (el.dataset.target) {
			const t = document.querySelector(el.dataset.target);
			if (t) {
				t.style.display = el == clickedTab ? 'block' : 'none';
			}
		}
	});
}

function updateTargetTabs() {
	const perServerTabs = Array.from(document.querySelectorAll('.tab'));
	const sharedTabEl = document.querySelector('#tab_shared');
	const indivParamsCheckbox = document.querySelector('#indivParamsCheck');

	if (isTargetless() || !indivParamsCheckbox.checked) {
		perServerTabs.forEach((t) => {
			t.classList.remove('selected');
			const content = document.querySelector(t.dataset.target);
			if (content) content.style.display = 'none';
		});
		if (sharedTabEl) sharedTabEl.style.display = 'block';
		document.querySelector('#tabs-header').style.display = 'none';
		return;
	}

	if (sharedTabEl) sharedTabEl.style.display = 'none';
	const checkedIds = Array.from(document.querySelectorAll('input[name="target"]:checked')).map((el) => el.value);
	perServerTabs.forEach((t) => {
		t.style.display = checkedIds.some((id) => t.dataset.target === `#tab_${id}`) ? '' : 'none';
	});
	const visibleTabs = perServerTabs.filter((t) => t.style.display !== 'none');
	clickTab(visibleTabs.find((t) => t.classList.contains('selected')) ?? visibleTabs[0] ?? perServerTabs[0]);
	document.querySelector('#tabs-header').style.display = visibleTabs.length > 1 ? 'block' : 'none';
}

function onTargetChange() {
	if (isTargetless()) {
		document.querySelector('#indivParams').style.display = 'none';
		updateTargetTabs();
		return;
	}

	const checkedTargets = Array.from(document.querySelectorAll('input[name="target"]:checked'));
	const tabs = Array.from(document.querySelectorAll('.tab'));
	if (!checkedTargets.length || !tabs.length) {
		document.querySelector('#indivParams').style.display = 'none';
		document.querySelector('#tabs-header').style.display = 'none';
		if (!tabs.length) return;
		tabs.forEach((t) => {
			const content = document.querySelector(t.dataset.target);
			if (content) content.style.display = 'none';
		});
		const sharedTabEl = document.querySelector('#tab_shared');
		if (sharedTabEl) sharedTabEl.style.display = 'none';
		return;
	}

	document.querySelector('#indivParams').style.display = checkedTargets.length > 1 ? 'flex' : 'none';
	updateTargetTabs();
}
// ---
