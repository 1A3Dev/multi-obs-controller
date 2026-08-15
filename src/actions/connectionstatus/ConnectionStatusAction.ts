import { AbstractStatelessAction } from '../BaseWsAction';
import { StateEnum } from '../StateEnum';
import { ContextData } from '../types';

const CONNECTED_IMG = `data:image/svg+xml;base64,${btoa('<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144"><rect fill="#5a9b4a" width="144" height="144" rx="22"/><path fill="#EFEFEF" d="M60.8 85.6L46.2 71L41.2 75.9L60.8 95.5L102.8 53.5L97.9 48.6Z"/></svg>')}`;
const DISCONNECTED_IMG = `data:image/svg+xml;base64,${btoa('<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144"><rect fill="#2b2b2b" width="144" height="144" rx="22"/><path fill="#c94b4b" d="M107 44.05L99.95 37L72 64.95L44.05 37L37 44.05L64.95 72L37 99.95L44.05 107L72 79.05L99.95 107L107 99.95L79.05 72Z"/></svg>')}`;

/**
 * Pure OBS connection status indicator: shows one icon when the targeted OBS instance(s) are
 * connected, another when disconnected. No settings, no press behavior of its own - a Stream Deck
 * plugin can't switch to an arbitrary user profile (switchToProfile only reaches profiles the plugin
 * itself declares) and a Multi Action key doesn't forward live icon updates from a step inside it, so
 * this stays a standalone key. Pair it with Stream Deck's own built-in "Switch Profile" action on an
 * adjacent key for actual profile switching. The image is fully custom (not the shared state-color
 * renderer), so both icons stay clean instead of getting the generic "unavailable" hatch overlay
 */
export class ConnectionStatusAction extends AbstractStatelessAction<Record<string, never>> {

	constructor() {
		super('dev.theca11.multiobs.connectionstatus');
	}

	override async fetchState(): Promise<StateEnum.Active> {
		return StateEnum.Active;
	}

	protected override async updateKeyImage(context: string): Promise<void> {
		const contextData = this.contexts.get(context);
		if (!contextData) return;
		const { settings, states } = contextData;
		const targetedStates = states.filter((_, i) => settings[i] !== null);
		const connected = targetedStates.some(state => state === StateEnum.Active);
		$SD.setImage(context, connected ? CONNECTED_IMG : DISCONNECTED_IMG);
	}

	// The base class's default state calculation requires every targeted server to be active (fitting
	// for most actions, where a mixed result shouldn't read as "on") - this action instead wants
	// "connected" the moment any target is reachable, matching updateKeyImage's own `.some()` above.
	// Stream Deck ties whichever image was last set via setImage to the state slot active at the time,
	// so leaving this on the base class's `.every()` would flip the manifest's key_off/"Disconnected"
	// state (and its default image) back in right after updateKeyImage sets the "connected" one
	protected override _updateSDState(context: string, contextData: ContextData<unknown>): void {
		const { targets, states } = contextData;
		const connected = states.filter((_, i) => targets.includes(i + 1)).some(state => state === StateEnum.Active);
		$SD.setState(context, connected ? 0 : 1);
	}
}
