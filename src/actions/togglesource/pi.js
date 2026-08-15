import { mergeListsByKey, onTargetSelectionChange, socketIndicesOf } from '../../propertyInspector/utils.js';

const sourceListsByEl = new WeakMap();

function renderSourceOptions(el) {
	const indices = socketIndicesOf(el);
	const results = sourceListsByEl.get(el) ?? [];
	const options = mergeListsByKey(results, indices).reverse().map((sourceName) => {
		const option = document.createElement('option');
		option.value = sourceName;
		option.textContent = sourceName;
		return option;
	});
	el.replaceChildren(...options);
}

$PI.onSendToPropertyInspector('dev.theca11.multiobs.togglesource', ({ payload }) => {
	const { event, scenesLists, sourceList } = payload;

	if (event === 'SceneListLoaded') {
		document.querySelectorAll('.scenes > datalist').forEach((el) => {
			const scenes = mergeListsByKey(scenesLists, socketIndicesOf(el), 'sceneName');
			const options = [...scenes].reverse().map((scene) => {
				const option = document.createElement('option');
				option.value = scene.sceneName;
				option.textContent = scene.sceneName;
				return option;
			});
			el.replaceChildren(...options);
		});
	}
	else if (event === 'SourceListLoaded') {
		document.querySelectorAll('.sources > datalist').forEach((el) => {
			const indices = socketIndicesOf(el);
			if (!indices.includes(payload.idx)) return;
			const results = sourceListsByEl.get(el) ?? [];
			results[payload.idx] = sourceList;
			sourceListsByEl.set(el, results);
			renderSourceOptions(el);
		});
	}
});

$PI.onDidReceiveSettings('dev.theca11.multiobs.togglesource', ({ payload: receiveSettingsPayload }) => {
	document.querySelectorAll('.multiaction-toggle-field').forEach((el) => {
		el.style.display = receiveSettingsPayload.isInMultiAction ? '' : 'none';
	});
});
$PI.getSettings();

document.querySelectorAll('input[name="sceneName"').forEach((sceneEl) => {
	const sourceListEl = sceneEl.closest('.tab-container').querySelector('.sources > datalist');

	const query = () => {
		sourceListsByEl.set(sourceListEl, []);
		if (sourceListEl) renderSourceOptions(sourceListEl);
		socketIndicesOf(sceneEl).forEach((idx) => {
			$PI.sendToPlugin({
				event: 'GetSceneItemsList',
				socketIdx: idx,
				sceneName: sceneEl.value,
			});
		});
	};

	query();
	sceneEl.addEventListener('input', Utils.debounce(150, query));
	onTargetSelectionChange(() => query());
});
