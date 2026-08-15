// Mirrors the default step in SceneItemTransformDialAction.ts's PROPERTY_CONFIG - used only to hint the
// step field's placeholder, the plugin falls back to the same values on its own if left blank
const DEFAULT_STEPS = {
	positionX: 5,
	positionY: 5,
	rotation: 5,
	scaleX: 0.05,
	scaleY: 0.05,
	cropLeft: 5,
	cropTop: 5,
	cropRight: 5,
	cropBottom: 5,
};

$PI.onSendToPropertyInspector('dev.theca11.multiobs.sceneitemtransformdial', ({ payload }) => {
	const { event, scenesLists, sourceList } = payload;

	// A tab's true socket index (see inspector.js's tab setup); the shared tab (2+ targets, no
	// individual settings) isn't tied to one server, so socket 0 is used as a fixed reference,
	// matching the shared blob's old "All"-mode convention
	const socketIdxOf = (el) => {
		const { socketIdx } = el.closest('.tab-container').dataset;
		return socketIdx !== undefined ? Number(socketIdx) : 0;
	};

	if (event === 'SceneListLoaded') {
		document.querySelectorAll('.scenes > datalist').forEach((el) => {
			const options = [...(scenesLists[socketIdxOf(el)] ?? [])].reverse().map((scene) => {
				const option = document.createElement('option');
				option.value = scene.sceneName;
				option.textContent = scene.sceneName;
				return option;
			});
			el.replaceChildren(...options);
		});
	}
	else if (event === 'SourceListLoaded') {
		document.querySelectorAll('.sources > datalist').forEach((el) => {
			if (socketIdxOf(el) === payload.idx) {
				const options = [...sourceList].reverse().map((sourceName) => {
					const option = document.createElement('option');
					option.value = sourceName;
					option.textContent = sourceName;
					return option;
				});
				el.replaceChildren(...options);
			}
		});
	}
});

document.querySelectorAll('input[name="sceneName"]').forEach((el) => {
	const { socketIdx } = el.closest('.tab-container').dataset;
	const idx = socketIdx !== undefined ? Number(socketIdx) : 0;

	// Init call
	$PI.sendToPlugin({
		event: 'GetSceneItemsList',
		socketIdx: idx,
		sceneName: el.value,
	});

	// Attach listener
	el.addEventListener(
		'input',
		Utils.debounce(150, () => {
			$PI.sendToPlugin({
				event: 'GetSceneItemsList',
				socketIdx: idx,
				sceneName: el.value,
			});
		}),
	);
});

document.querySelectorAll('select[name="property"]').forEach((el) => {
	const stepInput = el.closest('form').querySelector('input[name="step"]');
	const updatePlaceholder = () => { stepInput.placeholder = DEFAULT_STEPS[el.value] ?? 5; };
	updatePlaceholder();
	el.addEventListener('change', updatePlaceholder);
});
