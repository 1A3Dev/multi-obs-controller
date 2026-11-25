import { onIngestPageRefreshed } from '../irltkIngests';
import { IrltkIngestFilterDialAction } from '../irltkingestfilterdial/IrltkIngestFilterDialAction';
import { IrltkIngestVolumeAction } from '../irltkingestvolume/IrltkIngestVolumeAction';

/**
 * IRLToolkit Ingest Dial: one dial with a volume mode and a filters mode, switched by holding the dial down.
 * It replaces a Stream Deck dial stack of Ingest Volume + Ingest Filter Dial, whose position Stream Deck remembers
 * and plugins can't reset - this one starts in volume mode every time it appears (e.g. each time the profile opens).
 *
 * Both modes are the existing dial implementations registered under the same UUID: each receives every event of
 * the action, and only the one matching the context's current mode handles input and draws the dial
 */
const DIAL_UUID = 'dev.theca11.multiobs.irltkingestdial';

type DialMode = 'volume' | 'filters';
const DIAL_MODES: DialMode[] = ['volume', 'filters'];

const modes = new Map<string, DialMode>();	// <context, mode>, volume when unset
const modeListeners = new Set<(context: string) => void>();

function getMode(context: string): DialMode {
	return modes.get(context) ?? DIAL_MODES[0];
}

function setMode(context: string, mode: DialMode): void {
	if (getMode(context) === mode) return;
	modes.set(context, mode);
	modeListeners.forEach(fn => fn(context));
}

function switchMode(context: string): void {
	setMode(context, DIAL_MODES[(DIAL_MODES.indexOf(getMode(context)) + 1) % DIAL_MODES.length]);
}

export class IrltkIngestDialVolumeMode extends IrltkIngestVolumeAction {
	constructor() {
		super(DIAL_UUID);
		modeListeners.add((context) => {
			if (!this.contexts.has(context) || !this.isModeActive(context)) return;
			this.showDial(context);
			this.updateKeyImage(context);
		});

		// Refreshing the ingest page also sends its dials back to the first mode
		onIngestPageRefreshed((socketIdx) => {
			for (const [context, { settings }] of this.contexts) {
				if (settings[socketIdx]) setMode(context, DIAL_MODES[0]);
			}
		});
	}

	protected override isModeActive(context: string): boolean {
		return getMode(context) === 'volume';
	}

	protected override onDialHold(context: string): void {
		switchMode(context);
	}

	protected override async updateKeyImage(context: string): Promise<void> {
		if (this.isModeActive(context)) await super.updateKeyImage(context);
	}

	override async onContextDisappear(context: string): Promise<void> {
		await super.onContextDisappear(context);
		modes.delete(context);
	}
}

export class IrltkIngestDialFiltersMode extends IrltkIngestFilterDialAction {
	constructor() {
		super(DIAL_UUID);
		modeListeners.add((context) => {
			if (!this.contexts.has(context) || !this.isModeActive(context)) return;
			this.showDial(context);
			this.updateKeyImage(context);
		});
	}

	protected override isModeActive(context: string): boolean {
		return getMode(context) === 'filters';
	}

	protected override onDialHold(context: string): void {
		switchMode(context);
	}

	protected override async updateKeyImage(context: string): Promise<void> {
		if (this.isModeActive(context)) await super.updateKeyImage(context);
	}

	override async onContextDisappear(context: string): Promise<void> {
		await super.onContextDisappear(context);
		modes.delete(context);
	}

	// The volume mode already sends the ingest list to the property inspector
	override async onPropertyInspectorReady(): Promise<void> { /* empty */ }
}
