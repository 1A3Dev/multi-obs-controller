import { mergeListsByKey, socketIndicesOf } from '../../propertyInspector/utils.js';

$PI.onSendToPropertyInspector('uk.1a3.multiobs.setscene', ({ payload }) => {
	const { event, scenesLists } = payload;

	if (event === 'SceneListLoaded') {
		document.querySelectorAll('datalist').forEach((el) => {
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
});
