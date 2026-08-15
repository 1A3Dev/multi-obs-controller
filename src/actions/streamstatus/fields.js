export const fields = `
<div type="textarea" class="sdpi-item" title="Key title. Supports the {time} variable (elapsed stream time, hh:mm:ss), only while online. Leave a line as just {time} to have it disappear when offline.">
	<div class="sdpi-item-label" data-i18n>Title</div>
	<div class="sdpi-item-value textarea">
		<textarea type="textarea" name="titleTemplate" style="min-height: 4em;" placeholder="&#10;&#10;&#10;{time}"></textarea>
	</div>
</div>
`;
