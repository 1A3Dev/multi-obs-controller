// A tab's true socket index (see inspector.js's tab setup); the shared tab (2+ targets, no individual
// settings) isn't tied to one server, so socket 0 is used as a fixed reference, matching the shared
// blob's old "All"-mode convention
function socketIdxOf(el) {
	const { socketIdx } = el.closest('.tab-container').dataset;
	return socketIdx !== undefined ? Number(socketIdx) : 0;
}

$PI.onSendToPropertyInspector('dev.theca11.multiobs.togglesource', ({ payload }) => {
	const { event, scenesLists, sourceList } = payload;

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

// The "ignore state, toggle instead" checkbox only makes sense inside a multi-action - a normal key
// press already always toggles - so it's hidden the rest of the time
$PI.onDidReceiveSettings('dev.theca11.multiobs.togglesource', ({ payload: receiveSettingsPayload }) => {
	document.querySelectorAll('.multiaction-toggle-field').forEach((el) => {
		el.style.display = receiveSettingsPayload.isInMultiAction ? '' : 'none';
	});
});
$PI.getSettings();

document.querySelectorAll('input[name="sceneName"').forEach((el) => {
	const idx = socketIdxOf(el);
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
