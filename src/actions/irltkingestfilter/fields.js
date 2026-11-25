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
<div class="sdpi-item filters" title="${$PI.localize('Filter on the ingest player OBS source to toggle. With Dynamic Position, the suggestions list the filters of every ingest')}">
	<div class="sdpi-item-label" data-i18n>Filter</div>
	<input class="sdpi-item-value" type="text" name="filterName" list="filterList" required>
	<datalist id="filterList"></datalist>
</div>
`;
