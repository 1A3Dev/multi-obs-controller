export const fields = `
<div class="sdpi-item sources">
	<div class="sdpi-item-label" data-i18n>Source</div>
	<input class="sdpi-item-value" type="text" name="sourceName" list="sourceList" required>
	<datalist id="sourceList"></datalist>
</div>
<div class="sdpi-item filters">
	<div class="sdpi-item-label" data-i18n>Filter</div>
	<input class="sdpi-item-value" type="text" name="filterName" list="filterList" required>
	<datalist id="filterList"></datalist>
</div>
<div class="sdpi-item settings">
	<div class="sdpi-item-label" data-i18n>Setting</div>
	<input class="sdpi-item-value" type="text" name="settingName" list="settingList" required>
	<datalist id="settingList"></datalist>
</div>
<div class="sdpi-item">
	<div class="sdpi-item-label" data-i18n>Step</div>
	<input class="sdpi-item-value" type="number" name="step" step="any" placeholder="1">
</div>
<div class="sdpi-item">
	<div class="sdpi-item-label" data-i18n>Min</div>
	<input class="sdpi-item-value" type="number" name="min" step="any">
</div>
<div class="sdpi-item">
	<div class="sdpi-item-label" data-i18n>Max</div>
	<input class="sdpi-item-value" type="number" name="max" step="any">
</div>
`;
