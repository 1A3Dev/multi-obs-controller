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
		target?: string | string[],
		indivParams?: 'true',
		dynamicTarget?: 'true'
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
	id?: string,
	name?: string,
	ip?: string,
	port?: string,
	pwd?: string,
	secure?: 'true',
	irltk?: 'true',
	ingestPinned?: string | string[],
	ingestSceneMap?: { ingest?: string, scene?: string }[],
	lastKnownScenes?: string[],
}
export type IngestCategory = 'backpack' | 'phone' | 'desktop';
export type GlobalSettings = Partial<{
	servers: ServerConfig[],
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
	[key: `ingestProfileInstallPrompted__${string}`]: 'true',
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
	targets: number[];
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
	irltkCompat?: 'only' | 'exclude',
	allowDynamicTarget?: boolean
}

export type PartiallyRequired<T, K extends keyof T> = Omit<T, K> & Required<Pick<T, K>>;
export type Input = { inputName: string; inputKind: string; unversionedInputKind: string; };

// ---
