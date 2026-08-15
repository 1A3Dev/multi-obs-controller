import { mergeListsByKey, socketIndicesOf } from '../../propertyInspector/utils.js';

$PI.onSendToPropertyInspector('dev.theca11.multiobs.mediainputcontrol', ({ payload }) => {
	const { event, inputsLists } = payload;

	if (event === 'InputListLoaded') {
		document.querySelectorAll('datalist').forEach((el) => {
			const inputs = mergeListsByKey(inputsLists, socketIndicesOf(el), 'inputName');
			const options = [...inputs].reverse().map((input) => {
				const option = document.createElement('option');
				option.value = input.inputName;
				option.textContent = input.inputName;
				return option;
			});
			el.replaceChildren(...options);
		});
	}
});

// Hide action selector if inside multiaction (not supported)
$PI.onDidReceiveSettings('dev.theca11.multiobs.mediainputcontrol', ({ payload: receiveSettingsPayload }) => {
	if (receiveSettingsPayload.isInMultiAction) {
		document.querySelector('.action-select').style.display = 'none';
	}
});
$PI.getSettings();
