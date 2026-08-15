export const fields = `
<div class="sdpi-item">
	<div class="sdpi-item-label" data-i18n>Input</div>
	<input class="sdpi-item-value" type="text" name="inputName" list="inputList" required>
	<datalist id="inputList"></datalist>
</div>
<div class="sdpi-item">
	<div class="sdpi-item-label" data-i18n>Step (dB)</div>
	<input class="sdpi-item-value" type="number" name="stepDb" min="0.1" max="26" step="0.1" placeholder="1">
</div>
<div class="sdpi-item" title="${$PI.localize('Highest dB the dial can be turned up to')}">
	<div class="sdpi-item-label" data-i18n>Max (dB)</div>
	<input class="sdpi-item-value" type="number" name="maxDb" min="0" max="26" step="0.1" placeholder="0">
</div>
`;
