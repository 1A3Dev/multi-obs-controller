// --- StreamDeck lib types for events ---
type Common = {
	action: string,
	event: string,
	context: string,
	device: string,
}
type Payload<T> = {
	payload: {
		coordinates: { column: number, row: number },
		isInMultiAction: boolean,
		state?: number,
		settings: T
	}
}
type TriggerPayload<T> = Payload<T> & { payload: { userDesiredState?: number } }
type BaseEventData<T> = Common & Payload<T>
type TriggerEventData<T> = Common & TriggerPayload<T>

export type DidReceiveSettingsData<T> = BaseEventData<T>;
export type DidReceiveGlobalSettingsData<T> = {
	event: string,
	payload: { settings: T }
}
export type KeyDownData<T> = TriggerEventData<T>;
export type KeyUpData<T> = TriggerEventData<T>;
export type WillAppearData<T> = BaseEventData<T>;
export type WillDisappearData<T> = BaseEventData<T>;
export type DialRotateData<T> = Common & { payload: { settings: T, coordinates: { column: number, row: number }, ticks: number, pressed: boolean } };
export type DialDownData<T> = Common & { payload: { settings: T, coordinates: { column: number, row: number } } };
export type DialUpData<T> = Common & { payload: { settings: T, coordinates: { column: number, row: number } } };
export type TouchTapData<T> = Common & { payload: { settings: T, coordinates: { column: number, row: number }, tapPos: [number, number], hold: boolean } };
export type SendToPluginData<T> = {
	action: string,
	event: string,
	context: string,
	payload: T
}
export type SendToPIData<T> = {
	action: string,
	event: string,
	context: string,
	payload: T
}
// ---

// --- MultiOBS types ---
export type PersistentSettings<T> = Partial<{
	common: {
		/** Selected target server(s), by stable id. A checkbox group naturally serializes as a bare
		 * string when exactly one is checked, or an array when 2+ are - both are valid. Legacy shapes
		 * from before multi-select/per-server ids existed (a lone id, a plain 1-based position, '0'/
		 * empty for the old "All") are still accepted - see resolveTargetIndices */
		target?: string | string[],
		indivParams?: 'true'
	},
	advanced: {
		longPress?: 'true',
		longPressMs?: string,
		customImg?: string,
		customImgPos?: string,
		fgColor?: string,
		bgColorActive?: string,
		bgColorInactive?: string,
		bgColorIntermediate?: string
	}
	[key: `params${number}`]: Partial<T>
	[key: `params_${string}`]: Partial<T>
}>
export type ServerConfig = {
	/** Stable identifier, assigned once when the server is created and never recalculated from its
	 * position - lets a target/params blob stay pointed at the right server when the list is reordered.
	 * Optional only for legacy/in-flight shapes on the way through resolveServers()'s id backfill;
	 * always present on anything actually persisted or handed to consumers */
	id?: string,
	name?: string,
	ip?: string,
	port?: string,
	pwd?: string,
	secure?: 'true',
	irltk?: 'true',
}
export type IngestCategory = 'backpack' | 'phone' | 'desktop';
export type GlobalSettings = Partial<{
	servers: ServerConfig[],
	// Legacy flat per-index keys, from before a dynamic server list was supported. Only read for migration.
	[key: `ip${number}`]: string,
	[key: `port${number}`]: string,
	[key: `pwd${number}`]: string
	defaultTarget: string | string[],
	longPressMs: string,
	fgColor: string,
	bgColorActive: string,
	bgColorInactive: string,
	bgColorIntermediate: string
	feedback: 'hide',
	targetNumbers: 'bottom' | 'middle' | 'top' | 'hide',
	debug: 'enabled',
	ingestPinned: string | string[],
	ingestProfileInstallPrompted: 'true',
	[key: `ingestAlias__${string}`]: string,
	[key: `ingestCategory__${string}`]: IngestCategory,
	[key: `sceneAlias__${string}`]: string,
	tvuEmail: string,
	tvuPassword: string,
	tvuAppKey: string,
	tvuAppSecret: string,
}>

export type SocketSettings<T> = Partial<T> | Record<string, never>;
export interface ContextData<T> {
	/** 1-based socket positions of every currently-targeted, eligible server */
	targets: number[];
	/** 0-based index of the "representative" targeted socket - the first (lowest-position) target -
	 * for actions (dials, paging) that can only show/control one value at a time even with multiple
	 * targets selected. Actual control actions still act on every entry in `targets`/`settings` */
	displayIdx: number;
	isInMultiAction: boolean;
	settings: (SocketSettings<T> | null)[];
	states: StateEnum[];
	advancedSettings?: {
		customImg?: string,
		customImgPos?: string,
		fgColor?: string,
		bgColorActive?: string,
		bgColorInactive?: string,
		bgColorIntermediate?: string
	}
}

export type RequestPayload = SingleRequestPayload<T> | BatchRequestPayload | null;
export type SingleRequestPayload<T extends keyof OBSRequestTypes> = {
	requestType: T,
	requestData?: OBSRequestTypes[T]
}
export type BatchRequestPayload = {
	requests: RequestBatchRequest[],
	options?: RequestBatchOptions
}


export type ConstructorParams = {
	titleParam?: string,
	statusEvent?: keyof OBSEventTypes | (keyof OBSEventTypes)[],
	statesColors?: {
		active?: string,
		inactive?: string
	},
	hideTargetIndicators?: boolean,
	/**
	 * Restricts which OBS servers this action can target, based on each server's "IRLTK" flag
	 * (General Configuration): 'only' - only IRLTK-flagged servers; 'exclude' - never IRLTK-flagged
	 * servers (for actions IRLToolkit itself disables, e.g. record/stream/replay buffer/profile controls)
	 */
	irltkCompat?: 'only' | 'exclude'
}

export type PartiallyRequired<T, K extends keyof T> = Omit<T, K> & Required<Pick<T, K>>;
export type Input = { inputName: string; inputKind: string; unversionedInputKind: string; };

// ---
