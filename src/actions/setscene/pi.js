import { mergeListsByKey, replayOnTargetChange, socketIndicesOf } from '../../propertyInspector/utils.js';

$PI.onSendToPropertyInspector('dev.theca11.multiobs.setscene', replayOnTargetChange(['SceneListLoaded'], ({ payload }) => {
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
}));
