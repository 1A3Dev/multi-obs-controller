export const fields = `
<div type="radio" class="sdpi-item" title="${$PI.localize('How to pick the target ingest: a fixed one, or by its position in a sorted list (pinned ingests first from General Configuration, then alphabetical) that follows along as ingests come and go')}">
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
<div class="sdpi-item ingest-dynamic-field" title="${$PI.localize('1-based position of the ingest in the sorted list (pinned ingests first, then alphabetical)')}">
	<div class="sdpi-item-label" data-i18n>Ingest Position</div>
	<div class="sdpi-item-value" style="display: flex; gap: 8px; align-items: center;">
		<input type="number" name="ingestIndex" min="1" step="1" placeholder="1" style="flex: 1 0 0; min-width: 0;">
		<span class="online-only-field" style="display: flex; align-items: center;">
			<input type="checkbox" id="ingestOnlineOnly" name="ingestOnlineOnly" value="true">
			<label for="ingestOnlineOnly" style="white-space: nowrap; margin: 0; display: flex; align-items: center;" title="${$PI.localize('Skip offline ingests, so this position always lands on a currently live one')}"><span></span>${$PI.localize('Online Only')}</label>
		</span>
	</div>
</div>
<div type="textarea" class="sdpi-item" title="${$PI.localize('Key title. Supports variables: {name} for the ingest\'s display name, {bitrate} for its live bitrate (only while online). Leave a line as just a variable to have it disappear when that variable is empty.')}">
	<div class="sdpi-item-label" data-i18n>Title</div>
	<div class="sdpi-item-value textarea">
		<textarea type="textarea" name="titleTemplate" style="min-height: 4em;" placeholder="{name}&#10;{bitrate}"></textarea>
	</div>
</div>
`;
