import { mergeListsByKey, socketIndicesOf } from '../../propertyInspector/utils.js';

$PI.onSendToPropertyInspector('dev.theca11.multiobs.setcollection', ({ payload }) => {
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
});
