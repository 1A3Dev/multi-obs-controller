// A tab's true socket index (see inspector.js's tab setup); the shared tab (2+ targets, no individual
// settings) isn't tied to one server, so socket 0 is used as a fixed reference, matching the shared
// blob's old "All"-mode convention
function socketIdxOf(el) {
	const { socketIdx } = el.closest('.tab-container').dataset;
	return socketIdx !== undefined ? Number(socketIdx) : 0;
}

let transitionsLists = [];

$PI.onSendToPropertyInspector('dev.theca11.multiobs.triggerstudiomodetransition', ({ payload }) => {
	const { event } = payload;

	if (event === 'TransitionListLoaded') {
		({ transitionsLists } = payload);
		document.querySelectorAll('.transitions > datalist').forEach((el) => {
			const options = (transitionsLists[socketIdxOf(el)] ?? []).map((transition) => {
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

// Duration only applies to transitions that support a configurable duration - hide it otherwise (e.g.
// Cut, or most Stingers)
function updateDurationField(input) {
	const durationField = input.closest('form')?.querySelector('.duration-field');
	if (!durationField) return;
	const match = (transitionsLists[socketIdxOf(input)] ?? []).find((transition) => transition.transitionName === input.value);
	durationField.style.display = match?.transitionFixed ? 'none' : '';
}

document.querySelectorAll('input[name="transitionName"]').forEach((el) => {
	el.addEventListener('input', () => updateDurationField(el));
});
