import { sockets } from '../plugin/sockets';

// Last known scene list per socket, regardless of current connection state - unlike the live
// GetSceneList call in getScenesLists() below, this is never cleared on disconnect, so the general
// configuration window's scene alias editor can still show (and let the user edit aliases for) scenes
// that existed the last time the socket was connected, rather than going blank while it's offline
const lastKnownScenes: { sceneName: string }[][] = new Array(sockets.length).fill(null).map(() => []);

sockets.forEach((socket, socketIdx) => {
	socket.on('SceneListChanged', ({ scenes }) => {
		lastKnownScenes[socketIdx] = scenes as { sceneName: string }[];
	});
	socket.on('Identified', async () => {
		const { scenes } = await socket.call('GetSceneList').catch(() => ({ scenes: undefined }));
		if (scenes) lastKnownScenes[socketIdx] = scenes as { sceneName: string }[];
	});
});

/**
 * Last known scene list for a socket, regardless of current connection state - see lastKnownScenes
 */
export function getLastKnownScenes(socketIdx: number): { sceneName: string }[] {
	return lastKnownScenes[socketIdx];
}

/**
 * Get a list of all collections in all OBS instances
 * @returns One array of collection names per OBS instance
 */
export async function getCollectionsLists() {
	const results = await Promise.allSettled(
		sockets.map(socket => socket.isConnected ? socket.call('GetSceneCollectionList') : Promise.reject()),
	);
	return results.map(result => result.status === 'fulfilled' ? result.value.sceneCollections : []);
}

/**
 * Get a list of all profiles in all OBS instances
 * @returns One array of profile names per OBS instance
 */
export async function getProfilesLists() {
	const results = await Promise.allSettled(
		sockets.map(socket => socket.isConnected ? socket.call('GetProfileList') : Promise.reject()),
	);
	return results.map(result => result.status === 'fulfilled' ? result.value.profiles : []);
}

/**
 * Get a list of all scenes in all OBS instances
 * @returns One array of scenes per OBS instance. Each scene JsonObject contains sceneIndex and sceneName
 */
export async function getScenesLists() {
	const results = await Promise.allSettled(
		sockets.map(socket => socket.isConnected ? socket.call('GetSceneList') : Promise.reject()),
	);
	return results.map(result => result.status === 'fulfilled' ? result.value.scenes : []);
}

/**
 * Get a list of all scene items in a particular scene
 * @param socketIdx Index identifying the OBS instance
 * @param sceneName Scene to list all scene items
 * @returns One array of scene items. Each scene item JsonObject contains sceneItemId and sourceName (among others)
 */
export async function getSceneItemsList(socketIdx: number, sceneName: string) {
	try {
		const data = await sockets[socketIdx].call('GetSceneItemList', { sceneName: sceneName });
		return data.sceneItems;
	}
	catch {
		return [];
	}
}

/**
 * Get a list of all groups in all OBS instances
 * @returns One array of group names per OBS instance.
 */
export async function getGroupsLists() {
	const results = await Promise.allSettled(
		sockets.map(socket => socket.isConnected ? socket.call('GetGroupList') : Promise.reject()),
	);
	return results.map(result => result.status === 'fulfilled' ? result.value.groups.map(name => ({ sceneName: name })) : []);
}

/**
 * Get a list of all scene items in a particular group
 * @param socketIdx Index identifying the OBS instance
 * @param groupName Group to list all scene items
 * @returns One array of scene items. Each scene item JsonObject contains sceneItemId and sourceName (among others)
 */
export async function getGroupSceneItemsList(socketIdx: number, groupName: string) {
	try {
		const data = await sockets[socketIdx].call('GetGroupSceneItemList', { sceneName: groupName });
		return data.sceneItems;
	}
	catch {
		return [];
	}
}

/**
 * Get a list of all scene transitions in all OBS instances
 * @returns One array of transitions per OBS instance. Each transition JsonObject contains
 * transitionName, transitionKind and transitionFixed (among others)
 */
export async function getTransitionsLists() {
	const results = await Promise.allSettled(
		sockets.map(socket => socket.isConnected ? socket.call('GetSceneTransitionList') : Promise.reject()),
	);
	return results.map(result => result.status === 'fulfilled' ? result.value.transitions : []);
}

/**
 * Get a list of all inputs in all OBS instances
 * @returns One array of inputs per OBS instance.
 * Each input JsonObject contains inputName, inputKind and unversionedInputKind
 */
export async function getInputsLists() {
	const results = await Promise.allSettled(
		sockets.map(socket => socket.isConnected ? socket.call('GetInputList') : Promise.reject()),
	);
	return results.map(result => result.status === 'fulfilled' ? result.value.inputs : []);
}

/**
 * Get a list of all filter items in a particular source
 * @param socketIdx Index identifying the OBS instance
 * @param sourceName Source to list all filter items
 * @returns One array of filter items. Each scene item JsonObject contains filterName (among others)
 */
export async function getSourceFilterList(socketIdx: number, sourceName: string) {
	try {
		const data = await sockets[socketIdx].call('GetSourceFilterList', { sourceName });
		return data.filters;
	}
	catch {
		return [];
	}
}