export const fields = `
<div type="radio" class="sdpi-item" title="${$PI.localize('How to pick the target ingest: a fixed one, or by its position in a sorted list (by category, then pinned ingests first within their category as set for this server in General Configuration, then alphabetical) that follows along as ingests come and go')}">
	<div class="sdpi-item-label" data-i18n>Target Mode</div>
	<div class="sdpi-item-value">
		<input id="ingestModeStatic" type="radio" name="ingestTargetMode" value="" checked>
		<label for="ingestModeStatic" data-i18n><span></span>Specific Ingest</label>
		<input id="ingestModeDynamic" type="radio" name="ingestTargetMode" value="dynamic">
		<label for="ingestModeDynamic" data-i18n><span></span>Dynamic Position</label>
	</div>
</div>
<div class="sdpi-item ingest-static-field" title="${$PI.localize('Must match the ingest player OBS source name exactly')}">
	<div class="sdpi-item-label" data-i18n>Ingest Source</div>
	<input class="sdpi-item-value" type="text" name="ingestSourceName" list="ingestList">
	<datalist id="ingestList"></datalist>
</div>
<div class="sdpi-item ingest-dynamic-field" title="${$PI.localize('1-based position of the ingest in the sorted list (by category, then pinned ingests first within their category as set for this server, then alphabetical)')}">
	<div class="sdpi-item-label" data-i18n>Ingest Position</div>
	<div class="sdpi-item-value" style="display: flex; gap: 8px; align-items: center;">
		<input type="number" name="ingestIndex" min="1" step="1" placeholder="1" style="flex: 1 0 0; min-width: 0;">
		<span class="online-only-field" style="display: flex; align-items: center;">
			<input type="checkbox" id="ingestOnlineOnly" name="ingestOnlineOnly" value="true">
			<label for="ingestOnlineOnly" style="white-space: nowrap; margin: 0; display: flex; align-items: center;" title="${$PI.localize('Skip offline ingests, so this position always lands on a currently live one')}"><span></span>${$PI.localize('Online Only')}</label>
		</span>
	</div>
</div>
<div class="sdpi-item" title="${$PI.localize('Studio Mode Target tooltip')}">
	<div class="sdpi-item-label" data-i18n>${$PI.localize('Studio Mode Scene Target')}</div>
	<select class="sdpi-item-value select" name="studioTarget">
		<option value="preview" selected>${$PI.localize('Preview')}</option>
		<option value="program">${$PI.localize('Program')}</option>
	</select>
</div>
<div class="sdpi-item" title="${$PI.localize('The scene to switch to is looked up from the OBS source name of the resolved ingest, using the Ingest to Scene Mapping configured for this server in General Configuration')}">
	<div class="sdpi-item-label empty"></div>
	<div class="sdpi-item-value" style="opacity: 0.75; font-size: 9pt; white-space: normal;" data-i18n>The target scene is looked up from the Ingest → Scene Mapping set for this server in General Configuration.</div>
</div>
`;
