// Shared between the plugin (bundled by webpack) and the property inspector (loaded as plain ES modules)

export const MAX_SERVERS = 10;

// Action ids (last segment of the action UUID) that only target, or never target, IRLToolkit servers
export const IRLTK_ONLY_ACTIONS = ['irltkingeststatus', 'irltkingestvolume', 'irltkingestscene', 'irltkingestfilter', 'irltkingestfilterdial', 'irltkingestpageprev', 'irltkingestpagenext', 'irltkingestpagenumber', 'irltkingeststudiotarget'];
export const IRLTK_EXCLUDED_ACTIONS = ['createrecordchapter', 'refreshcapturedevice', 'savereplaybuffer', 'screenshot', 'setprofile', 'togglerecord', 'togglereplaybuffer', 'togglestream', 'togglevirtualcam'];

// Action ids that can target the server of the last opened ingest profile instead of fixed servers
export const DYNAMIC_TARGET_ACTIONS = ['triggerstudiomodetransition', 'streamstatus'];

// Separator/header scenes, always left out of the Scene Preview dial - matched against the trimmed scene name
export const DIAL_SEPARATOR_SCENE_NAMES = ['-=-'];
export const DIAL_SEPARATOR_SCENE_PREFIXES = ['─── ✦'];

/**
 * @param {string} sceneName
 * @returns {boolean}
 */
export function isDialSeparatorScene(sceneName) {
	const trimmed = sceneName.trim();
	return DIAL_SEPARATOR_SCENE_NAMES.includes(trimmed) || DIAL_SEPARATOR_SCENE_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
}

// Ingest categories, in display/sort order
export const INGEST_CATEGORIES = /** @type {const} */ (['backpack', 'phone', 'desktop']);

// OBS IRLToolkit device types that support opening an ingest profile
/** @type {Record<number, string>} */
export const INGEST_PROFILE_NAMES = {
	0: 'IRLToolkit Ingests',
	7: 'IRLToolkit Ingests (+)',
	13: 'IRLToolkit Ingests (+XL)',
};
