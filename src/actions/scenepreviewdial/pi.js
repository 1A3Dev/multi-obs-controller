import { FormUtils, localizeUI, mergeListsByKey, socketIndicesOf, getTabParams } from '../../propertyInspector/utils.js';

function escapeHtml(str) {
	return str.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[c]));
}

let cachedScenesLists = [];
let latestSettings = null;

function getExcludedSceneNames(params) {
	return Object.keys(params ?? {})
	.filter((key) => key.startsWith('exclude__') && params[key] === 'true')
	.map((key) => key.slice('exclude__'.length));
}

function toArray(value) {
	return Array.isArray(value) ? value : value ? [value] : [];
}

/**
 * Scenes in the saved custom order first, then any not in it (e.g. newly added) in their OBS order
 * - keep in sync with ScenePreviewDialAction._getFilteredScenes
 */
function orderSceneNames(sceneNames, sceneOrder) {
	const ordered = sceneOrder.filter((name) => sceneNames.includes(name));
	return [...ordered, ...sceneNames.filter((name) => !ordered.includes(name))];
}

function renderSceneList(container, { resetOrder = false } = {}) {
	const tabContainer = container.closest('.tab-container');
	const params = getTabParams(tabContainer, latestSettings);
	const liveScenes = mergeListsByKey(cachedScenesLists, socketIndicesOf(tabContainer), 'sceneName');
	const sceneOrder = resetOrder ? [] : toArray(params.sceneOrder);
	const sceneNames = liveScenes.length
		? [...new Set(liveScenes.map((scene) => scene.sceneName))].reverse()
		: [...new Set([...sceneOrder, ...getExcludedSceneNames(params)])];
	// The order inputs stay disabled (so aren't saved) until the scenes are manually reordered
	const hasCustomOrder = sceneOrder.length > 0;

	const rows = orderSceneNames(sceneNames, sceneOrder).map((sceneName, rowIdx) => {
		const name = escapeHtml(sceneName);
		const excludeId = `sceneExclude-${tabContainer.id}-${rowIdx}`;
		return `
			<div class="sdpi-item scene-row">
				<div class="sdpi-item-label" title="${name}">${name}</div>
				<div class="sdpi-item-value" style="display: flex; gap: 8px; align-items: center;">
					<input type="hidden" name="sceneOrder" value="${name}" ${hasCustomOrder ? '' : 'disabled'}>
					<input type="checkbox" id="${excludeId}" name="exclude__${name}" value="true">
					<label for="${excludeId}" style="white-space: nowrap; margin: 0; display: flex; align-items: center;"><span></span>${$PI.localize('Exclude')}</label>
					<button class="down icon-button icon-down" style="margin-left: auto;" title="${$PI.localize('Move down')}"></button>
					<button class="up icon-button icon-up" title="${$PI.localize('Move up')}"></button>
				</div>
			</div>
		`;
	});
	container.innerHTML = rows.join('');

	const form = tabContainer.querySelector('form');
	// sceneOrder is already applied through the row order and would otherwise get spread over the hidden inputs
	const formParams = Object.fromEntries(Object.entries(params).filter(([key]) => key !== 'sceneOrder'));
	if (form) FormUtils.setFormValue(formParams, form);
}

function renderAllSceneLists() {
	document.querySelectorAll('.scene-config-list').forEach((container) => renderSceneList(container));
}

document.querySelectorAll('.scene-config-list').forEach((container) => {
	container.addEventListener('click', (e) => {
		if (!e.target.matches('button.up, button.down')) return;
		e.preventDefault();
		const row = e.target.closest('.scene-row');
		if (e.target.matches('.up') && row.previousElementSibling) {
			container.insertBefore(row, row.previousElementSibling);
		}
		else if (e.target.matches('.down') && row.nextElementSibling) {
			container.insertBefore(row.nextElementSibling, row);
		}
		else {
			return;
		}
		container.querySelectorAll('input[name="sceneOrder"]').forEach((el) => el.disabled = false);
		container.closest('form').dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
	});
});

document.querySelectorAll('.reset-scene-order').forEach((button) => {
	button.addEventListener('click', (e) => {
		e.preventDefault();
		const form = button.closest('form');
		const container = form.querySelector('.scene-config-list');
		// Keep the current (possibly unsaved) exclusions across the re-render
		const excluded = Array.from(container.querySelectorAll('input[name^="exclude__"]:checked')).map((el) => el.name);
		renderSceneList(container, { resetOrder: true });
		container.querySelectorAll('input[name^="exclude__"]').forEach((el) => el.checked = excluded.includes(el.name));
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
