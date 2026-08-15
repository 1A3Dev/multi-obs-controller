$PI.onSendToPropertyInspector('dev.theca11.multiobs.setprofile', ({ payload }) => {
	const { event, profilesLists } = payload;

	if (event === 'ProfileListLoaded') {
		document.querySelectorAll('datalist').forEach((el) => {
			// A tab's true socket index (see inspector.js's tab setup); the shared tab (2+ targets, no
			// individual settings) isn't tied to one server, so socket 0 is used as a fixed reference,
			// matching the shared blob's old "All"-mode convention
			const { socketIdx } = el.closest('.tab-container').dataset;
			const idx = socketIdx !== undefined ? Number(socketIdx) : 0;
			const options = [...(profilesLists[idx] ?? [])].reverse().map((profile) => {
				const option = document.createElement('option');
				option.value = profile;
				option.textContent = profile;
				return option;
			});
			el.replaceChildren(...options);
		});
	}
});
