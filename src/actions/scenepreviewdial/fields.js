export const fields = `
<div class="sdpi-item" title="${$PI.localize('Studio Mode Target tooltip')}">
	<div class="sdpi-item-label" data-i18n>${$PI.localize('Studio Mode Scene Target')}</div>
	<select class="sdpi-item-value select" name="studioTarget">
		<option value="preview" selected>${$PI.localize('Preview')}</option>
		<option value="program">${$PI.localize('Program')}</option>
	</select>
</div>
<div class="sdpi-item" title="${$PI.localize('Use ingest alias tooltip')}">
	<div class="sdpi-item-label" data-i18n>${$PI.localize('Ingest Alias')}</div>
	<div class="sdpi-item-value">
		<input type="checkbox" id="useIngestAlias" name="useIngestAlias" value="true">
		<label for="useIngestAlias" style="white-space: nowrap; margin: 0; display: flex; align-items: center;"><span></span>${$PI.localize('Show mapped ingest alias')}</label>
	</div>
</div>
<div class="sdpi-item" title="${$PI.localize('Scene exclude tooltip')}">
	<div class="sdpi-item-label" data-i18n>${$PI.localize('Scenes')}</div>
	<div class="sdpi-item-value" style="font-size: 11px; opacity: 0.7; align-items: center;" data-i18n>${$PI.localize('Exclude or reorder scenes on the dial')}</div>
</div>
<div class="scene-config-list"></div>
<div class="sdpi-item">
	<div class="sdpi-item-label empty"></div>
	<div class="sdpi-item-value">
		<button class="reset-scene-order" style="margin: 0 0 0 auto" title="${$PI.localize('Reset scene order tooltip')}">${$PI.localize('Reset order')}</button>
	</div>
</div>
`;
