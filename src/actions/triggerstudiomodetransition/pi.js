import { mergeListsByKey, socketIndicesOf } from '../../propertyInspector/utils.js';

let transitionsLists = [];

$PI.onSendToPropertyInspector('uk.1a3.multiobs.triggerstudiomodetransition', ({ payload }) => {
	const { event } = payload;

	if (event === 'TransitionListLoaded') {
		({ transitionsLists } = payload);
		document.querySelectorAll('.transitions > datalist').forEach((el) => {
			const transitions = mergeListsByKey(transitionsLists, socketIndicesOf(el), 'transitionName');
			const options = transitions.map((transition) => {
				const option = document.createElement('option');
				option.value = transition.transitionName;
				option.textContent = transition.transitionName;
				return option;
			});
			el.replaceChildren(...options);
		});
		document.querySelectorAll('input[name="transitionName"]').forEach((el) => updateDurationField(el));
	}
});

function updateDurationField(input) {
	const durationField = input.closest('form')?.querySelector('.duration-field');
	if (!durationField) return;
	const transitions = mergeListsByKey(transitionsLists, socketIndicesOf(input), 'transitionName');
	const match = transitions.find((transition) => transition.transitionName === input.value);
	durationField.style.display = match?.transitionFixed ? 'none' : '';
}

document.querySelectorAll('input[name="transitionName"]').forEach((el) => {
	el.addEventListener('input', () => updateDurationField(el));
});
