// / <reference path="../libs/js/property-inspector.js" />
// / <reference path="../libs/js/utils.js" />
import { FormUtils, localizeUI } from './utils.js';

// Must match MAX_SERVERS in src/plugin/sockets.ts
const MAX_SERVERS = 6;
// Actions restricted to only servers flagged "IRLTK" in General Configuration - never "All", and never
// a non-IRLTK server. Mirrors irltkCompat: 'only' in the matching action classes' constructor params
const IRLTK_ONLY_ACTIONS = new Set(['irltkingeststatus', 'irltkingestvolume', 'irltkingestpageprev', 'irltkingestpagenext', 'irltkingestpagenumber']);
// Actions IRLToolkit itself disables manual control of - never offered an IRLTK-flagged server as a
// target. Mirrors irltkCompat: 'exclude' in the matching action classes' constructor params
const IRLTK_EXCLUDED_ACTIONS = new Set(['togglereplaybuffer', 'savereplaybuffer', 'togglerecord', 'togglestream', 'togglevirtualcam', 'setprofile', 'refreshcapturedevice']);
const forms = new Map(); // common form and per OBS instance forms
let globalSettings = {};
let pendingGlobalListsResolvers = [];

function escapeHtml(str) {
	return str.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[c]));
}

// Short random id for a newly-created server - mirrors genServerId() in src/actions/globalSettings.ts
// (duplicated here since this file isn't part of the plugin's TS bundle). Non-numeric so it never
// collides with a legacy plain-index target value (see resolveCheckedIds)
function genServerId() {
	return `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

// Resolve the configured server list, migrating in-memory from the legacy flat ip{n}/port{n}/pwd{n}
// keys (pre-dynamic-server-list) if no `servers` array has been saved yet, and backfilling a stable
// `id` onto any server that doesn't have one yet. Mirrors resolveServers() in
// src/actions/globalSettings.ts - duplicated here since this file isn't part of the plugin's TS bundle.
// The plugin backend is the one that actually persists backfilled ids (see app.ts) - this copy is only
// ever used to render this PI, so a same-session-only id here is harmless even in the rare case this
// runs just before that migration lands
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

// Servers eligible as a target for this action, keeping each server's true 1-based socket index (not
// its position in the filtered list) since that index is what the plugin backend keys settings/sockets by
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

// Resolve a persisted target value to the ids of every eligible server it refers to - the current
// array-of-ids shape (multi-select), or an older single-value shape from before multi-select/per-server
// ids existed: a lone id, a plain 1-based position, or '0'/empty for the old "All" (every eligible
// server). Lets a button saved before this update keep its own previously-configured target(s) instead
// of silently resetting the first time its PI is opened after updating - see the target-restore logic below
function resolveCheckedIds(rawTarget, eligibleServers) {
	const eligibleIds = eligibleServers.map(({ server }) => server.id);
	if (Array.isArray(rawTarget)) return rawTarget.filter((id) => eligibleIds.includes(id));
	if (!rawTarget || rawTarget === '0') return eligibleIds;
	if (eligibleIds.includes(rawTarget)) return [rawTarget];
	const legacyIndex = parseInt(rawTarget, 10);
	const match = eligibleServers.find((o) => o.index === legacyIndex);
	return match ? [match.server.id] : [];
}

// Build the "Target" checkbox group for the current action, excluding ineligible servers. Values are
// each server's stable id (not its position) so a saved target survives server reordering. There's no
// more standalone "All" option - checking every box is the multi-select equivalent
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

	$PI.getGlobalSettings();

	// Relay the plugin's response to a general configuration window's getGlobalLists() request, if any is pending
	$PI.onSendToPropertyInspector(action, ({ payload: sentPayload }) => {
		if (sentPayload.event !== 'GlobalListsLoaded') return;
		pendingGlobalListsResolvers.forEach((resolve) => resolve(sentPayload));
		pendingGlobalListsResolvers = [];
	});

	// Tabs/target options depend on the configured server count and names, so wait for the first
	// global settings response before building anything that depends on them. onDidReceiveGlobalSettings
	// returns the $PI instance (for chaining), not an unsubscribe function, so this listener is never
	// removed - harmless, it just keeps resolving an already-settled promise on later updates
	globalSettings = await new Promise((resolve) => {
		$PI.onDidReceiveGlobalSettings(({ payload: gsPayload }) => resolve(gsPayload.settings));
	});
	const servers = resolveServersFromSettings(globalSettings);
	const eligibleServers = getEligibleServers(actionName, servers);
	const targetOptions = renderTargetOptions(eligibleServers);

	// A button saved before this update stores a single legacy value in settings.common.target (a lone
	// id, a plain position, or '0'/empty for the old "All") instead of an id array - normalize that
	// (once, here) to the ids it refers to under the current server list, the same interpretation the
	// plugin backend still falls back to (see resolveTargetIndices), so this PI shows the button's own
	// previously-configured target(s) rather than resetting. Resaving writes an id array instead.
	// A brand new button (target undefined) is left alone so the default-target fallback below applies
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
			// Carry over whichever of the two keys already has data (the id-keyed one, once this button
			// has been resaved since this update; otherwise the old position-keyed one) into both, so
			// initForms below seeds the same values into this tab's form regardless of which map key
			// FormUtils.setFormValue is applying at that moment
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
			// Both keys are registered against the same form: the id-keyed one is the reorder-safe
			// source of truth going forward (see BaseWsAction.getSettingsArray), while the legacy
			// position-keyed one doubles as a read-fallback for other buttons that haven't been resaved
			// since this update yet
			forms.set(idKey, `#action-fields-${id}`);
			forms.set(legacyKey, `#action-fields-${id}`);
		}

		// One extra tab, not tied to any particular server: used when 2+ targets are selected without
		// "individual settings" - see onTargetChange/updateTargetTabs for when it's actually shown.
		// params1 is also registered against it - a fixed slot for a shared blob across whichever
		// targets are selected (there's no single server identity to key it by), and the same slot a
		// button saved before multi-select existed (target '0'/All, non-individual) still has its data
		// in, so this doubles as that button's read/write fallback until it's resaved
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

	// Default to the configured Default Target if nothing is checked yet (brand new button)
	if (!document.querySelector('input[name="target"]:checked')) {
		const wantedIds = resolveCheckedIds(globalSettings.defaultTarget, eligibleServers);
		const toCheck = wantedIds.length ? wantedIds : (targetOptions[0] ? [targetOptions[0].value] : []);
		// No target to fall back to means this action currently has zero eligible targets (e.g. an
		// IRLTK-only action before any server is flagged "IRLTK"). Don't dispatch a save in that case -
		// the forms map only contains 'common'/'advanced' when there are no eligible servers to build
		// param tabs for, so a save here would push a settings object stripped of the existing params, wiping them
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
		// Keep at least one target checked - unchecking the last one would save an empty/missing
		// `common` settings block on next edit (StreamDeck's setSettings replaces it wholesale),
		// silently wiping this button's target and indivParams settings. Blocked here, on 'click' -
		// browsers apply a checkbox's new checked state before dispatching 'click' (unlike 'change',
		// which only fires after - reverting there caused a visible check/uncheck flicker), so
		// checking it and preventDefault()-ing cancels the click's toggle outright, with no flicker
		// and no spurious 'input'/'change' cycle
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
			if (Object.keys(formValue).length === 0 && formValue.constructor === Object) { // empty object
				return;
			}
			updatedSettings = { ...updatedSettings, [key]: formValue };
		});
		$PI.setSettings(updatedSettings);
	});

	// A single tab's form can be registered under two settings keys (its reorder-safe id-based one and
	// the legacy position-based one - see the target-tab setup above), so listeners are attached once
	// per unique form element rather than once per map entry, or editing that tab would debounce-save twice
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

/**
 * Fetch the live ingest/scene lists for the general configuration window's alias editors.
 * @returns {Promise<{ ingestsLists: object[][], scenesLists: object[][] }>}
 */
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

// Show/hide the per-server tabs vs the shared tab for the currently-checked targets, per the
// "individual settings" checkbox. Only called once 2+ targets are checked (see onTargetChange) -
// exactly one target bypasses this entirely and just shows that server's own tab directly
function updateTargetTabs() {
	const perServerTabs = Array.from(document.querySelectorAll('.tab'));
	const sharedTabEl = document.querySelector('#tab_shared');
	const indivParamsCheckbox = document.querySelector('#indivParamsCheck');

	if (!indivParamsCheckbox.checked) {
		// Shared mode: every checked target reads/writes the one dedicated shared tab
		perServerTabs.forEach((t) => {
			t.classList.remove('selected');
			const content = document.querySelector(t.dataset.target);
			if (content) content.style.display = 'none';
		});
		if (sharedTabEl) sharedTabEl.style.display = 'block';
		document.querySelector('#tabs-header').style.display = 'none';
		return;
	}

	// Individual mode: switch between a tab per currently-checked target; tabs for unchecked (but
	// still eligible) servers, and the shared tab, are hidden rather than removed
	if (sharedTabEl) sharedTabEl.style.display = 'none';
	const checkedIds = Array.from(document.querySelectorAll('input[name="target"]:checked')).map((el) => el.value);
	perServerTabs.forEach((t) => {
		t.style.display = checkedIds.some((id) => t.dataset.target === `#tab_${id}`) ? '' : 'none';
	});
	const visibleTabs = perServerTabs.filter((t) => t.style.display !== 'none');
	clickTab(visibleTabs.find((t) => t.classList.contains('selected')) ?? visibleTabs[0] ?? perServerTabs[0]);
	document.querySelector('#tabs-header').style.display = 'block';
}

function onTargetChange() {
	// No option may be checked (or exist at all) if the action has zero eligible servers right now -
	// e.g. an IRLTK-only action before any server has been flagged "IRLTK" in General Configuration
	const checkedTargets = Array.from(document.querySelectorAll('input[name="target"]:checked'));
	const tabs = Array.from(document.querySelectorAll('.tab'));
	if (!checkedTargets.length || !tabs.length) {
		document.querySelector('#indivParams').style.display = 'none';
		document.querySelector('#tabs-header').style.display = 'none';
		if (!tabs.length) return;
		// Zero checked (shouldn't normally happen - see the "keep at least one checked" guard) still
		// needs the tabs themselves hidden
		tabs.forEach((t) => {
			const content = document.querySelector(t.dataset.target);
			if (content) content.style.display = 'none';
		});
		const sharedTabEl = document.querySelector('#tab_shared');
		if (sharedTabEl) sharedTabEl.style.display = 'none';
		return;
	}

	if (checkedTargets.length === 1) {
		document.querySelector('#indivParams').style.display = 'none';
		document.querySelector('#tabs-header').style.display = 'none';
		const sharedTabEl = document.querySelector('#tab_shared');
		if (sharedTabEl) sharedTabEl.style.display = 'none';
		// Tabs are keyed by each server's stable id (data-target="#tab_<id>"), not by position - a
		// reordered/renamed server must still resolve to the same tab
		tabs.forEach((t) => { t.style.display = ''; });
		clickTab(document.querySelector(`.tab[data-target="#tab_${checkedTargets[0].value}"]`) ?? tabs[0]);
	}
	else {
		document.querySelector('#indivParams').style.display = 'flex';
		updateTargetTabs();
	}
}
// ---
