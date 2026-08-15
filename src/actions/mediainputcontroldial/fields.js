export const fields = `
<div class="sdpi-item">
	<div class="sdpi-item-label" data-i18n>Source</div>
	<input class="sdpi-item-value" type="text" name="inputName" list="inputList" required>
	<datalist id="inputList"></datalist>
</div>
<div class="sdpi-item">
	<div class="sdpi-item-label" data-i18n>Push/Tap Action</div>
	<select class="sdpi-item-value select" name="action">
		<option value="play_stop" selected>${$PI.localize('Play/Stop')}</option>
		<option value="play_pause">${$PI.localize('Play/Pause')}</option>
		<option value="restart">${$PI.localize('Restart')}</option>
		<option value="stop">${$PI.localize('Stop')}</option>
	</select>
</div>
<div class="sdpi-item">
	<div class="sdpi-item-label" data-i18n>Seek Step (sec)</div>
	<input class="sdpi-item-value" type="number" name="step" min="0.1" step="0.1" placeholder="5">
</div>
`;
