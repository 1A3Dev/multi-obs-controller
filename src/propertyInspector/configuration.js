import { FormUtils } from './utils.js';

// Must match MAX_SERVERS in src/plugin/sockets.ts
const MAX_SERVERS = 6;

function escapeHtml(str) {
	return str.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[c]));
}

// Short random id for a newly-created server - mirrors genServerId() in src/actions/globalSettings.ts
// (duplicated here since this file isn't part of the plugin's TS bundle). Non-numeric so it never
// collides with a legacy plain-index target/defaultTarget value (see resolveCheckedIds)
function genServerId() {
	return `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

// Resolve the configured server list, migrating in-memory from the legacy flat ip{n}/port{n}/pwd{n}
// keys (pre-dynamic-server-list) if no `servers` array has been saved yet, and backfilling a stable
// `id` onto any server that doesn't have one yet (the plugin backend is the one that actually persists
// backfilled ids - see app.ts - this is just so this window has something to render/save with in the
// meantime). Mirrors resolveServers() in src/actions/globalSettings.ts - duplicated here since this
// file isn't part of the plugin's TS bundle.
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

// Resolve a persisted defaultTarget value to the ids of every server row it refers to - the current
// array-of-ids shape (multi-select), or an older single-value shape from before multi-select/per-server
// ids existed: a lone id, a plain 1-based position, or '0'/empty for the old "All" (every server)
function resolveCheckedIds(rawTarget, rows) {
	const ids = rows.map((row) => row.dataset.id);
	if (Array.isArray(rawTarget)) return rawTarget.filter((id) => ids.includes(id));
	if (!rawTarget || rawTarget === '0') return ids;
	if (ids.includes(rawTarget)) return [rawTarget];
	const legacyIndex = parseInt(rawTarget, 10);
	return Number.isInteger(legacyIndex) && rows[legacyIndex - 1] ? [rows[legacyIndex - 1].dataset.id] : [];
}

// Like FormUtils.getFormValue, but keeps empty-string values instead of dropping them - needed so
// clearing an alias field actually overwrites the saved alias instead of leaving it untouched
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

const pinnedIngestRow = `
<div class="sdpi-item pinned-ingest-row">
	<div class="sdpi-item-label empty"></div>
	<div class="sdpi-item-value" style="display: flex; gap: 4px; align-items: center;">
		<input type="text" name="ingestPinned" style="flex: 1 0 0; min-width: 0;">
		<button class="down icon-button icon-down" title="Move down"></button>
		<button class="up icon-button icon-up" title="Move up"></button>
		<button class="remove icon-button icon-remove" title="Remove"></button>
	</div>
</div>
`;

function addPinnedIngestRow() {
	document.querySelector('.pinned-ingest-items').insertAdjacentHTML('beforeend', pinnedIngestRow);
}

document.querySelector('#addPinnedIngest').addEventListener('click', (e) => {
	e.preventDefault();
	addPinnedIngestRow();
	document.querySelector('form').dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
});

// Move/remove buttons work on whatever rows currently exist, added or not - a single delegated
// listener on the container covers all of them without needing to re-attach it on every add
document.querySelector('.pinned-ingest-items').addEventListener('click', (e) => {
	if (!e.target.matches('button')) return;
	e.preventDefault();
	const row = e.target.closest('.pinned-ingest-row');
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
	document.querySelector('form').dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
});

// Values are set directly here (rather than via FormUtils.setFormValue's parallel-array shifting, as
// pinned ingest rows use) because that mechanism can't correctly distribute a per-row checkbox state:
// unchecked checkboxes aren't submitted at all by FormData, which would desync a "serverIrltk" array
// from the row it belongs to. Reading initial values straight into the template sidesteps that entirely
let serverRowNonce = 0;

function serverRowHtml(server = {}) {
	const id = server.id || genServerId();
	const name = escapeHtml(server.name || '');
	const ip = escapeHtml(server.ip || '');
	const port = escapeHtml(server.port || '');
	const pwd = escapeHtml(server.pwd || '');
	const checked = server.irltk === 'true' ? 'checked' : '';
	const secureChecked = server.secure === 'true' ? 'checked' : '';
	// sdpi.css hides <input type="checkbox"> entirely and renders the visible box via the CSS sibling
	// selector `input:checked + label span` - the checkbox is functionally invisible without a label
	// right after it. Each row needs its own id/for pair since multiple rows exist at once
	const irltkId = `serverIrltk-${serverRowNonce++}`;
	const secureId = `serverSecure-${serverRowNonce++}`;
	// data-id carries this server's stable id along with the row (including through drag-reorder, which
	// just moves the DOM node) so a target saved elsewhere keeps pointing at the right server - see
	// serializeFormValue and renderTargetOptions
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
	</div>
	`;
}

function addServerRow(server = {}) {
	if (document.querySelectorAll('.server-row').length >= MAX_SERVERS) return;
	document.querySelector('.server-items').insertAdjacentHTML('beforeend', serverRowHtml(server));
	refreshServerUI();
}

// Keep name placeholders, the add button, and per-row remove buttons in sync with the current
// row count/order, then rebuild the Default Target options so their labels follow along
function refreshServerUI() {
	const rows = Array.from(document.querySelectorAll('.server-row'));
	rows.forEach((row, i) => {
		row.querySelector('input[name="serverName"]').placeholder = `OBS #${i + 1}`;
		row.querySelector('.remove').disabled = rows.length <= 1; // always keep at least one server
	});
	document.querySelector('#addServer').disabled = rows.length >= MAX_SERVERS;
	renderTargetOptions();
}

function getServerNames() {
	return Array.from(document.querySelectorAll('.server-row')).map((row, i) => {
		return row.querySelector('input[name="serverName"]').value.trim() || `OBS #${i + 1}`;
	});
}

// Rebuild the "Default Target" checkbox group from the current server rows (so renaming/adding/removing
// a server live-updates its options), preserving whichever options were previously checked if still
// valid. Values are each row's stable id (not its position) so the saved default survives reordering.
// There's no more standalone "All" option - checking every box is the multi-select equivalent
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

// Live-update the Default Target labels as the user types a server name, without waiting for the debounced save
document.querySelector('.server-items').addEventListener('input', (e) => {
	if (e.target.matches('input[name="serverName"]')) renderTargetOptions();
});

// Zips the parallel serverName/serverIp/serverPort/serverPwd arrays (or lone scalar values, when
// there's only one server row) produced by getFormValue() back into a `servers` array, and drops
// the legacy flat ip{n}/port{n}/pwd{n} keys once a `servers` array has taken over from them.
// The IRLTK checkbox is read straight from each row's DOM element instead: unchecked checkboxes
// aren't submitted by FormData at all, which would desync a "serverIrltk" array from its row
function serializeFormValue(formEl) {
	const { serverName, serverIp, serverPort, serverPwd, ...rest } = getFormValue(formEl);
	delete rest.serverIrltk;
	delete rest.serverSecure;
	const toArray = (v) => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
	const names = toArray(serverName);
	const ips = toArray(serverIp);
	const ports = toArray(serverPort);
	const pwds = toArray(serverPwd);
	const rows = Array.from(document.querySelectorAll('.server-row'));
	rest.servers = rows.map((row, i) => ({
		id: row.dataset.id,
		name: names[i] || '',
		ip: ips[i] || '',
		port: ports[i] || '',
		pwd: pwds[i] || '',
		irltk: row.querySelector('input[name="serverIrltk"]').checked ? 'true' : undefined,
		secure: row.querySelector('input[name="serverSecure"]').checked ? 'true' : undefined,
	}));
	Object.keys(rest).forEach((key) => {
		if (/^(ip|port|pwd)\d+$/.test(key)) delete rest[key];
	});
	return rest;
}

let globalSettings = {};

// FormUtils.setFormValue consumes array-valued settings (e.g. ingestPinned) via .shift(), mutating
// them in place - since it's called more than once here (once at load, again once the alias lists
// arrive), each call needs its own copy so the second call isn't handed an already-drained array.
// (Server row values aren't part of this - they're seeded directly into the row template instead)
function cloneForForm() {
	return { ...globalSettings, ingestPinned: Array.isArray(globalSettings.ingestPinned) ? [...globalSettings.ingestPinned] : globalSettings.ingestPinned };
}

window.onload = () => {
	const formEl = document.querySelector('form');

	// Load global settings to form
	globalSettings = window.opener.getGlobalSettings();

	// Build one row per already-saved pinned ingest (at least one, empty, if there are none) - the
	// rows must exist before setFormValue runs, since it fills same-named inputs in DOM order
	const pinnedIngests = Array.isArray(globalSettings.ingestPinned)
		? globalSettings.ingestPinned
		: globalSettings.ingestPinned ? [globalSettings.ingestPinned] : [''];
	pinnedIngests.forEach(() => addPinnedIngestRow());

	// Same idea for server rows: build them from the resolved (possibly migrated) server list before
	// setFormValue runs, then refresh the add/remove state and the Default Target options they feed
	resolveServersFromSettings(globalSettings).forEach((server) => addServerRow(server));
	refreshServerUI();

	FormUtils.setFormValue(cloneForForm(), formEl);
	renderTargetOptions();

	// Live-populate the ingest/scene alias rows, then re-apply saved settings since these inputs
	// didn't exist yet when the form was first populated
	window.opener.getGlobalLists().then(({ ingestsLists, scenesLists, connectedIngestSourceNames, connectedSceneNames }) => {
		const ingestNames = new Map(); // obs_source_name -> IRLToolkit name
		ingestsLists.flat().forEach((ingest) => ingestNames.set(ingest.obs_source_name, ingest.name));
		const sceneNames = new Set(scenesLists.flat().map((scene) => scene.sceneName));
		const connectedIngestNamesSet = new Set(connectedIngestSourceNames);
		const connectedSceneNamesSet = new Set(connectedSceneNames);

		// Neither the live list nor its last-known-while-connected fallback (see getLastKnownIngestNames/
		// getLastKnownScenes on the plugin side) has anything for a name that already has an alias saved -
		// e.g. the plugin hasn't connected to that server at all this session yet. Still surface it as an
		// editable row, using the raw name as its own label since the "real" display name was never seen
		Object.keys(globalSettings).forEach((key) => {
			const ingestMatch = key.match(/^ingestAlias__(.+)$/);
			if (ingestMatch && !ingestNames.has(ingestMatch[1])) ingestNames.set(ingestMatch[1], ingestMatch[1]);
			const sceneMatch = key.match(/^sceneAlias__(.+)$/);
			if (sceneMatch) sceneNames.add(sceneMatch[1]);
		});

		// A row only shows up here because it's either currently live somewhere, or has an
		// ingestAlias__/sceneAlias__ key in globalSettings (see above) - once a row's been rendered its key
		// sticks around in settings forever, since every input in this form gets resaved (even blank) on
		// any unrelated edit (see getFormValue). The delete button lets the user clear that out once a name
		// is confirmed gone: not currently live on any connected socket. Never shown for one that's merely
		// live on an offline socket right now - can't confirm that one's actually gone, so it's left alone
		document.querySelector('#ingestAliasList').innerHTML = [...ingestNames.entries()]
		.sort((a, b) => a[1].localeCompare(b[1]))
		.map(([sourceName, name]) => {
			const safeSource = escapeHtml(sourceName);
			const safeName = escapeHtml(name);
			const aliasKey = `ingestAlias__${sourceName}`;
			const categoryKey = `ingestCategory__${sourceName}`;
			const canDelete = !connectedIngestNamesSet.has(sourceName);
			return `
				<div class="sdpi-item">
					<div class="sdpi-item-label" title="${safeName}">${safeName}</div>
					<div class="sdpi-item-value" style="display: flex; gap: 4px; align-items: center;">
						<input style="flex: 1 0 0; min-width: 0;" type="text" name="ingestAlias__${safeSource}" placeholder="${safeName}">
						<select style="flex: 0 0 90px;" class="sdpi-item-value select" name="ingestCategory__${safeSource}">
							<option value="">Uncategorized</option>
							<option value="backpack">Backpack</option>
							<option value="phone">Phone</option>
							<option value="desktop">Desktop</option>
						</select>
						${canDelete ? `<button class="remove-alias icon-button icon-remove" title="Remove" data-alias-key="${escapeHtml(aliasKey)}" data-category-key="${escapeHtml(categoryKey)}"></button>` : ''}
					</div>
				</div>
			`;
		}).join('');

		document.querySelector('#sceneAliasList').innerHTML = [...sceneNames]
		.sort((a, b) => a.localeCompare(b))
		.map((sceneName) => {
			const safe = escapeHtml(sceneName);
			const aliasKey = `sceneAlias__${sceneName}`;
			const canDelete = !connectedSceneNamesSet.has(sceneName);
			return `
				<div class="sdpi-item">
					<div class="sdpi-item-label" title="${safe}">${safe}</div>
					<div class="sdpi-item-value" style="display: flex; gap: 4px; align-items: center;">
						<input style="flex: 1 0 0; min-width: 0;" type="text" name="sceneAlias__${safe}" placeholder="${safe}">
						${canDelete ? `<button class="remove-alias icon-button icon-remove" title="Remove" data-alias-key="${escapeHtml(aliasKey)}"></button>` : ''}
					</div>
				</div>
			`;
		}).join('');

		FormUtils.setFormValue(cloneForForm(), formEl);
	}).catch((e) => console.error('Error loading ingest/scene alias lists', e));

	// Send settings to property inspector on form edit. Merged on top of the last known global settings
	// (rather than replacing wholesale) so aliases for ingests/scenes not currently rendered as inputs -
	// e.g. because OBS was still connecting when this window opened - aren't wiped out by an unrelated edit
	formEl.addEventListener(
		'input',
		Utils.debounce(500, () => {
			globalSettings = { ...globalSettings, ...serializeFormValue(formEl) };
			window.opener.sendGlobalSettingsToInspector(globalSettings);
		}),
	);
};

// Delete a stale alias row (see the canDelete comment above) - drops its ingestAlias__/sceneAlias__ key
// (and whatever alias was saved under it, if any) from globalSettings, plus the row itself. Ingest rows
// also carry a data-category-key for the row's ingestCategory__ selection, dropped the same way -
// scene rows have no such attribute, so this is a no-op for them
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
document.querySelector('#sceneAliasList').addEventListener('click', removeAliasRow);

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
