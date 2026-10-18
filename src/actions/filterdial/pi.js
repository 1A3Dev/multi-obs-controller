import { mergeListsByKey, replayOnTargetChange, socketIndicesOf } from '../../propertyInspector/utils.js';

$PI.onSendToPropertyInspector('uk.1a3.multiobs.filterdial', replayOnTargetChange(['SourceListLoaded'], ({ payload }) => {
	const { event, scenesLists, inputsLists } = payload;

	if (event === 'SourceListLoaded') {
		document.querySelectorAll('.sources > datalist').forEach((el) => {
			const indices = socketIndicesOf(el);
			const sceneOptions = mergeListsByKey(scenesLists, indices, 'sceneName').reverse().map((scene) => {
				const option = document.createElement('option');
				option.value = scene.sceneName;
				option.textContent = scene.sceneName;
				return option;
			});
			const inputOptions = mergeListsByKey(inputsLists, indices, 'inputName').reverse().map((input) => {
				const option = document.createElement('option');
				option.value = input.inputName;
				option.textContent = input.inputName;
				return option;
			});
			el.replaceChildren(...inputOptions, ...sceneOptions);
		});
	}
}));
