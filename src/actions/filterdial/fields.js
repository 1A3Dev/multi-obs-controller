export const fields = `
<div class="sdpi-item sources" title="${$PI.localize('Scene or source whose filters the dial browses')}">
	<div class="sdpi-item-label" data-i18n>Source</div>
	<input class="sdpi-item-value" type="text" name="sourceName" list="sourceList" required>
	<datalist id="sourceList"></datalist>
</div>
`;
