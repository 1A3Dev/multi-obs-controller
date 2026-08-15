// A tab's true socket index (see inspector.js's tab setup); the shared tab (2+ targets, no individual
// settings) isn't tied to one server, so socket 0 is used as a fixed reference, matching the shared
// blob's old "All"-mode convention
function socketIdxOf(el) {
	const { socketIdx } = el.closest('.tab-container').dataset;
	return socketIdx !== undefined ? Number(socketIdx) : 0;
}

$PI.onSendToPropertyInspector('dev.theca11.multiobs.filtersettingdial', ({ payload }) => {
	const { event, scenesLists, inputsLists, filterList, settingKeys } = payload;

	if (event === 'SourceListLoaded') {
		document.querySelectorAll('.sources > datalist').forEach((el) => {
			const idx = socketIdxOf(el);
			const sceneOptions = [...(scenesLists[idx] ?? [])].reverse().map((scene) => {
				const option = document.createElement('option');
				option.value = scene.sceneName;
				option.textContent = scene.sceneName;
				return option;
			});
			const inputOptions = [...(inputsLists[idx] ?? [])].reverse().map((input) => {
				const option = document.createElement('option');
				option.value = input.inputName;
				option.textContent = input.inputName;
				return option;
			});
			el.replaceChildren(...inputOptions, ...sceneOptions);
		});
	}
	else if (event === 'FilterListLoaded') {
		document.querySelectorAll('.filters > datalist').forEach((el) => {
			if (socketIdxOf(el) === payload.idx) {
				const options = [...filterList].map((filterName) => {
					const option = document.createElement('option');
					option.value = filterName;
					option.textContent = filterName;
					return option;
				});
				el.replaceChildren(...options);
			}
		});
	}
	else if (event === 'SettingListLoaded') {
		document.querySelectorAll('.settings > datalist').forEach((el) => {
			if (socketIdxOf(el) === payload.idx) {
				const options = [...settingKeys].map((settingName) => {
					const option = document.createElement('option');
					option.value = settingName;
					option.textContent = settingName;
					return option;
				});
				el.replaceChildren(...options);
			}
		});
	}
});

document.querySelectorAll('input[name="sourceName"]').forEach((el) => {
	const idx = socketIdxOf(el);
	// Init call
	$PI.sendToPlugin({
		event: 'GetSourceFilterList',
		socketIdx: idx,
		sourceName: el.value,
	});

	// Attach listener
	el.addEventListener(
		'input',
		Utils.debounce(150, () => {
			$PI.sendToPlugin({
				event: 'GetSourceFilterList',
				socketIdx: idx,
				sourceName: el.value,
			});
		}),
	);
});

document.querySelectorAll('input[name="filterName"]').forEach((el) => {
	const idx = socketIdxOf(el);
	const sourceEl = el.closest('.tab-container').querySelector('input[name="sourceName"]');
	const trigger = () => $PI.sendToPlugin({
		event: 'GetFilterSettingKeys',
		socketIdx: idx,
		sourceName: sourceEl.value,
		filterName: el.value,
	});

	// Init call
	trigger();

	// Attach listener - re-fetch on either field changing, since the setting list depends on both
	el.addEventListener('input', Utils.debounce(150, trigger));
	sourceEl.addEventListener('input', Utils.debounce(150, trigger));
});
