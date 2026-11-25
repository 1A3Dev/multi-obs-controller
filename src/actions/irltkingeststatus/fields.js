export const fields = `
<div type="radio" class="sdpi-item" title="${$PI.localize('How to pick the target ingest: a fixed one, or by its position on the ingest page (opened via an Open Ingest Profile button)')}">
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
<div class="sdpi-item ingest-dynamic-field" title="${$PI.localize('1-based position on the ingest page (opened via an Open Ingest Profile button), sorted by category, then pinned ingests first within their category as set for this server, then alphabetical. Ingests keep their position until the page is refreshed or reopened')}">
	<div class="sdpi-item-label" data-i18n>Ingest Position</div>
	<input class="sdpi-item-value" type="number" name="ingestIndex" min="1" step="1" placeholder="1">
</div>
<div type="radio" class="sdpi-item" title="${$PI.localize('Draw a graph of the ingest\'s bitrate over the last minute on the key, coloured by its status')}">
	<div class="sdpi-item-label" data-i18n>Bitrate Graph</div>
	<div class="sdpi-item-value">
		<input id="bitrateGraphShow" type="radio" name="bitrateGraph" value="" checked>
		<label for="bitrateGraphShow" data-i18n><span></span>Show</label>
		<input id="bitrateGraphHide" type="radio" name="bitrateGraph" value="hide">
		<label for="bitrateGraphHide" data-i18n><span></span>Hide</label>
	</div>
</div>
<div class="sdpi-item" title="${$PI.localize('Name, ID or Peer ID of a TVU pack (as returned by your TVU account) to link to this ingest. Its battery level becomes available as the {battery} title variable, refreshed about once a minute. Leave blank for no link.')}">
	<div class="sdpi-item-label" data-i18n>TVU Pack</div>
	<input class="sdpi-item-value" type="text" name="tvuDevice" placeholder="${$PI.localize('None')}">
</div>
<div type="textarea" class="sdpi-item" title="${$PI.localize('Key title. Supports variables: {name} for the ingest\'s display name, {bitrate} for its live bitrate (only while online), {bitrateValue} and {bitrateUnit} for the bitrate number and its unit separately (e.g. to put them on different lines),{battery} for the linked TVU pack\'s battery level (only while linked and known). Leave a line as just a variable to have it disappear when that variable is empty.')}">
	<div class="sdpi-item-label" data-i18n>Title</div>
	<div class="sdpi-item-value textarea">
		<textarea type="textarea" name="titleTemplate" style="min-height: 4em;" placeholder="{name}&#10;{bitrate}&#10;{battery}"></textarea>
	</div>
</div>
`;
