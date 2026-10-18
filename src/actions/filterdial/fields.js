export const fields = `
<div class="sdpi-item sources" title="${$PI.localize('Scene or source whose filters the dial browses')}">
	<div class="sdpi-item-label" data-i18n>Source</div>
	<input class="sdpi-item-value" type="text" name="sourceName" list="sourceList" required>
	<datalist id="sourceList"></datalist>
</div>
<div type="textarea" class="sdpi-item" title="${$PI.localize('Filter names to skip on the dial, one per line (not case-sensitive)')}">
	<div class="sdpi-item-label" data-i18n>Excluded Filters</div>
	<div class="sdpi-item-value textarea">
		<textarea type="textarea" name="excludedFilters" style="min-height: 4em;" placeholder="${$PI.localize('One filter name per line')}"></textarea>
	</div>
</div>
`;
