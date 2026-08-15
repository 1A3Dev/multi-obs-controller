import { mergeListsByKey, socketIndicesOf } from '../../propertyInspector/utils.js';

$PI.onSendToPropertyInspector('dev.theca11.multiobs.setprofile', ({ payload }) => {
	const { event, profilesLists } = payload;

	if (event === 'ProfileListLoaded') {
		document.querySelectorAll('datalist').forEach((el) => {
			const profiles = mergeListsByKey(profilesLists, socketIndicesOf(el));
			const options = [...profiles].reverse().map((profile) => {
				const option = document.createElement('option');
				option.value = profile;
				option.textContent = profile;
				return option;
			});
			el.replaceChildren(...options);
		});
	}
});
