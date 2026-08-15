import { mergeListsByKey, socketIndicesOf } from '../../propertyInspector/utils.js';

$PI.onSendToPropertyInspector('dev.theca11.multiobs.irltkingestvolume', ({ payload }) => {
	const { event, ingestsLists, pagingActive } = payload;

	if (event === 'IngestListLoaded') {
		document.querySelectorAll('datalist').forEach((el) => {
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
});

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
