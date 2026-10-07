import { mergeListsByKey, replayOnTargetChange, socketIndicesOf } from '../../propertyInspector/utils.js';

$PI.onSendToPropertyInspector('uk.1a3.multiobs.setcollection', replayOnTargetChange(['CollectionListLoaded'], ({ payload }) => {
	const { event, collectionsLists } = payload;

	if (event === 'CollectionListLoaded') {
		document.querySelectorAll('datalist').forEach((el) => {
			const collections = mergeListsByKey(collectionsLists, socketIndicesOf(el));
			const options = [...collections].reverse().map((collection) => {
				const option = document.createElement('option');
				option.value = collection;
				option.textContent = collection;
				return option;
			});
			el.replaceChildren(...options);
		});
	}
}));
