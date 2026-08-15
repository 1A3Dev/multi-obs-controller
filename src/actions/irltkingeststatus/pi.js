$PI.onSendToPropertyInspector('dev.theca11.multiobs.irltkingeststatus', ({ payload }) => {
	const { event, ingestsLists, pagingActive } = payload;

	if (event === 'IngestListLoaded') {
		document.querySelectorAll('datalist').forEach((el) => {
			// A tab's true socket index (see inspector.js's tab setup); the shared tab (2+ targets, no
			// individual settings) isn't tied to one server, so socket 0 is used as a fixed reference,
			// matching the shared blob's old "All"-mode convention
			const { socketIdx } = el.closest('.tab-container').dataset;
			const idx = socketIdx !== undefined ? Number(socketIdx) : 0;
			const options = [...(ingestsLists[idx] ?? [])].map((ingest) => {
				const option = document.createElement('option');
				option.value = ingest.obs_source_name;
				option.textContent = `${ingest.obs_source_name} (${ingest.name})`;
				return option;
			});
			el.replaceChildren(...options);
		});

		// Online Only has no effect while paging is active (see isIngestPagingActive) - hide it there
		// instead of leaving a control that does nothing
		document.querySelectorAll('.online-only-field').forEach((el) => {
			el.style.display = pagingActive ? 'none' : '';
		});
	}
});

// Toggle static/dynamic ingest fields per OBS instance tab, based on that tab's target mode
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
