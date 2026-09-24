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

function renderSceneList(container) {
	const tabContainer = container.closest('.tab-container');
	const params = getTabParams(tabContainer, latestSettings);
	const liveScenes = mergeListsByKey(cachedScenesLists, socketIndicesOf(tabContainer), 'sceneName');
	const sceneNames = liveScenes.length
		? liveScenes.map((scene) => scene.sceneName)
		: getExcludedSceneNames(params);

	const rows = [...new Set(sceneNames)].reverse().map((sceneName, rowIdx) => {
		const name = escapeHtml(sceneName);
		const excludeId = `sceneExclude-${tabContainer.id}-${rowIdx}`;
		return `
			<div class="sdpi-item">
				<div class="sdpi-item-label" title="${name}">${name}</div>
				<div class="sdpi-item-value" style="display: flex; gap: 8px; align-items: center;">
					<input type="checkbox" id="${excludeId}" name="exclude__${name}" value="true">
					<label for="${excludeId}" style="white-space: nowrap; margin: 0; display: flex; align-items: center;"><span></span>${$PI.localize('Exclude')}</label>
				</div>
			</div>
		`;
	});
	container.innerHTML = rows.join('');

	const form = tabContainer.querySelector('form');
	if (form) FormUtils.setFormValue(params, form);
}

function renderAllSceneLists() {
	document.querySelectorAll('.scene-config-list').forEach((container) => renderSceneList(container));
}

$PI.onSendToPropertyInspector('uk.1a3.multiobs.scenepreviewdial', ({ payload }) => {
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

$PI.onDidReceiveSettings('uk.1a3.multiobs.scenepreviewdial', ({ payload }) => {
	latestSettings = payload.settings;
	renderAllSceneLists();
	localizeUI();
});
