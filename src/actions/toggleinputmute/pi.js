$PI.onSendToPropertyInspector('dev.theca11.multiobs.toggleinputmute', ({ payload }) => {
	const { event, inputsLists } = payload;

	if (event === 'InputListLoaded') {
		document.querySelectorAll('datalist').forEach((el) => {
			// A tab's true socket index (see inspector.js's tab setup); the shared tab (2+ targets, no
			// individual settings) isn't tied to one server, so socket 0 is used as a fixed reference,
			// matching the shared blob's old "All"-mode convention
			const { socketIdx } = el.closest('.tab-container').dataset;
			const idx = socketIdx !== undefined ? Number(socketIdx) : 0;
			const options = [...(inputsLists[idx] ?? [])].reverse().map((input) => {
				const option = document.createElement('option');
				option.value = input.inputName;
				option.textContent = input.inputName;
				return option;
			});
			el.replaceChildren(...options);
		});
	}
});
