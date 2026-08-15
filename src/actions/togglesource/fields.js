export const fields = `
<div class="sdpi-item scenes">
	<div class="sdpi-item-label" data-i18n>Scene or Group</div>
	<input class="sdpi-item-value" type="text" name="sceneName" list="sceneList" required>
	<datalist id="sceneList"></datalist>
</div>
<div class="sdpi-item sources">
	<div class="sdpi-item-label" data-i18n>Source</div>
	<input class="sdpi-item-value" type="text" name="sourceName" list="sourceList" required>
	<datalist id="sourceList"></datalist>
</div>
<div class="sdpi-item multiaction-toggle-field" style="display: none;" title="${$PI.localize('Ignore the Show/Hide state selected for this step and toggle the source\'s current visibility instead')}">
	<div class="sdpi-item-label" data-i18n>Multi Action</div>
	<div class="sdpi-item-value">
		<input id="togglesourceForceToggle" type="checkbox" name="forceToggle" value="true">
		<label for="togglesourceForceToggle" data-i18n><span></span>Ignore state, toggle instead</label>
	</div>
</div>
`;
