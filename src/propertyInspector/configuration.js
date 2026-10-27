import { INGEST_CATEGORIES, MAX_SERVERS } from '../shared/constants.js';
import { fetchStreamerIngests, genServerId, parseStreamerIngests, resolveServers, stripGlobalIngestAliases } from '../shared/servers.js';
import { FormUtils } from './utils.js';

// Per-server live ingest/scene lists, used to (re)populate the Ingest -> Scene Mapping and Ingest
// Alias/Category Override datalists
const ingestSceneListsByServer = new WeakMap();

function escapeHtml(str) {
	return str.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[c]));
}

function resolveServersFromSettings(settings) {
	let servers = resolveServers(settings);

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

/**
 * Read-only row for a scene linked to an ingest in the streamer's settings (no input names, so it
 * stays out of the form values - serialized from the row's data attributes instead)
 * @param {string} name Ingest name
 * @param {string} scene
 */
function streamerSceneRowHtml(name, scene) {
	return `
	<div class="server-row-line streamer-scene-row" data-name="${escapeHtml(name)}" data-scene="${escapeHtml(scene)}">
		<div class="field-label"></div>
		<input type="text" value="${escapeHtml(name)}" readonly style="flex: 1 0 0; min-width: 0;">
		<input type="text" value="${escapeHtml(scene)}" readonly style="flex: 1 0 0; min-width: 0;">
	</div>
	`;
}

/**
 * @param {Record<string, string> | undefined} ingestScene Ingest name -> scene
 */
function streamerSceneRowsHtml(ingestScene) {
	return Object.entries(ingestScene ?? {}).map(([name, scene]) => streamerSceneRowHtml(name, scene)).join('');
}

const CATEGORY_OPTIONS = [
	['', 'Uncategorized'],
	...INGEST_CATEGORIES.map((category) => [category, category[0].toUpperCase() + category.slice(1)]),
];

let ingestAliasRowNonce = 0;

function ingestAliasRowHtml(name = '', aliasValue = '', categoryValue = '') {
	const nonce = ingestAliasRowNonce++;
	const categoryOptions = CATEGORY_OPTIONS
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

/**
 * Streamer name whose settings drive this server's pinned ingests and aliases/categories, if any
 * @param {HTMLElement} serverRow
 */
function getStreamerName(serverRow) {
	if (!serverRow.querySelector('input[name="serverIrltk"]').checked) return '';
	return serverRow.querySelector('input[name="serverStreamer"]').value.trim();
}

/**
 * Make the fields filled in from the streamer's settings read-only while a streamer is set
 * @param {HTMLElement} serverRow
 */
function applyStreamerLock(serverRow) {
	const locked = !!getStreamerName(serverRow);
	serverRow.classList.toggle('streamer-locked', locked);
	serverRow.querySelectorAll('.server-pinned-ingests input, .server-ingest-aliases input').forEach((el) => { el.readOnly = locked; });
	serverRow.querySelectorAll('.server-ingest-aliases select').forEach((el) => { el.disabled = locked; });
	serverRow.querySelector('.refresh-streamer').disabled = !locked || serverRow.dataset.refreshing === 'true';
}

/**
 * Replace a server's Pinned Ingests, Ingest Aliases & Categories and linked scene lists with streamer data
 * @param {HTMLElement} serverRow
 * @param {{ ingestPinned: string[], ingestAlias: Record<string, string>, ingestCategory: Record<string, string>, ingestScene: Record<string, string> }} data
 * @param {number} fetchedAt
 */
function renderStreamerData(serverRow, { ingestPinned, ingestAlias, ingestCategory, ingestScene }, fetchedAt) {
	serverRow.dataset.streamerFetchedAt = String(fetchedAt);
	serverRow.querySelector('.pinned-ingest-items').innerHTML = (ingestPinned ?? []).map((name) => pinnedIngestRowHtml(name)).join('');
	serverRow.querySelector('.streamer-scene-items').innerHTML = streamerSceneRowsHtml(ingestScene);
	const names = [...new Set([...Object.keys(ingestAlias ?? {}), ...Object.keys(ingestCategory ?? {})])];
	serverRow.querySelector('.ingest-alias-items').innerHTML = names
	.map((name) => ingestAliasRowHtml(name, ingestAlias?.[name] || '', ingestCategory?.[name] || ''))
	.join('');
	refreshIngestAliasOverrideDatalists(serverRow);
	applyStreamerLock(serverRow);
}

/**
 * Re-fetch the streamer's settings for a server, replacing its Pinned Ingests (the streamer's own
 * ingests) and Ingest Aliases & Categories (every ingest with a label/category) lists
 * @param {HTMLElement} serverRow
 */
async function refreshStreamer(serverRow) {
	const streamerName = getStreamerName(serverRow);
	if (!streamerName || serverRow.dataset.refreshing === 'true') return;

	const btn = serverRow.querySelector('.refresh-streamer');
	serverRow.dataset.refreshing = 'true';
	btn.textContent = 'Refreshing...';
	applyStreamerLock(serverRow);
	try {
		const data = parseStreamerIngests(await fetchStreamerIngests(streamerName));
		// Streamer was changed/cleared while fetching - drop the stale result
		if (getStreamerName(serverRow) !== streamerName) return;

		renderStreamerData(serverRow, data, Date.now());
		document.querySelector('form').dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
	}
	finally {
		delete serverRow.dataset.refreshing;
		btn.textContent = 'Refresh';
		applyStreamerLock(serverRow);
	}
}

/**
 * Refresh every server with a streamer set, reporting all failures in a single alert
 * @param {HTMLElement[]} serverRows
 */
async function refreshStreamers(serverRows) {
	const targets = serverRows.filter((row) => getStreamerName(row));
	const results = await Promise.allSettled(targets.map((row) => refreshStreamer(row)));
	const names = getServerNames();
	const allRows = Array.from(document.querySelectorAll('.server-row'));
	const failures = results
	.map((result, i) => ({ result, row: targets[i] }))
	.filter(({ result }) => result.status === 'rejected')
	.map(({ result, row }) => `${names[allRows.indexOf(row)] ?? 'Server'} (${getStreamerName(row)}): ${result.reason?.message ?? result.reason}`);
	if (failures.length) {
		console.error('Error refreshing streamer settings', failures);
		window.alert(`Failed to refresh streamer settings:\n${failures.join('\n')}`);
	}
}

let serverRowNonce = 0;

const EXPANDED_SERVERS_KEY = 'multiObsController.expandedServers';
const expandedServerIds = new Set((() => {
	try {
		const stored = JSON.parse(localStorage.getItem(EXPANDED_SERVERS_KEY));
		return Array.isArray(stored) ? stored : [];
	}
	catch {
		return [];
	}
})());

function setServerExpanded(row, expanded) {
	row.classList.toggle('collapsed', !expanded);
	if (expanded) expandedServerIds.add(row.dataset.id);
	else expandedServerIds.delete(row.dataset.id);
	try {
		localStorage.setItem(EXPANDED_SERVERS_KEY, JSON.stringify([...expandedServerIds]));
	}
	catch {
	}
}

/**
 * Refresh the collapsed-row summary (address + IRLTK flag) and the item counts shown on each
 * IRLTK subsection dropdown, so the useful bits stay visible while things are collapsed
 */
function refreshServerSummaries() {
	const rows = Array.from(document.querySelectorAll('.server-row'));
	document.querySelector('#refreshAllStreamers').disabled = !rows.some((row) => getStreamerName(row));
	rows.forEach((row) => {
		applyStreamerLock(row);
		const ip = row.querySelector('input[name="serverIp"]').value.trim();
		const port = row.querySelector('input[name="serverPort"]').value.trim();
		const irltk = row.querySelector('input[name="serverIrltk"]').checked;
		const streamer = getStreamerName(row);
		const address = ip ? `${ip}${port ? `:${port}` : ''}` : 'Not configured';
		row.querySelector('.server-row-summary').textContent = irltk ? `${address} · IRLTK${streamer ? ` (${streamer})` : ''}` : address;

		const setCount = (selector, count) => {
			row.querySelector(`${selector} .count`).textContent = count ? `(${count})` : '';
		};
		setCount('.server-pinned-ingests', Array.from(row.querySelectorAll('input[name="ingestPinned"]')).filter((el) => el.value.trim()).length);
		setCount('.server-ingest-scenes', streamer
			? row.querySelectorAll('.streamer-scene-row').length
			: Array.from(row.querySelectorAll('.ingest-scene-row')).filter((r) => r.querySelector('input[name="ingestSceneIngest"]').value.trim() || r.querySelector('input[name="ingestSceneScene"]').value.trim()).length);
		setCount('.server-ingest-aliases', Array.from(row.querySelectorAll('input[name="ingestAliasName"]')).filter((el) => el.value.trim()).length);
	});
}

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
	const exportSelectId = `serverExport-${serverRowNonce++}`;
	const retryInterval = escapeHtml(server.retryIntervalS || '');
	const streamer = escapeHtml(server.streamer || '');
	const irltkOnlyStyle = checked ? '' : 'display: none;';
	const pinnedIngests = Array.isArray(server.ingestPinned)
		? server.ingestPinned
		: server.ingestPinned ? [server.ingestPinned] : server.streamer ? [] : [''];
	const pinnedIngestRows = pinnedIngests.map((value) => pinnedIngestRowHtml(value)).join('');
	const ingestSceneMap = Array.isArray(server.ingestSceneMap) && server.ingestSceneMap.length
		? server.ingestSceneMap
		: [{ ingest: '', scene: '' }];
	const ingestSceneRows = ingestSceneMap.map((m) => ingestSceneRowHtml(m.ingest, m.scene)).join('');
	const ingestAliasOverrideNames = [...new Set([...Object.keys(server.ingestAlias || {}), ...Object.keys(server.ingestCategory || {})])];
	const ingestAliasRows = ingestAliasOverrideNames
	.map((overrideName) => ingestAliasRowHtml(overrideName, server.ingestAlias?.[overrideName] || '', server.ingestCategory?.[overrideName] || ''))
	.join('');
	const collapsed = expandedServerIds.has(id) ? '' : 'collapsed';
	return `
	<div class="server-row ${collapsed}" data-id="${id}" data-streamer-fetched-at="${Number(server.streamerFetchedAt) || ''}">
		<div class="server-row-header">
			<button class="toggle" title="Show/hide server settings"></button>
			<input id="${exportSelectId}" class="export-select" type="checkbox" checked>
			<label for="${exportSelectId}" class="export-select-label" title="Include this server when exporting"><span></span></label>
			<span class="connection-status" title="Disconnected"></span>
			<input type="text" name="serverName" value="${name}" title="Custom display name for this OBS server, shown wherever a target OBS is picked">
			<span class="server-row-summary"></span>
			<div class="buttons">
				<button class="down icon-button icon-down" title="Move down"></button>
				<button class="up icon-button icon-up" title="Move up"></button>
				<button class="remove icon-button icon-remove" title="Remove"></button>
			</div>
		</div>
		<div class="server-row-body">
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
			<div class="field-label">Retry (s)</div>
			<input type="number" name="serverRetryInterval" value="${retryInterval}" min="2" max="30" placeholder="10" title="How often to retry connecting while this server is disconnected, in seconds (2-30, default 10)">
		</div>
		<div class="server-row-line">
			<div class="field-label"></div>
			<input id="${irltkId}" type="checkbox" name="serverIrltk" value="true" ${checked}>
			<label for="${irltkId}" title="Managed by IRLToolkit - the only servers offered to IRLToolkit actions, and hidden from actions IRLToolkit itself disables"><span></span>Managed by IRLToolkit</label>
		</div>
		<div class="server-row-line irltk-only" style="${irltkOnlyStyle}">
			<div class="field-label">Streamer</div>
			<input type="text" name="serverStreamer" value="${streamer}" placeholder="None" style="flex: 1 0 0;" title="Streamer name in the 1a3.uk userscript settings API. When set, this server's Pinned Ingests, Ingest Aliases &amp; Categories and Ingest → Scene Mapping come from that streamer's settings and are read-only here">
			<button class="refresh-streamer" title="Re-fetch this streamer's settings, overwriting this server's Pinned Ingests and Ingest Aliases &amp; Categories">Refresh</button>
		</div>
		<details class="server-subsection server-pinned-ingests irltk-only" style="${irltkOnlyStyle}">
			<summary title="Ingest names (as shown in IRLToolkit), sorted first within their category in this order, when using dynamic ingest position targeting on this server">Pinned Ingests <span class="count"></span></summary>
			<div class="streamer-locked-note">Set from the streamer's settings - use Refresh to update.</div>
			<div class="pinned-ingest-items">${pinnedIngestRows}</div>
			<div class="server-row-line">
				<div class="field-label"></div>
				<button class="add-pinned-ingest" style="margin-left: auto;">Add pinned ingest</button>
			</div>
		</details>
		<details class="server-subsection server-ingest-scenes irltk-only" style="${irltkOnlyStyle}">
			<summary title="Maps each ingest (matched by OBS source name, so it survives IRLToolkit renames) to the scene it should switch to on this server, used by the IRLToolkit Ingest Scene action. While a streamer is set, the streamer's linked scenes (matched by ingest name) are used instead">Ingest → Scene Mapping <span class="count"></span></summary>
			<div class="streamer-locked-note">Linked scenes from the streamer's settings (by ingest name) - use Refresh to update. The mapping set here is used again if the streamer is cleared.</div>
			<div class="streamer-scene-items">${streamerSceneRowsHtml(server.ingestScene)}</div>
			<div class="ingest-scene-items">${ingestSceneRows}</div>
			<div class="server-row-line add-ingest-scene-line">
				<div class="field-label"></div>
				<button class="add-ingest-scene" style="margin-left: auto;">Add mapping</button>
			</div>
		</details>
		<details class="server-subsection server-ingest-aliases irltk-only" style="${irltkOnlyStyle}">
			<summary title="Optional display name and/or category for each IRLToolkit ingest on this server, matched by ingest name (as shown in IRLToolkit, which doesn't support renaming ingests)">Ingest Aliases &amp; Categories <span class="count"></span></summary>
			<div class="streamer-locked-note">Set from the streamer's settings - use Refresh to update.</div>
			<div class="ingest-alias-items">${ingestAliasRows}</div>
			<div class="server-row-line">
				<div class="field-label"></div>
				<button class="add-ingest-alias" style="margin-left: auto;">Add alias</button>
			</div>
		</details>
		</div>
	</div>
	`;
}

function addServerRow(server = {}) {
	if (document.querySelectorAll('.server-row').length >= MAX_SERVERS) return;
	document.querySelector('.server-items').insertAdjacentHTML('beforeend', serverRowHtml(server));
	refreshServerUI();
	renderConnectionStatus();
}

const CONNECTION_STATUS_POLL_MS = 2000;

// Server id -> whether the plugin is connected to it, from the last poll
let connectionStatus = {};

function renderConnectionStatus() {
	document.querySelectorAll('.server-row').forEach((row) => {
		const online = !!connectionStatus[row.dataset.id];
		const dot = row.querySelector('.connection-status');
		dot.classList.toggle('online', online);
		dot.title = online ? 'Connected' : 'Disconnected';
	});
}

async function pollConnectionStatus() {
	if (!window.opener || window.opener.closed) return;
	try {
		connectionStatus = await window.opener.getConnectionStatus();
		renderConnectionStatus();
	}
	catch (e) {
		console.error('Error loading connection status', e);
	}
	finally {
		setTimeout(pollConnectionStatus, CONNECTION_STATUS_POLL_MS);
	}
}

function refreshServerUI() {
	const rows = Array.from(document.querySelectorAll('.server-row'));
	rows.forEach((row, i) => {
		row.querySelector('input[name="serverName"]').placeholder = `OBS #${i + 1}`;
	});
	document.querySelector('#addServer').disabled = rows.length >= MAX_SERVERS;
	syncSelectAll('#exportSelectAll', '.server-items', '.export-select');
	renderTargetOptions();
	refreshServerSummaries();
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
	const newRow = document.querySelector('.server-items .server-row:last-child');
	if (newRow) setServerExpanded(newRow, true);
	document.querySelector('form').dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
});

// Keep collapsed summaries/counts in sync with any edit (including programmatic input events)
document.querySelector('form').addEventListener('input', () => refreshServerSummaries());

document.querySelector('.server-items').addEventListener('click', (e) => {
	if (!e.target.matches('button')) return;
	e.preventDefault();
	if (e.target.disabled) return;

	if (e.target.matches('.toggle')) {
		const serverRow = e.target.closest('.server-row');
		setServerExpanded(serverRow, serverRow.classList.contains('collapsed'));
		return;
	}

	if (e.target.matches('.add-pinned-ingest')) {
		e.target.closest('.server-pinned-ingests').querySelector('.pinned-ingest-items')
		.insertAdjacentHTML('beforeend', pinnedIngestRowHtml());
		document.querySelector('form').dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
		return;
	}

	if (e.target.matches('.refresh-streamer')) {
		refreshStreamers([e.target.closest('.server-row')]);
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
		e.target.closest('.server-row').querySelectorAll('.irltk-only').forEach((el) => {
			el.style.display = e.target.checked ? '' : 'none';
		});
	}
	if (e.target.matches('input[name="ingestSceneIngest"], input[name="ingestSceneScene"]')) {
		refreshIngestSceneDatalists(e.target.closest('.server-row'));
	}
	if (e.target.matches('input[name="ingestAliasName"]')) {
		refreshIngestAliasOverrideDatalists(e.target.closest('.server-row'));
	}
});

// Fetch the streamer's settings as soon as a (new) streamer name is committed
document.querySelector('.server-items').addEventListener('change', (e) => {
	if (e.target.matches('input[name="serverStreamer"]')) refreshStreamers([e.target.closest('.server-row')]);
});

document.querySelector('#refreshAllStreamers').addEventListener('click', (e) => {
	e.preventDefault();
	refreshStreamers(Array.from(document.querySelectorAll('.server-row')));
});

function serializeFormValue(formEl) {
	const { serverName, serverIp, serverPort, serverPwd, ...rest } = getFormValue(formEl);
	delete rest.serverIrltk;
	delete rest.serverStreamer;
	delete rest.serverSecure;
	delete rest.serverRetryInterval;
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
			streamer: row.querySelector('input[name="serverStreamer"]').value.trim() || undefined,
			streamerFetchedAt: Number(row.dataset.streamerFetchedAt) || undefined,
			secure: row.querySelector('input[name="serverSecure"]').checked ? 'true' : undefined,
			retryIntervalS: row.querySelector('input[name="serverRetryInterval"]').value || undefined,
			ingestPinned: Array.from(row.querySelectorAll('input[name="ingestPinned"]')).map((el) => el.value),
			ingestSceneMap: Array.from(row.querySelectorAll('.ingest-scene-row')).map((r) => ({
				ingest: r.querySelector('input[name="ingestSceneIngest"]').value,
				scene: r.querySelector('input[name="ingestSceneScene"]').value,
			})).filter((m) => m.ingest || m.scene),
			ingestScene: Object.fromEntries(Array.from(row.querySelectorAll('.streamer-scene-row')).map((r) => [r.dataset.name, r.dataset.scene])),
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

/**
 * Called by the inspector when the plugin saves global settings while this window is open (e.g. a
 * background streamer refresh): show the newer streamer data in place - those lists are read-only
 * while a streamer is set, so there are no edits here to lose - and adopt the plugin's other changes
 * so this window's next save doesn't revert them
 * @param {Record<string, any>} settings
 */
window.onExternalGlobalSettings = (settings) => {
	const latestServers = resolveServers(settings);
	document.querySelectorAll('.server-row').forEach((row) => {
		const server = latestServers.find((s) => s.id === row.dataset.id);
		const streamer = getStreamerName(row);
		if (!server || !streamer || server.streamer !== streamer || row.dataset.refreshing === 'true') return;
		if ((server.streamerFetchedAt ?? 0) <= (Number(row.dataset.streamerFetchedAt) || 0)) return;
		renderStreamerData(row, server, server.streamerFetchedAt);
	});
	refreshServerSummaries();
	globalSettings = stripGlobalIngestAliases({ ...settings, ...serializeFormValue(document.querySelector('form')) });
};

window.onload = () => {
	const formEl = document.querySelector('form');

	// Load global settings to form
	globalSettings = window.opener.getGlobalSettings();

	resolveServersFromSettings(globalSettings).forEach((server) => addServerRow(server));
	refreshServerUI();

	FormUtils.setFormValue(cloneForForm(), formEl);
	renderTargetOptions();

	window.opener.getGlobalLists().then(({ ingestsLists, scenesLists }) => {
		Array.from(document.querySelectorAll('.server-row')).forEach((row, i) => {
			ingestSceneListsByServer.set(row, { ingests: ingestsLists[i] ?? [], scenes: scenesLists[i] ?? [] });
			refreshIngestSceneDatalists(row);
			refreshIngestAliasOverrideDatalists(row);
		});
		return;
	}).catch((e) => console.error('Error loading ingest/scene alias lists', e));

	pollConnectionStatus();

	formEl.addEventListener(
		'input',
		Utils.debounce(500, () => {
			// Ingest aliases/categories now live on each server (migrated by resolveServers)
			globalSettings = stripGlobalIngestAliases({ ...globalSettings, ...serializeFormValue(formEl) });
			window.opener.sendGlobalSettingsToInspector(globalSettings);
		}),
	);
};

function setTransferStatus(message) {
	document.querySelector('#settingsTransferStatus').textContent = message;
}

/** Servers ticked for export via the checkbox in each server row's header */
function getExportServers() {
	const ids = new Set(Array.from(document.querySelectorAll('.server-row'))
	.filter((row) => row.querySelector('.export-select').checked)
	.map((row) => row.dataset.id));
	return serializeFormValue(document.querySelector('form')).servers.filter((server) => ids.has(server.id));
}

/**
 * Wire a "select all" checkbox to a group of checkboxes: toggling it ticks/unticks them all, and it
 * stays ticked only while every one of them is ticked
 * @param {string} masterSelector
 * @param {string} containerSelector Element holding the group (listened to, so rows added later work too)
 * @param {string} boxSelector
 */
function wireSelectAll(masterSelector, containerSelector, boxSelector) {
	const boxes = () => Array.from(document.querySelectorAll(`${containerSelector} ${boxSelector}`));
	document.addEventListener('change', (e) => {
		const master = document.querySelector(masterSelector);
		if (!master) return;
		if (e.target === master) {
			boxes().forEach((box) => { box.checked = master.checked; });
		}
		else if (e.target.matches(`${containerSelector} ${boxSelector}`)) {
			syncSelectAll(masterSelector, containerSelector, boxSelector);
		}
	});
}

function syncSelectAll(masterSelector, containerSelector, boxSelector) {
	const master = document.querySelector(masterSelector);
	if (!master) return;
	const boxes = Array.from(document.querySelectorAll(`${containerSelector} ${boxSelector}`));
	master.checked = boxes.length > 0 && boxes.every((box) => box.checked);
}

wireSelectAll('#exportSelectAll', '.server-items', '.export-select');
wireSelectAll('#importSelectAll', '#importServerOptions', 'input:not(#importSelectAll)');

function resetImportList() {
	pendingImportServers = [];
	document.querySelector('#importServerOptions').replaceChildren();
	document.querySelector('#importServerOptionsRow').style.display = 'none';
	document.querySelector('#importSettings').disabled = true;
}

function openTransferPopup() {
	const count = getExportServers().length;
	const exportBtn = document.querySelector('#exportSettings');
	exportBtn.textContent = `Export ${count} selected server${count === 1 ? '' : 's'}`;
	exportBtn.disabled = !count;
	document.querySelector('#settingsTransferText').value = '';
	resetImportList();
	setTransferStatus(count ? '' : 'Tick the checkbox next to a server\'s name to include it in an export.');
	document.querySelector('#transferPopup').hidden = false;
}

function closeTransferPopup() {
	document.querySelector('#transferPopup').hidden = true;
}

document.querySelector('#openTransfer').addEventListener('click', (e) => {
	e.preventDefault();
	openTransferPopup();
});
document.querySelector('#closeTransfer').addEventListener('click', closeTransferPopup);
document.querySelector('#transferPopup').addEventListener('click', (e) => {
	if (e.target.id === 'transferPopup') closeTransferPopup();
});
document.addEventListener('keydown', (e) => {
	if (e.key === 'Escape' && !document.querySelector('#transferPopup').hidden) closeTransferPopup();
});

// Servers parsed from the pasted import text, waiting for the user to pick which to import
let pendingImportServers = [];

function parseImportServers(text) {
	const parsed = JSON.parse(text);
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Not an object');
	// Also accept a full settings export (e.g. from the original plugin with ip1/port1/pwd1...)
	const hasServers = Array.isArray(parsed.servers) || Object.keys(parsed).some((key) => /^(ip|port|pwd)\d+$/.test(key));
	if (!hasServers) throw new Error('No servers');
	return resolveServersFromSettings(parsed);
}

document.querySelector('#settingsTransferText').addEventListener('input', (e) => {
	resetImportList();
	if (!e.target.value.trim()) {
		setTransferStatus('');
		return;
	}
	try {
		pendingImportServers = parseImportServers(e.target.value);
	}
	catch {
		setTransferStatus('Invalid settings text.');
		return;
	}

	const selectAllHtml = pendingImportServers.length > 1 ? `
		<div class="import-option select-all">
			<input id="importSelectAll" type="checkbox" checked>
			<label for="importSelectAll"><span></span>Select all</label>
		</div>
	` : '';
	document.querySelector('#importServerOptions').innerHTML = selectAllHtml + pendingImportServers.map((server, i) => {
		const name = server.name || `OBS #${i + 1}`;
		const label = server.ip ? `${name} (${server.ip}${server.port ? `:${server.port}` : ''})` : name;
		const id = `importServer-${i}`;
		return `
			<div class="import-option">
				<input id="${id}" type="checkbox" value="${escapeHtml(server.id)}" checked>
				<label for="${id}" title="${escapeHtml(label)}"><span></span>${escapeHtml(label)}</label>
			</div>
		`;
	}).join('');
	document.querySelector('#importServerOptionsRow').style.display = '';
	document.querySelector('#importSettings').disabled = false;
	setTransferStatus('Choose which servers to import, then click Import.');
});

document.querySelector('#exportSettings').addEventListener('click', (e) => {
	e.preventDefault();
	const servers = getExportServers();
	if (!servers.length) return;
	const textEl = document.querySelector('#settingsTransferText');
	textEl.value = JSON.stringify({ servers });
	textEl.select();
	resetImportList();
	setTransferStatus(`Copy the text above (Ctrl+C) and import it in the other install. ${servers.length} server${servers.length === 1 ? '' : 's'} exported.`);
});

document.querySelector('#importSettings').addEventListener('click', (e) => {
	e.preventDefault();
	const ids = new Set(Array.from(document.querySelectorAll('#importServerOptions input:checked:not(#importSelectAll)')).map((el) => el.value));
	const toImport = pendingImportServers.filter((server) => ids.has(server.id));
	if (!toImport.length) {
		setTransferStatus('Choose at least one server to import.');
		return;
	}

	// Servers with the same id are replaced in place; others are added, replacing any blank
	// placeholder servers (no address/password) first
	const isBlank = (server) => !server.ip && !server.port && !server.pwd;
	let { servers } = serializeFormValue(document.querySelector('form'));
	const added = [];
	toImport.forEach((server) => {
		const idx = servers.findIndex((s) => s.id === server.id);
		if (idx !== -1) servers[idx] = server;
		else added.push(server);
	});
	servers = servers.filter((server) => !added.length || !isBlank(server));
	servers.push(...added);
	const skipped = Math.max(0, servers.length - MAX_SERVERS);
	servers = servers.slice(0, MAX_SERVERS);

	globalSettings = stripGlobalIngestAliases({ ...globalSettings, servers });
	window.opener.sendGlobalSettingsToInspector(globalSettings);
	if (skipped) window.alert(`${skipped} server${skipped === 1 ? ' was' : 's were'} not imported - the maximum is ${MAX_SERVERS} servers.`);
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
