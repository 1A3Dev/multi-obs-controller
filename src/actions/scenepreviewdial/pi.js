import { FormUtils, localizeUI, mergeListsByKey, socketIndicesOf, getTabParams } from '../../propertyInspector/utils.js';
import { DIAL_MOVE_PREFIX, DIAL_ORDER_TOP, getDialSceneMoves, isDialSeparatorScene, orderDialScenes } from '../../shared/constants.js';

function escapeHtml(str) {
	return str.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[c]));
}

let cachedScenesLists = [];
let latestSettings = null;

/** <scene list container, { sceneNames in OBS order, whether they came from OBS (else from the saved settings) }> */
const listStates = new WeakMap();

function toArray(value) {
	return Array.isArray(value) ? value : value ? [value] : [];
}

/** Scenes with an exclusion, dial label or move saved (plus move anchors), so they can still be listed while OBS is offline */
function getConfiguredSceneNames(params) {
	return Object.entries(params ?? {}).flatMap(([key, value]) => {
		const sceneName = key.slice(key.indexOf('__') + 2);
		if (key.startsWith('exclude__') && value === 'true') return [sceneName];
		if (key.startsWith('label__') && value) return [sceneName];
		if (key.startsWith(DIAL_MOVE_PREFIX) && value) return value === DIAL_ORDER_TOP ? [sceneName] : [sceneName, value];
		return [];
	});
}

const getRows = (container) => Array.from(container.querySelectorAll('.scene-row'));

/** Moves as currently shown in the list (possibly unsaved) */
function getListMoves(container) {
	return new Map(getRows(container)
	.filter((row) => row.dataset.moved === 'true')
	.map((row) => [row.dataset.scene, row.querySelector('input[type="hidden"]').value]));
}

/** Shows each row's moved state and saves its anchor in its hidden input - only enabled (so saved) for moved rows */
function setRowMove(row, anchor) {
	const moved = anchor !== undefined;
	const input = row.querySelector('input[type="hidden"]');
	row.dataset.moved = String(moved);
	input.value = anchor ?? '';
	input.disabled = !moved;
	row.querySelector('button.revert').style.visibility = moved ? 'visible' : 'hidden';
}

/** Re-anchors every moved row to the row now right above it, then un-marks moved rows that are back where OBS would put them anyway */
function syncMovesToRows(container) {
	const rows = getRows(container);
	rows.forEach((row, idx) => {
		if (row.dataset.moved === 'true') setRowMove(row, idx ? rows[idx - 1].dataset.scene : DIAL_ORDER_TOP);
	});

	// The OBS order isn't known while offline
	const { sceneNames, isLive } = listStates.get(container);
	if (!isLive) return;
	const shownOrder = rows.map((row) => row.dataset.scene).join('\n');
	for (const row of rows) {
		if (row.dataset.moved !== 'true') continue;
		const moves = getListMoves(container);
		moves.delete(row.dataset.scene);
		if (orderDialScenes(sceneNames, moves).join('\n') === shownOrder) setRowMove(row, undefined);
	}
}

/** Puts the rows in the order the given moves give, keeping any unsaved values in them */
function applyMoves(container, moves) {
	const { sceneNames } = listStates.get(container);
	const rows = getRows(container);
	const rowsByScene = new Map(rows.map((row) => [row.dataset.scene, row]));
	const order = orderDialScenes(sceneNames, moves);
	// Rows not in the OBS list (only while offline) stay at the end
	const newRows = [...order, ...rows.map((row) => row.dataset.scene).filter((sceneName) => !order.includes(sceneName))]
	.map((sceneName) => rowsByScene.get(sceneName));
	// Only move rows that are out of place - detaching every row makes the page lose its scroll position
	const scroller = document.scrollingElement;
	const { scrollTop } = scroller;
	newRows.forEach((row, idx) => {
		const current = container.children[idx];
		if (current !== row) container.insertBefore(row, current);
	});
	scroller.scrollTop = scrollTop;
	rows.forEach((row) => setRowMove(row, moves.get(row.dataset.scene)));
	// Any old full scene order is replaced by the per-scene moves
	container.parentElement.querySelectorAll('input[name="sceneOrder"]').forEach((el) => el.remove());
	syncMovesToRows(container);
}

function renderSceneList(container) {
	const tabContainer = container.closest('.tab-container');
	const params = getTabParams(tabContainer, latestSettings);
	// OBS lists scenes bottom first - flip each list before merging so extra scenes from later servers end up last, like on the dial
	const topFirstScenesLists = cachedScenesLists.map((scenes) => [...(scenes ?? [])].reverse());
	const liveScenes = mergeListsByKey(topFirstScenesLists, socketIndicesOf(tabContainer), 'sceneName');
	const isLive = liveScenes.length > 0;
	const legacyOrder = toArray(params.sceneOrder);
	const sceneNames = (isLive
		? [...new Set(liveScenes.map((scene) => scene.sceneName))]
		: [...new Set([...legacyOrder, ...getConfiguredSceneNames(params)])])
	// Separator scenes are always left out of the dial, so there's nothing to configure for them
	.filter((sceneName) => !isDialSeparatorScene(sceneName));
	listStates.set(container, { sceneNames, isLive });

	const moves = getDialSceneMoves(params, sceneNames);
	const hasSavedMoves = Object.keys(params).some((key) => key.startsWith(DIAL_MOVE_PREFIX));
	// Converted from an old full scene order, which can only be done against the OBS order
	const isLegacyOrder = !hasSavedMoves && legacyOrder.length > 0;

	const rows = orderDialScenes(sceneNames, moves).map((sceneName, rowIdx) => {
		const name = escapeHtml(sceneName);
		const excludeId = `sceneExclude-${tabContainer.id}-${rowIdx}`;
		return `
			<div class="sdpi-item scene-row" data-scene="${name}">
				<div class="sdpi-item-label" title="${name}" style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap; display: block;">${name}</div>
				<div class="sdpi-item-value" style="display: flex; gap: 6px; align-items: center; min-width: 0;">
					<input type="hidden" name="${DIAL_MOVE_PREFIX}${name}" disabled>
					<input type="text" name="label__${name}" placeholder="${name}" title="${$PI.localize('Scene label tooltip')}" style="flex: 1 1 0; width: 0; min-width: 0;">
					<input type="checkbox" id="${excludeId}" name="exclude__${name}" value="true">
					<label for="${excludeId}" style="white-space: nowrap; margin: 0; display: flex; align-items: center;"><span></span>${$PI.localize('Exclude')}</label>
					<button class="revert icon-button icon-revert" style="flex-shrink: 0;" title="${$PI.localize('Revert scene order tooltip')}"></button>
					<button class="down icon-button icon-down" style="flex-shrink: 0;" title="${$PI.localize('Move down')}"></button>
					<button class="up icon-button icon-up" style="flex-shrink: 0;" title="${$PI.localize('Move up')}"></button>
				</div>
			</div>
		`;
	});
	// While offline an old full scene order can't be converted yet, so it's kept as is
	const legacyInputs = isLegacyOrder && !isLive
		? legacyOrder.map((sceneName) => `<input type="hidden" name="sceneOrder" value="${escapeHtml(sceneName)}">`)
		: [];
	container.innerHTML = [...rows, ...legacyInputs].join('');
	getRows(container).forEach((row) => setRowMove(row, isLegacyOrder && !isLive ? undefined : moves.get(row.dataset.scene)));

	const form = tabContainer.querySelector('form');
	// The order is already applied through the row order and the hidden inputs above
	const formParams = Object.fromEntries(Object.entries(params).filter(([key]) => key !== 'sceneOrder' && !key.startsWith(DIAL_MOVE_PREFIX)));
	if (form) FormUtils.setFormValue(formParams, form);

	if (isLegacyOrder && isLive) {
		syncMovesToRows(container);
		form?.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
	}
}

function renderAllSceneLists() {
	document.querySelectorAll('.scene-config-list').forEach((container) => renderSceneList(container));
}

document.querySelectorAll('.scene-config-list').forEach((container) => {
	container.addEventListener('click', (e) => {
		if (!e.target.matches('button.up, button.down, button.revert')) return;
		e.preventDefault();
		const row = e.target.closest('.scene-row');
		if (e.target.matches('.revert')) {
			const moves = getListMoves(container);
			const sceneName = row.dataset.scene;
			// Scenes moved to right after this one stay where they are, rather than following it back
			for (const [movedSceneName, anchor] of moves) {
				if (anchor === sceneName) moves.set(movedSceneName, moves.get(sceneName));
			}
			moves.delete(sceneName);
			applyMoves(container, moves);
		}
		else if (e.target.matches('.up') && row.previousElementSibling?.matches('.scene-row')) {
			container.insertBefore(row, row.previousElementSibling);
			setRowMove(row, '');
			syncMovesToRows(container);
		}
		else if (e.target.matches('.down') && row.nextElementSibling?.matches('.scene-row')) {
			container.insertBefore(row.nextElementSibling, row);
			setRowMove(row, '');
			syncMovesToRows(container);
		}
		else {
			return;
		}
		container.closest('form').dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
	});
});

document.querySelectorAll('.reset-scene-order').forEach((button) => {
	button.addEventListener('click', (e) => {
		e.preventDefault();
		const form = button.closest('form');
		applyMoves(form.querySelector('.scene-config-list'), new Map());
		form.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
	});
});

$PI.onSendToPropertyInspector('dev.theca11.multiobs.scenepreviewdial', ({ payload }) => {
	const { event, scenesLists } = payload;
	if (event !== 'SceneListLoaded') return;
	cachedScenesLists = scenesLists;
	$PI.getSettings();
});

document.querySelectorAll('input[name="target"]').forEach((el) => {
	el.addEventListener('change', () => {
		if (!latestSettings) return;
		renderAllSceneLists();
	});
});

$PI.onDidReceiveSettings('dev.theca11.multiobs.scenepreviewdial', ({ payload }) => {
	latestSettings = payload.settings;
	renderAllSceneLists();
	localizeUI();
});
