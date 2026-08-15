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
<div class="sdpi-item">
	<div class="sdpi-item-label" data-i18n>Property</div>
	<select class="sdpi-item-value select" name="property">
		<option value="positionX" selected data-i18n>Position X</option>
		<option value="positionY" data-i18n>Position Y</option>
		<option value="rotation" data-i18n>Rotation</option>
		<option value="scaleX" data-i18n>Scale X</option>
		<option value="scaleY" data-i18n>Scale Y</option>
		<option value="cropLeft" data-i18n>Crop Left</option>
		<option value="cropTop" data-i18n>Crop Top</option>
		<option value="cropRight" data-i18n>Crop Right</option>
		<option value="cropBottom" data-i18n>Crop Bottom</option>
	</select>
</div>
<div class="sdpi-item">
	<div class="sdpi-item-label" data-i18n>Step</div>
	<input class="sdpi-item-value" type="number" name="step" step="0.01" placeholder="5">
</div>
`;
