export const fields = `
<div class="sdpi-item" title="${$PI.localize('Studio Mode Target tooltip')}">
	<div class="sdpi-item-label" data-i18n>${$PI.localize('Studio Mode Scene Target')}</div>
	<select class="sdpi-item-value select" name="studioTarget">
		<option value="preview" selected>${$PI.localize('Preview')}</option>
		<option value="program">${$PI.localize('Program')}</option>
	</select>
</div>
<div class="sdpi-item" title="${$PI.localize('Scene exclude tooltip')}">
	<div class="sdpi-item-label" data-i18n>${$PI.localize('Scenes')}</div>
	<div class="sdpi-item-value" style="font-size: 11px; opacity: 0.7; align-items: center;" data-i18n>${$PI.localize('Exclude scenes from the dial. Display aliases are set in the General Configuration')}</div>
</div>
<div class="scene-config-list"></div>
`;
