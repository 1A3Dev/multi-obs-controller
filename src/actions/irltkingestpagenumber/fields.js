export const fields = `
<div type="textarea" class="sdpi-item" title="${$PI.localize('Key title. Supports variables: {page} for the current page, {count} for the total number of pages.')}">
	<div class="sdpi-item-label" data-i18n>Title</div>
	<div class="sdpi-item-value textarea">
		<textarea type="textarea" name="titleTemplate" style="min-height: 2em;" placeholder="{page}/{count}"></textarea>
	</div>
</div>
`;
