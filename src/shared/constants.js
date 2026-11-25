// Shared between the plugin (bundled by webpack) and the property inspector (loaded as plain ES modules)

export const MAX_SERVERS = 15;

// Action ids (last segment of the action UUID) that only target, or never target, IRLToolkit servers
export const IRLTK_ONLY_ACTIONS = ['irltkingeststatus', 'irltkingestvolume', 'irltkingestscene', 'irltkingestfilter', 'irltkingestfilterdial', 'irltkingestdial', 'irltkingestpageprev', 'irltkingestpagenext', 'irltkingestpagenumber', 'irltkingestpagerefresh', 'irltkingeststudiotarget'];
export const IRLTK_EXCLUDED_ACTIONS = ['createrecordchapter', 'refreshcapturedevice', 'savereplaybuffer', 'screenshot', 'setprofile', 'togglerecord', 'togglereplaybuffer', 'togglestream', 'togglevirtualcam'];

// Action ids that never target Streamlabs Desktop servers, as its API has no equivalent (IRLTK-only actions are excluded too, since Streamlabs servers can't be IRLTK)
export const STREAMLABS_EXCLUDED_ACTIONS = ['createrecordchapter', 'filterdial', 'filtersettingdial', 'mediainputcontrol', 'mediainputcontroldial', 'pauserecord', 'rawbatchrequest', 'rawrequest', 'refreshcapturedevice', 'sceneitemtransformdial', 'screenshot', 'setprofile', 'togglefilter', 'togglevirtualcam', 'triggerhotkey', 'triggerstudiomodetransition'];

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

/*
 * Scene Preview dial order: scenes follow the OBS order, except ones moved manually, which are each saved as
 * `moveAfter__<scene>` = the scene they sit right after (or DIAL_ORDER_TOP for the top of the list), so the rest keep following OBS
 */
export const DIAL_MOVE_PREFIX = 'moveAfter__';
// Not '' as empty form values aren't saved
export const DIAL_ORDER_TOP = '⤒';

/**
 * @param {unknown} value
 * @returns {string[]}
 */
function toStringArray(value) {
	return Array.isArray(value) ? value : typeof value === 'string' && value ? [value] : [];
}

/**
 * The longest run of scenes (not necessarily adjacent) in the same relative order in both lists
 * @param {string[]} a
 * @param {string[]} b
 * @returns {Set<string>}
 */
function commonSubsequence(a, b) {
	const lengths = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
	for (let i = a.length - 1; i >= 0; i--) {
		for (let j = b.length - 1; j >= 0; j--) {
			lengths[i][j] = a[i] === b[j] ? lengths[i + 1][j + 1] + 1 : Math.max(lengths[i + 1][j], lengths[i][j + 1]);
		}
	}
	const common = new Set();
	for (let i = 0, j = 0; i < a.length && j < b.length;) {
		if (a[i] === b[j]) {
			common.add(a[i]);
			i++;
			j++;
		}
		else if (lengths[i + 1][j] >= lengths[i][j + 1]) {
			i++;
		}
		else {
			j++;
		}
	}
	return common;
}

/**
 * Saved moves (scene -> scene it sits after). Settings from before moves were saved individually hold the whole order
 * in `sceneOrder` - that's converted into the fewest moves giving the same order on the given scenes
 * @param {Record<string, unknown> | null | undefined} params
 * @param {string[]} sceneNames Scenes in OBS order
 * @returns {Map<string, string>}
 */
export function getDialSceneMoves(params, sceneNames) {
	const moves = new Map();
	for (const [key, value] of Object.entries(params ?? {})) {
		if (key.startsWith(DIAL_MOVE_PREFIX) && typeof value === 'string' && value) moves.set(key.slice(DIAL_MOVE_PREFIX.length), value);
	}
	const legacyOrder = toStringArray(params?.sceneOrder).filter((sceneName) => sceneNames.includes(sceneName));
	if (moves.size || !legacyOrder.length) return moves;

	const order = [...legacyOrder, ...sceneNames.filter((sceneName) => !legacyOrder.includes(sceneName))];
	const unmoved = commonSubsequence(sceneNames, order);
	order.forEach((sceneName, idx) => {
		if (!unmoved.has(sceneName)) moves.set(sceneName, idx ? order[idx - 1] : DIAL_ORDER_TOP);
	});
	return moves;
}

/**
 * Scenes in OBS order with the moved ones placed after their saved anchor - a move whose anchor is gone falls back to the OBS position
 * @param {string[]} sceneNames Scenes in OBS order
 * @param {Map<string, string>} moves
 * @returns {string[]}
 */
export function orderDialScenes(sceneNames, moves) {
	const validMoves = new Map([...moves].filter(([sceneName, anchor]) => sceneName !== anchor && sceneNames.includes(sceneName) && (anchor === DIAL_ORDER_TOP || sceneNames.includes(anchor))));
	const ordered = sceneNames.filter((sceneName) => !validMoves.has(sceneName));
	// Moved scenes can be anchored to other moved scenes, so keep placing the ones whose anchor is already placed
	let pending = sceneNames.filter((sceneName) => validMoves.has(sceneName));
	while (pending.length) {
		const pendingCount = pending.length;
		pending = pending.filter((sceneName) => {
			const anchor = validMoves.get(sceneName);
			const anchorIdx = anchor === DIAL_ORDER_TOP ? -1 : ordered.indexOf(anchor);
			if (anchor !== DIAL_ORDER_TOP && anchorIdx === -1) return true;
			ordered.splice(anchorIdx + 1, 0, sceneName);
			return false;
		});
		// Anchored in a loop, which saving never produces
		if (pending.length === pendingCount) {
			ordered.push(...pending);
			break;
		}
	}
	return ordered;
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
