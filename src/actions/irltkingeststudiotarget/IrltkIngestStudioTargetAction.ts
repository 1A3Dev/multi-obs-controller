import { AbstractStatelessAction } from '../BaseWsAction';
import { StateEnum } from '../StateEnum';
import { getIngestContextOverride, onIngestStudioTargetOverrideChanged, setIngestStudioTargetOverride } from '../irltkIngests';

type ActionSettings = Record<string, never>

/**
 * Overrides the Studio Mode scene target of every Ingest Scene action while the ingest profile is open.
 * Press toggles Program/Preview, long press goes back to each Ingest Scene action's own setting
 */
export class IrltkIngestStudioTargetAction extends AbstractStatelessAction<ActionSettings> {
	constructor() {
		super('uk.1a3.multiobs.irltkingeststudiotarget', {
			hideTargetIndicators: true,
			statesColors: { active: '#b8332e', intermediate: '#3f8a3a' },
		});

		this.onSinglePress(() => {
			setIngestStudioTargetOverride(getIngestContextOverride().studioTarget === 'program' ? 'preview' : 'program');
		});
		this.onLongPress(() => {
			setIngestStudioTargetOverride(undefined);
		});

		onIngestStudioTargetOverrideChanged(() => {
			for (const [context, { targets }] of this.contexts) {
				targets.forEach(target => this.setContextSocketState(context, target - 1, this._getState()));
				this.updateKeyImage(context);
			}
		});
	}

	override async fetchState(): Promise<StateEnum.Active | StateEnum.Intermediate | StateEnum.Inactive> {
		return this._getState();
	}

	protected override async getForegroundImage(): Promise<string> {
		const { studioTarget } = getIngestContextOverride();
		const [label, sub] = studioTarget === 'program' ? ['PGM', 'Program'] : studioTarget === 'preview' ? ['PVW', 'Preview'] : ['AUTO', 'Per button'];
		return `
			<text x="72" y="76" text-anchor="middle" font-size="40" font-family="Arial, sans-serif" font-weight="bold" fill="#efefef">${label}</text>
			<text x="72" y="108" text-anchor="middle" font-size="18" font-family="Arial, sans-serif" fill="#efefef">${sub}</text>
		`;
	}

	private _getState(): StateEnum.Active | StateEnum.Intermediate | StateEnum.Inactive {
		const { studioTarget } = getIngestContextOverride();
		return studioTarget === 'program' ? StateEnum.Active : studioTarget === 'preview' ? StateEnum.Intermediate : StateEnum.Inactive;
	}
}
