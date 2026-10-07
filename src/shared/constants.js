// Shared between the plugin (bundled by webpack) and the property inspector (loaded as plain ES modules)

export const MAX_SERVERS = 10;

// Action ids (last segment of the action UUID) that only target, or never target, IRLToolkit servers
export const IRLTK_ONLY_ACTIONS = ['irltkingeststatus', 'irltkingestvolume', 'irltkingestscene', 'irltkingestpageprev', 'irltkingestpagenext', 'irltkingestpagenumber'];
export const IRLTK_EXCLUDED_ACTIONS = ['createrecordchapter', 'refreshcapturedevice', 'savereplaybuffer', 'screenshot', 'setprofile', 'togglerecord', 'togglereplaybuffer', 'togglestream', 'togglevirtualcam'];

// Action ids that can target the server of the last opened ingest profile instead of fixed servers
export const DYNAMIC_TARGET_ACTIONS = ['triggerstudiomodetransition', 'streamstatus'];

// Ingest categories, in display/sort order
export const INGEST_CATEGORIES = /** @type {const} */ (['backpack', 'phone', 'desktop']);

// OBS IRLToolkit device types that support opening an ingest profile
/** @type {Record<number, string>} */
export const INGEST_PROFILE_NAMES = {
	0: 'IRLToolkit Ingests',
	7: 'IRLToolkit Ingests (+)',
	13: 'IRLToolkit Ingests (+XL)',
};
