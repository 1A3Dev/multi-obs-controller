import { mergeListsByKey, socketIndicesOf } from '../../propertyInspector/utils.js';

$PI.onSendToPropertyInspector('uk.1a3.multiobs.mediainputcontroldial', ({ payload }) => {
	const { event, inputsLists } = payload;

	if (event === 'InputListLoaded') {
		document.querySelectorAll('datalist').forEach((el) => {
			const inputs = mergeListsByKey(inputsLists, socketIndicesOf(el), 'inputName');
			const options = [...inputs].reverse().map((input) => {
				const option = document.createElement('option');
				option.value = input.inputName;
				option.textContent = input.inputName;
				return option;
			});
			el.replaceChildren(...options);
		});
	}
});
