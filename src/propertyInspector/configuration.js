import { FormUtils } from './utils.js';

const MAX_SERVERS = 6;

// Per-server live ingest/scene lists, used to (re)populate the Ingest -> Scene Mapping and Ingest
// Alias/Category Override datalists
const ingestSceneListsByServer = new WeakMap();

function escapeHtml(str) {
	return str.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[c]));
}

function genServerId() {
	return `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function resolveServersFromSettings(settings) {
	let servers;
	if (Array.isArray(settings.servers) && settings.servers.length) {
		servers = settings.servers.map((server) => (server.id ? server : { ...server, id: genServerId() }));
	}
	else {
		const legacy = [];
		for (let i = 1; i <= MAX_SERVERS; i++) {
			const ip = settings[`ip${i}`];
			const port = settings[`port${i}`];
			const pwd = settings[`pwd${i}`];
			if (ip || port || pwd) legacy.push({ id: genServerId(), name: `OBS #${i}`, ip, port, pwd });
		}
		servers = legacy.length ? legacy : [{ id: genServerId(), name: 'OBS #1' }, { id: genServerId(), name: 'OBS #2' }];
	}

	// Legacy global pinned ingest list - carried over as the starting point for any server that doesn't have its own list yet
	if (settings.ingestPinned !== undefined) {
		servers = servers.map((server) => (server.ingestPinned !== undefined ? server : { ...server, ingestPinned: settings.ingestPinned }));
	}

	return servers;
}

function resolveCheckedIds(rawTarget, rows) {
	const ids = rows.map((row) => row.dataset.id);
	if (Array.isArray(rawTarget)) return rawTarget.filter((id) => ids.includes(id));
	if (!rawTarget || rawTarget === '0') return ids;
	if (ids.includes(rawTarget)) return [rawTarget];
	const legacyIndex = parseInt(rawTarget, 10);
	return Number.isInteger(legacyIndex) && rows[legacyIndex - 1] ? [rows[legacyIndex - 1].dataset.id] : [];
}

function getFormValue(formEl) {
	const value = {};
	new FormData(formEl).forEach((v, key) => {
		if (!Reflect.has(value, key)) {
			value[key] = v;
			return;
		}
		if (!Array.isArray(value[key])) value[key] = [value[key]];
		value[key].push(v);
	});
	return value;
}

function pinnedIngestRowHtml(value = '') {
	return `
	<div class="server-row-line pinned-ingest-row">
		<div class="field-label"></div>
		<input type="text" name="ingestPinned" value="${escapeHtml(value)}" style="flex: 1 0 0; min-width: 0;">
		<button class="down icon-button icon-down" title="Move down"></button>
		<button class="up icon-button icon-up" title="Move up"></button>
		<button class="remove icon-button icon-remove" title="Remove"></button>
	</div>
	`;
}

let ingestSceneRowNonce = 0;

function ingestSceneRowHtml(ingest = '', scene = '') {
	const nonce = ingestSceneRowNonce++;
	return `
	<div class="server-row-line ingest-scene-row">
		<div class="field-label"></div>
		<input type="text" name="ingestSceneIngest" value="${escapeHtml(ingest)}" list="ingestSceneIngestList-${nonce}" placeholder="Ingest" style="flex: 1 0 0; min-width: 0;">
		<datalist id="ingestSceneIngestList-${nonce}" class="ingest-scene-ingest-list"></datalist>
		<input type="text" name="ingestSceneScene" value="${escapeHtml(scene)}" list="ingestSceneSceneList-${nonce}" placeholder="Scene" style="flex: 1 0 0; min-width: 0;">
		<datalist id="ingestSceneSceneList-${nonce}" class="ingest-scene-scene-list"></datalist>
		<button class="down icon-button icon-down" title="Move down"></button>
		<button class="up icon-button icon-up" title="Move up"></button>
		<button class="remove icon-button icon-remove" title="Remove"></button>
	</div>
	`;
}

const INGEST_CATEGORIES = [
	['', 'Uncategorized'],
	['backpack', 'Backpack'],
	['phone', 'Phone'],
	['desktop', 'Desktop'],
];

let ingestAliasRowNonce = 0;

function ingestAliasRowHtml(name = '', aliasValue = '', categoryValue = '') {
	const nonce = ingestAliasRowNonce++;
	const categoryOptions = INGEST_CATEGORIES
	.map(([value, label]) => `<option value="${value}" ${value === categoryValue ? 'selected' : ''}>${label}</option>`)
	.join('');
	return `
	<div class="server-row-line ingest-alias-row">
		<div class="field-label"></div>
		<input type="text" name="ingestAliasName" value="${escapeHtml(name)}" list="ingestAliasNameList-${nonce}" placeholder="Ingest name" style="flex: 1 0 0; min-width: 0;">
		<datalist id="ingestAliasNameList-${nonce}" class="ingest-alias-name-list"></datalist>
		<input type="text" name="ingestAliasValue" value="${escapeHtml(aliasValue)}" placeholder="Alias" style="flex: 1 0 0; min-width: 0;">
		<select class="sdpi-item-value select" name="ingestAliasCategory" style="flex: 0 0 90px;">${categoryOptions}</select>
		<button class="remove icon-button icon-remove" title="Remove"></button>
	</div>
	`;
}

/**
 * Refresh the ingest name autocomplete datalist for every override row of a server, excluding
 * whatever ingest name is already used by another row so the same one can't be overridden twice
 * @param {HTMLElement} serverRow
 */
function refreshIngestAliasOverrideDatalists(serverRow) {
	const lists = ingestSceneListsByServer.get(serverRow);
	if (!lists) return;
	const rows = Array.from(serverRow.querySelectorAll('.ingest-alias-row'));
	const usedNames = new Set(rows.map((r) => r.querySelector('input[name="ingestAliasName"]').value.trim()).filter(Boolean));
	const allNames = [...new Set(lists.ingests.map((ingest) => ingest.name))];

	rows.forEach((r) => {
		const currentName = r.querySelector('input[name="ingestAliasName"]').value.trim();
		const options = allNames
		.filter((name) => name === currentName || !usedNames.has(name))
		.map((name) => {
			const option = document.createElement('option');
			option.value = name;
			return option;
		});
		r.querySelector('.ingest-alias-name-list')?.replaceChildren(...options);
	});
}

/**
 * Refresh the ingest/scene autocomplete datalists for every mapping row of a server, excluding
 * whatever ingest/scene is already used by another row so the same one can't be mapped twice
 * @param {HTMLElement} serverRow
 */
function refreshIngestSceneDatalists(serverRow) {
	const lists = ingestSceneListsByServer.get(serverRow);
	if (!lists) return;
	const rows = Array.from(serverRow.querySelectorAll('.ingest-scene-row'));
	const usedIngests = new Set(rows.map((r) => r.querySelector('input[name="ingestSceneIngest"]').value.trim()).filter(Boolean));
	const usedScenes = new Set(rows.map((r) => r.querySelector('input[name="ingestSceneScene"]').value.trim()).filter(Boolean));

	rows.forEach((r) => {
		const currentIngest = r.querySelector('input[name="ingestSceneIngest"]').value.trim();
		const currentScene = r.querySelector('input[name="ingestSceneScene"]').value.trim();

		const ingestOptions = lists.ingests
		.filter((ingest) => ingest.obs_source_name === currentIngest || !usedIngests.has(ingest.obs_source_name))
		.map((ingest) => {
			const option = document.createElement('option');
			option.value = ingest.obs_source_name;
			option.textContent = `${ingest.obs_source_name} (${ingest.name})`;
			return option;
		});
		r.querySelector('.ingest-scene-ingest-list')?.replaceChildren(...ingestOptions);

		const sceneOptions = [...lists.scenes].reverse()
		.filter((scene) => scene.sceneName === currentScene || !usedScenes.has(scene.sceneName))
		.map((scene) => {
			const option = document.createElement('option');
			option.value = scene.sceneName;
			return option;
		});
		r.querySelector('.ingest-scene-scene-list')?.replaceChildren(...sceneOptions);
	});
}

let serverRowNonce = 0;

function serverRowHtml(server = {}) {
	const id = server.id || genServerId();
	const name = escapeHtml(server.name || '');
	const ip = escapeHtml(server.ip || '');
	const port = escapeHtml(server.port || '');
	const pwd = escapeHtml(server.pwd || '');
	const checked = server.irltk === 'true' ? 'checked' : '';
	const secureChecked = server.secure === 'true' ? 'checked' : '';
	const irltkId = `serverIrltk-${serverRowNonce++}`;
	const secureId = `serverSecure-${serverRowNonce++}`;
	const pinnedIngests = Array.isArray(server.ingestPinned)
		? server.ingestPinned
		: server.ingestPinned ? [server.ingestPinned] : [''];
	const pinnedIngestRows = pinnedIngests.map((value) => pinnedIngestRowHtml(value)).join('');
	const ingestSceneMap = Array.isArray(server.ingestSceneMap) && server.ingestSceneMap.length
		? server.ingestSceneMap
		: [{ ingest: '', scene: '' }];
	const ingestSceneRows = ingestSceneMap.map((m) => ingestSceneRowHtml(m.ingest, m.scene)).join('');
	const ingestAliasOverrideNames = [...new Set([...Object.keys(server.ingestAlias || {}), ...Object.keys(server.ingestCategory || {})])];
	const ingestAliasRows = ingestAliasOverrideNames
	.map((overrideName) => ingestAliasRowHtml(overrideName, server.ingestAlias?.[overrideName] || '', server.ingestCategory?.[overrideName] || ''))
	.join('');
	return `
	<div class="server-row" data-id="${id}">
		<div class="server-row-header">
			<input type="text" name="serverName" value="${name}" title="Custom display name for this OBS server, shown wherever a target OBS is picked">
			<div class="buttons">
				<button class="down icon-button icon-down" title="Move down"></button>
				<button class="up icon-button icon-up" title="Move up"></button>
				<button class="remove icon-button icon-remove" title="Remove"></button>
			</div>
		</div>
		<div class="server-row-line">
			<div class="field-label">IP</div>
			<input type="text" name="serverIp" value="${ip}" pattern="\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}" title="IP address of OBS WebSocket server. Please, provide a valid IP address">
			<div class="field-label">Port</div>
			<input type="number" name="serverPort" value="${port}" title="Port of OBS WebSocket server">
		</div>
		<div class="server-row-line">
			<div class="field-label">Password</div>
			<input type="password" name="serverPwd" value="${pwd}" style="flex: 1 0 0;" title="Password of OBS WebSocket server, if auth enabled">
		</div>
		<div class="server-row-line">
			<div class="field-label"></div>
			<input id="${secureId}" type="checkbox" name="serverSecure" value="true" ${secureChecked}>
			<label for="${secureId}" title="Connect via a secure WebSocket (wss://) instead of ws:// - only needed if the OBS WebSocket server is behind TLS, e.g. a reverse proxy"><span></span>Secure connection (wss://)</label>
		</div>
		<div class="server-row-line">
			<div class="field-label"></div>
			<input id="${irltkId}" type="checkbox" name="serverIrltk" value="true" ${checked}>
			<label for="${irltkId}" title="Managed by IRLToolkit - the only servers offered to IRLToolkit actions, and hidden from actions IRLToolkit itself disables"><span></span>Managed by IRLToolkit</label>
		</div>
		<div class="server-pinned-ingests" style="${checked ? '' : 'display: none;'}">
			<div class="server-pinned-ingests-label" title="Ingest names (as shown in IRLToolkit), sorted first within their category in this order, when using dynamic ingest position targeting on this server">Pinned Ingests</div>
			<div class="pinned-ingest-items">${pinnedIngestRows}</div>
			<div class="server-row-line">
				<div class="field-label"></div>
				<button class="import-streamer-ingests" title="Fetch a streamer's settings from the 1a3.uk userscript settings API - overwrites this server's Pinned Ingests list and the global Ingest Aliases & Categories">Import from streamer...</button>
				<button class="add-pinned-ingest" style="margin-left: auto;">Add pinned ingest</button>
			</div>
		</div>
		<div class="server-ingest-scenes" style="${checked ? '' : 'display: none;'}">
			<div class="server-pinned-ingests-label" title="Maps each ingest (matched by OBS source name, so it survives IRLToolkit renames) to the scene it should switch to on this server, used by the IRLToolkit Ingest Scene action">Ingest → Scene Mapping</div>
			<div class="ingest-scene-items">${ingestSceneRows}</div>
			<div class="server-row-line">
				<div class="field-label"></div>
				<button class="add-ingest-scene" style="margin-left: auto;">Add mapping</button>
			</div>
		</div>
		<div class="server-ingest-aliases" style="${checked ? '' : 'display: none;'}">
			<div class="server-pinned-ingests-label" title="Per-server override of the display name and/or category for a specific ingest (matched by ingest name), for when this server needs something different from the global Ingest Aliases &amp; Categories setting">Ingest Alias/Category Overrides</div>
			<div class="ingest-alias-items">${ingestAliasRows}</div>
			<div class="server-row-line">
				<div class="field-label"></div>
				<button class="add-ingest-alias" style="margin-left: auto;">Add override</button>
			</div>
		</div>
	</div>
	`;
}

function addServerRow(server = {}) {
	if (document.querySelectorAll('.server-row').length >= MAX_SERVERS) return;
	document.querySelector('.server-items').insertAdjacentHTML('beforeend', serverRowHtml(server));
	refreshServerUI();
}

function refreshServerUI() {
	const rows = Array.from(document.querySelectorAll('.server-row'));
	rows.forEach((row, i) => {
		row.querySelector('input[name="serverName"]').placeholder = `OBS #${i + 1}`;
		row.querySelector('.remove').disabled = rows.length <= 1;
	});
	document.querySelector('#addServer').disabled = rows.length >= MAX_SERVERS;
	renderTargetOptions();
}

function getServerNames() {
	return Array.from(document.querySelectorAll('.server-row')).map((row, i) => {
		return row.querySelector('input[name="serverName"]').value.trim() || `OBS #${i + 1}`;
	});
}

function renderTargetOptions() {
	const container = document.querySelector('#defaultTargetOptions');
	const rows = Array.from(document.querySelectorAll('.server-row'));
	const names = getServerNames();
	const currentlyChecked = Array.from(container.querySelectorAll('input[name="defaultTarget"]:checked')).map((el) => el.value);
	const rawCurrent = currentlyChecked.length ? currentlyChecked : globalSettings.defaultTarget;
	const options = rows.map((row, i) => ({ value: row.dataset.id, label: names[i] }));
	container.innerHTML = options.map(({ value, label }) => `
		<input id="defaultTarget${value}" type="checkbox" name="defaultTarget" value="${value}">
		<label for="defaultTarget${value}"><span></span>${escapeHtml(label)}</label>
	`).join('');
	resolveCheckedIds(rawCurrent, rows).forEach((id) => {
		const toCheck = container.querySelector(`input[value="${id}"]`);
		if (toCheck) toCheck.checked = true;
	});
}

document.querySelector('#addServer').addEventListener('click', (e) => {
	e.preventDefault();
	addServerRow();
	document.querySelector('form').dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
});

document.querySelector('.server-items').addEventListener('click', (e) => {
	if (!e.target.matches('button')) return;
	e.preventDefault();
	if (e.target.disabled) return;

	if (e.target.matches('.add-pinned-ingest')) {
		e.target.closest('.server-pinned-ingests').querySelector('.pinned-ingest-items')
		.insertAdjacentHTML('beforeend', pinnedIngestRowHtml());
		document.querySelector('form').dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
		return;
	}

	if (e.target.matches('.import-streamer-ingests')) {
		importStreamerIngests(e.target.closest('.server-row'));
		return;
	}

	if (e.target.matches('.add-ingest-scene')) {
		e.target.closest('.server-ingest-scenes').querySelector('.ingest-scene-items')
		.insertAdjacentHTML('beforeend', ingestSceneRowHtml());
		refreshIngestSceneDatalists(e.target.closest('.server-row'));
		document.querySelector('form').dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
		return;
	}

	if (e.target.matches('.add-ingest-alias')) {
		e.target.closest('.server-ingest-aliases').querySelector('.ingest-alias-items')
		.insertAdjacentHTML('beforeend', ingestAliasRowHtml());
		refreshIngestAliasOverrideDatalists(e.target.closest('.server-row'));
		document.querySelector('form').dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
		return;
	}

	const pinnedRow = e.target.closest('.pinned-ingest-row');
	if (pinnedRow) {
		if (e.target.matches('.down')) {
			const next = pinnedRow.nextElementSibling;
			if (next) pinnedRow.parentNode.insertBefore(next, pinnedRow);
		}
		else if (e.target.matches('.up')) {
			const previous = pinnedRow.previousElementSibling;
			if (previous) pinnedRow.parentNode.insertBefore(pinnedRow, previous);
		}
		else if (e.target.matches('.remove')) {
			pinnedRow.remove();
		}
		document.querySelector('form').dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
		return;
	}

	const ingestSceneRow = e.target.closest('.ingest-scene-row');
	if (ingestSceneRow) {
		const serverRow = e.target.closest('.server-row');
		if (e.target.matches('.down')) {
			const next = ingestSceneRow.nextElementSibling;
			if (next) ingestSceneRow.parentNode.insertBefore(next, ingestSceneRow);
		}
		else if (e.target.matches('.up')) {
			const previous = ingestSceneRow.previousElementSibling;
			if (previous) ingestSceneRow.parentNode.insertBefore(ingestSceneRow, previous);
		}
		else if (e.target.matches('.remove')) {
			ingestSceneRow.remove();
			refreshIngestSceneDatalists(serverRow);
		}
		document.querySelector('form').dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
		return;
	}

	const aliasRow = e.target.closest('.ingest-alias-row');
	if (aliasRow && e.target.matches('.remove')) {
		const serverRow = e.target.closest('.server-row');
		aliasRow.remove();
		refreshIngestAliasOverrideDatalists(serverRow);
		document.querySelector('form').dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
		return;
	}

	const row = e.target.closest('.server-row');
	if (e.target.matches('.down')) {
		const next = row.nextElementSibling;
		if (next) row.parentNode.insertBefore(next, row);
	}
	else if (e.target.matches('.up')) {
		const previous = row.previousElementSibling;
		if (previous) row.parentNode.insertBefore(row, previous);
	}
	else if (e.target.matches('.remove')) {
		row.remove();
	}
	refreshServerUI();
	document.querySelector('form').dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
});

document.querySelector('.server-items').addEventListener('input', (e) => {
	if (e.target.matches('input[name="serverName"]')) renderTargetOptions();
	if (e.target.matches('input[name="serverIrltk"]')) {
		const section = e.target.closest('.server-row').querySelector('.server-pinned-ingests');
		if (section) section.style.display = e.target.checked ? '' : 'none';
		const mapSection = e.target.closest('.server-row').querySelector('.server-ingest-scenes');
		if (mapSection) mapSection.style.display = e.target.checked ? '' : 'none';
		const aliasSection = e.target.closest('.server-row').querySelector('.server-ingest-aliases');
		if (aliasSection) aliasSection.style.display = e.target.checked ? '' : 'none';
	}
	if (e.target.matches('input[name="ingestSceneIngest"], input[name="ingestSceneScene"]')) {
		refreshIngestSceneDatalists(e.target.closest('.server-row'));
	}
	if (e.target.matches('input[name="ingestAliasName"]')) {
		refreshIngestAliasOverrideDatalists(e.target.closest('.server-row'));
	}
});

function serializeFormValue(formEl) {
	const { serverName, serverIp, serverPort, serverPwd, ...rest } = getFormValue(formEl);
	delete rest.serverIrltk;
	delete rest.serverSecure;
	delete rest.ingestPinned;
	delete rest.ingestSceneIngest;
	delete rest.ingestSceneScene;
	delete rest.ingestAliasName;
	delete rest.ingestAliasValue;
	delete rest.ingestAliasCategory;
	const toArray = (v) => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
	const names = toArray(serverName);
	const ips = toArray(serverIp);
	const ports = toArray(serverPort);
	const pwds = toArray(serverPwd);
	const rows = Array.from(document.querySelectorAll('.server-row'));
	rest.servers = rows.map((row, i) => {
		const aliasRows = Array.from(row.querySelectorAll('.ingest-alias-row'));
		return {
			id: row.dataset.id,
			name: names[i] || '',
			ip: ips[i] || '',
			port: ports[i] || '',
			pwd: pwds[i] || '',
			irltk: row.querySelector('input[name="serverIrltk"]').checked ? 'true' : undefined,
			secure: row.querySelector('input[name="serverSecure"]').checked ? 'true' : undefined,
			ingestPinned: Array.from(row.querySelectorAll('input[name="ingestPinned"]')).map((el) => el.value),
			ingestSceneMap: Array.from(row.querySelectorAll('.ingest-scene-row')).map((r) => ({
				ingest: r.querySelector('input[name="ingestSceneIngest"]').value,
				scene: r.querySelector('input[name="ingestSceneScene"]').value,
			})).filter((m) => m.ingest || m.scene),
			ingestAlias: Object.fromEntries(
				aliasRows
				.map((r) => [r.querySelector('input[name="ingestAliasName"]').value, r.querySelector('input[name="ingestAliasValue"]').value.trim()])
				.filter(([name, alias]) => name && alias),
			),
			ingestCategory: Object.fromEntries(
				aliasRows
				.map((r) => [r.querySelector('input[name="ingestAliasName"]').value, r.querySelector('select[name="ingestAliasCategory"]').value])
				.filter(([name, category]) => name && category),
			),
		};
	});
	Object.keys(rest).forEach((key) => {
		if (/^(ip|port|pwd)\d+$/.test(key)) delete rest[key];
	});
	formEl.querySelectorAll('input[type="checkbox"][name]').forEach((el) => {
		if (!el.closest('.server-row') && !(el.name in rest)) rest[el.name] = undefined;
	});
	return rest;
}

let globalSettings = {};

function cloneForForm() {
	const rest = { ...globalSettings };
	delete rest.ingestPinned;
	return rest;
}

let cachedIngestLists = null;

const VALID_CATEGORIES = new Set(['backpack', 'phone', 'desktop']);

/**
 * (Re)render the global Ingest Aliases & Categories list from every known ingest name (live,
 * across all servers, plus anything already saved), backed by the flat ingestAlias__<name> /
 * ingestCategory__<name> global settings. Matched by ingest name (as shown in IRLToolkit, which
 * doesn't support renaming ingests) - per-server overrides live separately on each server row.
 */
function renderIngestAliasList() {
	if (!cachedIngestLists) return;
	const { ingestsLists, connectedIngestSourceNames } = cachedIngestLists;
	const ingestNames = new Set();
	ingestsLists.flat().forEach((ingest) => ingestNames.add(ingest.name));

	Object.keys(globalSettings).forEach((key) => {
		const aliasMatch = key.match(/^ingestAlias__(.+)$/);
		if (aliasMatch) ingestNames.add(aliasMatch[1]);
		const categoryMatch = key.match(/^ingestCategory__(.+)$/);
		if (categoryMatch) ingestNames.add(categoryMatch[1]);
	});

	const connectedSet = new Set(connectedIngestSourceNames);
	const connectedNames = new Set(ingestsLists.flat().filter((ingest) => connectedSet.has(ingest.obs_source_name)).map((ingest) => ingest.name));

	document.querySelector('#ingestAliasList').innerHTML = [...ingestNames]
	.sort((a, b) => a.localeCompare(b))
	.map((name) => {
		const safeName = escapeHtml(name);
		const aliasKey = `ingestAlias__${name}`;
		const categoryKey = `ingestCategory__${name}`;
		const canDelete = !connectedNames.has(name);
		const categoryOptions = INGEST_CATEGORIES
		.map(([value, label]) => `<option value="${value}">${label}</option>`)
		.join('');
		return `
			<div class="sdpi-item">
				<div class="sdpi-item-label" title="${safeName}">${safeName}</div>
				<div class="sdpi-item-value" style="display: flex; gap: 4px; align-items: center;">
					<input style="flex: 1 0 0; min-width: 0;" type="text" name="ingestAlias__${safeName}" placeholder="${safeName}">
					<select style="flex: 0 0 90px;" class="sdpi-item-value select" name="ingestCategory__${safeName}">${categoryOptions}</select>
					${canDelete ? `<button class="remove-alias icon-button icon-remove" title="Remove" data-alias-key="${escapeHtml(aliasKey)}" data-category-key="${escapeHtml(categoryKey)}"></button>` : ''}
				</div>
			</div>
		`;
	}).join('');
}

function removeAliasRow(e) {
	const btn = e.target.closest('.remove-alias');
	if (!btn) return;
	e.preventDefault();
	delete globalSettings[btn.dataset.aliasKey];
	if (btn.dataset.categoryKey) delete globalSettings[btn.dataset.categoryKey];
	btn.closest('.sdpi-item').remove();
	window.opener.sendGlobalSettingsToInspector(globalSettings);
}
document.querySelector('#ingestAliasList').addEventListener('click', removeAliasRow);

/**
 * Import ingest settings for a streamer from the 1a3.uk userscript-settings public API: pinned
 * ingests go into this specific server's Pinned Ingests list, while aliases/categories go into
 * the global Ingest Aliases & Categories settings shared by every server.
 * @param {HTMLElement} serverRow
 */
async function importStreamerIngests(serverRow) {
	const btn = serverRow.querySelector('.import-streamer-ingests');
	const streamerName = window.prompt('Streamer name to import ingest settings for:');
	if (!streamerName || !streamerName.trim()) return;

	const originalText = btn.textContent;
	btn.disabled = true;
	btn.textContent = 'Importing...';
	try {
		const response = await fetch(`https://1a3.uk/api/mediamtx/userscript-settings/${encodeURIComponent(streamerName.trim())}/public`);
		if (!response.ok) throw new Error(`HTTP ${response.status}`);
		const data = await response.json();
		const ingests = data?.settings?.ingests;
		if (!data?.success || !ingests || typeof ingests !== 'object') throw new Error('Unexpected response format');

		// The API key is the ingest name minus the " Player" suffix that OBS/IRLToolkit actually use
		const pinnedNames = Object.entries(ingests)
		.filter(([, info]) => info?.mine === true)
		.map(([key]) => key);
		if (pinnedNames.length) {
			serverRow.querySelector('.pinned-ingest-items').innerHTML = pinnedNames.map((name) => pinnedIngestRowHtml(name)).join('');
		}

		Object.entries(ingests).forEach(([key, info]) => {
			const name = key;
			if (typeof info?.label === 'string' && info.label.trim()) globalSettings[`ingestAlias__${name}`] = info.label;
			const category = typeof info?.category === 'string' ? info.category.trim().toLowerCase() : '';
			globalSettings[`ingestCategory__${name}`] = VALID_CATEGORIES.has(category) ? category : '';
		});
		renderIngestAliasList();

		FormUtils.setFormValue(cloneForForm(), document.querySelector('form'));
		document.querySelector('form').dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
	}
	catch (e) {
		console.error('Error importing streamer ingest settings', e);
		window.alert(`Failed to import ingest settings: ${e.message}`);
	}
	finally {
		btn.disabled = false;
		btn.textContent = originalText;
	}
}

window.onload = () => {
	const formEl = document.querySelector('form');

	// Load global settings to form
	globalSettings = window.opener.getGlobalSettings();

	resolveServersFromSettings(globalSettings).forEach((server) => addServerRow(server));
	refreshServerUI();

	FormUtils.setFormValue(cloneForForm(), formEl);
	renderTargetOptions();

	window.opener.getGlobalLists().then(({ ingestsLists, scenesLists, connectedIngestSourceNames }) => {
		cachedIngestLists = { ingestsLists, connectedIngestSourceNames };
		renderIngestAliasList();

		Array.from(document.querySelectorAll('.server-row')).forEach((row, i) => {
			ingestSceneListsByServer.set(row, { ingests: ingestsLists[i] ?? [], scenes: scenesLists[i] ?? [] });
			refreshIngestSceneDatalists(row);
			refreshIngestAliasOverrideDatalists(row);
		});

		FormUtils.setFormValue(cloneForForm(), formEl);
		return;
	}).catch((e) => console.error('Error loading ingest/scene alias lists', e));

	formEl.addEventListener(
		'input',
		Utils.debounce(500, () => {
			globalSettings = { ...globalSettings, ...serializeFormValue(formEl) };
			window.opener.sendGlobalSettingsToInspector(globalSettings);
		}),
	);
};

function setTransferStatus(message) {
	document.querySelector('#settingsTransferStatus').textContent = message;
}

document.querySelector('#exportSettings').addEventListener('click', (e) => {
	e.preventDefault();
	const textEl = document.querySelector('#settingsTransferText');
	textEl.value = JSON.stringify(globalSettings);
	textEl.select();
	setTransferStatus('Copy the text above (Ctrl+C) and import it in the other install.');
});

document.querySelector('#importSettings').addEventListener('click', (e) => {
	e.preventDefault();
	let imported;
	try {
		imported = JSON.parse(document.querySelector('#settingsTransferText').value);
		if (!imported || typeof imported !== 'object' || Array.isArray(imported)) throw new Error('Not an object');
	}
	catch {
		setTransferStatus('Invalid settings text.');
		return;
	}
	globalSettings = imported;
	window.opener.sendGlobalSettingsToInspector(globalSettings);
	location.reload();
});

document.querySelector('#reconnect').addEventListener('click', (e) => {
	e.preventDefault();
	window.opener.reconnect();
});

document.querySelectorAll('.links button').forEach((el) => {
	el.addEventListener('click', (e) => {
		e.preventDefault();
		window.opener.openUrl(e.target.dataset.url);
	});
});

document.querySelectorAll('.colors button.icon-remove').forEach(el => el.addEventListener('click', (ev) => {
	ev.preventDefault();
	el.previousElementSibling.value = '#fefefe';
	document.querySelector('form').dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
}));
