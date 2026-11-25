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
<div type="textarea" class="sdpi-item" title="${$PI.localize('Filter names to skip on the dial, one per line (not case-sensitive). Applies to whichever ingest the dial lands on')}">
	<div class="sdpi-item-label" data-i18n>Excluded Filters</div>
	<div class="sdpi-item-value textarea">
		<textarea type="textarea" name="excludedFilters" style="min-height: 4em;" placeholder="${$PI.localize('One filter name per line')}"></textarea>
	</div>
</div>
`;
