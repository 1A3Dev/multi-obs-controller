import { mergeListsByKey, onTargetSelectionChange, socketIndicesOf } from '../../propertyInspector/utils.js';

const filterListsByEl = new WeakMap();

function renderFilterOptions(el) {
	const indices = socketIndicesOf(el);
	const results = filterListsByEl.get(el) ?? [];
	const options = mergeListsByKey(results, indices).map((filterName) => {
		const option = document.createElement('option');
		option.value = filterName;
		option.textContent = filterName;
		return option;
	});
	el.replaceChildren(...options);
}

$PI.onSendToPropertyInspector('uk.1a3.multiobs.togglefilter', ({ payload }) => {
	const { event, scenesLists, inputsLists, filterList } = payload;

	if (event === 'SourceListLoaded') {
		document.querySelectorAll('.sources > datalist').forEach((el) => {
			const indices = socketIndicesOf(el);
			const sceneOptions = mergeListsByKey(scenesLists, indices, 'sceneName').reverse().map((scene) => {
				const option = document.createElement('option');
				option.value = scene.sceneName;
				option.textContent = scene.sceneName;
				return option;
			});
			const inputOptions = mergeListsByKey(inputsLists, indices, 'inputName').reverse().map((input) => {
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
			const indices = socketIndicesOf(el);
			if (!indices.includes(payload.idx)) return;
			const results = filterListsByEl.get(el) ?? [];
			results[payload.idx] = filterList;
			filterListsByEl.set(el, results);
			renderFilterOptions(el);
		});
	}
});

document.querySelectorAll('input[name="sourceName"').forEach((sourceEl) => {
	const filterListEl = sourceEl.closest('.tab-container').querySelector('.filters > datalist');

	const query = () => {
		filterListsByEl.set(filterListEl, []);
		if (filterListEl) renderFilterOptions(filterListEl);
		socketIndicesOf(sourceEl).forEach((idx) => {
			$PI.sendToPlugin({
				event: 'GetSourceFilterList',
				socketIdx: idx,
				sourceName: sourceEl.value,
			});
		});
	};

	query();
	sourceEl.addEventListener('input', Utils.debounce(150, query));
	onTargetSelectionChange(() => query());
});
