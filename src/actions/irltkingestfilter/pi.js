import { mergeListsByKey, onTargetSelectionChange, replayOnTargetChange, socketIndicesOf } from '../../propertyInspector/utils.js';

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

$PI.onSendToPropertyInspector('dev.theca11.multiobs.irltkingestfilter', replayOnTargetChange(['IngestListLoaded'], ({ payload }) => {
	const { event, ingestsLists, pagingActive, filterList } = payload;

	if (event === 'IngestListLoaded') {
		document.querySelectorAll('.ingest-static-field > datalist').forEach((el) => {
			const ingests = mergeListsByKey(ingestsLists, socketIndicesOf(el), 'obs_source_name');
			const options = [...ingests].map((ingest) => {
				const option = document.createElement('option');
				option.value = ingest.obs_source_name;
				option.textContent = `${ingest.obs_source_name} (${ingest.name})`;
				return option;
			});
			el.replaceChildren(...options);
		});

		document.querySelectorAll('.online-only-field').forEach((el) => {
			el.style.display = pagingActive ? 'none' : '';
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
}));

document.querySelectorAll('input[name="ingestTargetMode"]').forEach((radio) => {
	radio.addEventListener('change', () => updateIngestModeFields(radio.closest('form')));
	updateIngestModeFields(radio.closest('form'));
});

function updateIngestModeFields(form) {
	if (!form) return;
	const isDynamic = form.querySelector('input[name="ingestTargetMode"]:checked')?.value === 'dynamic';
	const staticField = form.querySelector('.ingest-static-field');
	const dynamicFields = form.querySelectorAll('.ingest-dynamic-field');
	if (staticField) staticField.style.display = isDynamic ? 'none' : '';
	dynamicFields.forEach((field) => { field.style.display = isDynamic ? '' : 'none'; });
}

document.querySelectorAll('input[name="ingestSourceName"]').forEach((sourceEl) => {
	const form = sourceEl.closest('form');
	const filterListEl = sourceEl.closest('.tab-container').querySelector('.filters > datalist');

	const query = () => {
		filterListsByEl.set(filterListEl, []);
		if (filterListEl) renderFilterOptions(filterListEl);
		const isDynamic = form?.querySelector('input[name="ingestTargetMode"]:checked')?.value === 'dynamic';
		socketIndicesOf(sourceEl).forEach((idx) => {
			$PI.sendToPlugin({
				event: 'GetIngestFilterList',
				socketIdx: idx,
				sourceName: isDynamic ? undefined : sourceEl.value,
			});
		});
	};

	query();
	sourceEl.addEventListener('input', Utils.debounce(150, query));
	form?.querySelectorAll('input[name="ingestTargetMode"]').forEach((radio) => radio.addEventListener('change', query));
	onTargetSelectionChange(() => query());
});
