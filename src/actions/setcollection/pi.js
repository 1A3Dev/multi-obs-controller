$PI.onSendToPropertyInspector('dev.theca11.multiobs.setcollection', ({ payload }) => {
	const { event, collectionsLists } = payload;

	if (event === 'CollectionListLoaded') {
		document.querySelectorAll('datalist').forEach((el) => {
			// A tab's true socket index (see inspector.js's tab setup); the shared tab (2+ targets, no
			// individual settings) isn't tied to one server, so socket 0 is used as a fixed reference,
			// matching the shared blob's old "All"-mode convention
			const { socketIdx } = el.closest('.tab-container').dataset;
			const idx = socketIdx !== undefined ? Number(socketIdx) : 0;
			const options = [...(collectionsLists[idx] ?? [])].reverse().map((collection) => {
				const option = document.createElement('option');
				option.value = collection;
				option.textContent = collection;
				return option;
			});
			el.replaceChildren(...options);
		});
	}
});
