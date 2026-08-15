import { FormUtils, localizeUI } from '../../propertyInspector/utils.js';

function escapeHtml(str) {
	return str.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[c]));
}

$PI.onSendToPropertyInspector('dev.theca11.multiobs.scenepreviewdial', ({ payload }) => {
	const { event, scenesLists } = payload;
	if (event !== 'SceneListLoaded') return;

	document.querySelectorAll('.scene-config-list').forEach((container) => {
		const tabContainer = container.closest('.tab-container');
		// Per-server tabs carry their true socket index (see inspector.js's tab setup); the shared tab
		// (2+ targets, no individual settings) isn't tied to one server, so socket 0 is used as a fixed
		// reference for its scene list, matching the shared blob's old "All"-mode convention
		const socketIdx = tabContainer.dataset.socketIdx !== undefined ? Number(tabContainer.dataset.socketIdx) : 0;
		const rows = [...(scenesLists[socketIdx] ?? [])].reverse().map((scene, rowIdx) => {
			const name = escapeHtml(scene.sceneName);
			// sdpi.css hides native checkboxes and renders the check box as the <span> inside the
			// label that immediately follows the checkbox (input[type=checkbox]+label span) - the
			// input and label must be siblings, not nested, or the checked state never shows visually
			const excludeId = `sceneExclude-${tabContainer.id}-${rowIdx}`;
			return `
				<div class="sdpi-item">
					<div class="sdpi-item-label" title="${name}">${name}</div>
					<div class="sdpi-item-value" style="display: flex; gap: 8px; align-items: center;">
						<input type="checkbox" id="${excludeId}" name="exclude__${name}" value="true">
						<label for="${excludeId}" style="white-space: nowrap; margin: 0; display: flex; align-items: center;"><span></span>${$PI.localize('Exclude')}</label>
					</div>
				</div>
			`;
		});
		container.innerHTML = rows.join('');
	});

	// The newly created alias/exclude inputs didn't exist yet when the form was first populated from
	// saved settings - fetch settings again now and fill them in
	$PI.getSettings();
});

$PI.onDidReceiveSettings('dev.theca11.multiobs.scenepreviewdial', ({ payload }) => {
	const { settings } = payload;
	document.querySelectorAll('.tab-container form').forEach((form) => {
		const { id, index } = form.closest('.tab-container').dataset;
		// Per-server tab: prefer the reorder-safe id-keyed params blob (see inspector.js's tab setup),
		// falling back to the legacy position-keyed one for a button saved before servers had stable ids.
		// Shared tab (no id): the fixed params_shared slot, falling back to params1 the same way
		const params = id
			? (settings[`params_${id}`] ?? settings[`params${index}`] ?? {})
			: (settings.params_shared ?? settings.params1 ?? {});
		FormUtils.setFormValue(params, form);
	});
	localizeUI();
});
