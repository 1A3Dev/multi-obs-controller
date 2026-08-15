export const fields = `
<div class="sdpi-item transitions">
	<div class="sdpi-item-label" data-i18n>Type</div>
	<input class="sdpi-item-value" type="text" name="transitionName" list="transitionList">
	<datalist id="transitionList"></datalist>
</div>
<div class="sdpi-item duration-field" title="${$PI.localize('Fade duration, in milliseconds')}">
	<div class="sdpi-item-label" data-i18n>Duration (ms)</div>
	<input class="sdpi-item-value" type="number" name="transitionDuration" min="50" max="20000" step="1" value="250">
</div>
`;
