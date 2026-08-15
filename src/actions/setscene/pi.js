$PI.onSendToPropertyInspector('dev.theca11.multiobs.setscene', ({ payload }) => {
	const { event, scenesLists } = payload;

	if (event === 'SceneListLoaded') {
		document.querySelectorAll('datalist').forEach((el) => {
			// A tab's true socket index (see inspector.js's tab setup); the shared tab (2+ targets, no
			// individual settings) isn't tied to one server, so socket 0 is used as a fixed reference,
			// matching the shared blob's old "All"-mode convention
			const { socketIdx } = el.closest('.tab-container').dataset;
			const idx = socketIdx !== undefined ? Number(socketIdx) : 0;
			const options = [...(scenesLists[idx] ?? [])].reverse().map((scene) => {
				const option = document.createElement('option');
				option.value = scene.sceneName;
				option.textContent = scene.sceneName;
				return option;
			});
			el.replaceChildren(...options);
		});
	}
});
