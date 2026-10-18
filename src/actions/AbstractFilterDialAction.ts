import { sockets } from '../plugin/sockets';
import { AbstractStatelessAction } from './BaseWsAction';
import { globalSettings } from './globalSettings';
import { getSourceFilterList } from './lists';
import { ConstructorParams, ContextData, DialRotateData, DialUpData, SocketSettings, TouchTapData } from './types';

const ENABLED_COLOR = '#3ac97a';
const DISABLED_COLOR = '#e04848';

type FilterEntry = { filterName: string, filterEnabled: boolean };
type SourceFilters = { sourceName: string, filters: FilterEntry[] };

/** Base for dials that browse every filter of one source: rotate to pick a filter, push or tap the screen to toggle it */
export type FilterDialSettings = { excludedFilters?: string };

/** Filter names to hide from the dial, one per line, matched case-insensitively */
function parseExcludedFilters(excludedFilters: string | undefined): Set<string> {
	return new Set((excludedFilters ?? '').split('\n').map(name => name.trim().toLowerCase()).filter(Boolean));
}

export abstract class AbstractFilterDialAction<T extends Record<string, unknown> & FilterDialSettings> extends AbstractStatelessAction<T> {
	private _filterCache = new Map<string, (SourceFilters | undefined)[]>();	// <context, filters per socket>
	private _selectedFilter = new Map<string, string>();	// <context, filter name picked on the dial>

	constructor(UUID: string, params?: Partial<ConstructorParams>) {
		super(UUID, { hideTargetIndicators: true, ...params });

		this.onDialRotate((evtData: DialRotateData<unknown>) => {
			const { context, payload } = evtData;
			if (!this.contexts.has(context)) return;
			const { settings, displayIdx } = this.contexts.get(context)!;
			this._warnIfDisconnected(context, settings);
			const filters = this._filterCache.get(context)?.[displayIdx]?.filters ?? [];
			if (!filters.length) return;

			const currentIdx = Math.max(0, filters.findIndex(f => f.filterName === this._getSelectedFilter(context, displayIdx)?.filterName));
			const newIdx = ((currentIdx + payload.ticks) % filters.length + filters.length) % filters.length;
			this._selectedFilter.set(context, filters[newIdx].filterName);
			this._updateDialFeedback(context);
		});

		this.onDialUp((evtData: DialUpData<unknown>) => this._toggleSelectedFilter(evtData.context));
		this.onTouchTap((evtData: TouchTapData<unknown>) => this._toggleSelectedFilter(evtData.context));

		sockets.forEach((socket, socketIdx) => {
			socket.on('SourceFilterEnableStateChanged', ({ sourceName, filterName, filterEnabled }) => {
				for (const [context] of this.contexts) {
					const entry = this._filterCache.get(context)?.[socketIdx];
					const filter = entry?.sourceName === sourceName ? entry.filters.find(f => f.filterName === filterName) : undefined;
					if (!filter) continue;
					filter.filterEnabled = filterEnabled;
					this._updateDialFeedback(context);
				}
			});
			socket.on('SourceFilterCreated', ({ sourceName }) => this._refreshSource(socketIdx, sourceName));
			socket.on('SourceFilterRemoved', ({ sourceName }) => this._refreshSource(socketIdx, sourceName));
			socket.on('SourceFilterNameChanged', ({ sourceName }) => this._refreshSource(socketIdx, sourceName));
			socket.on('SourceFilterListReindexed', ({ sourceName }) => this._refreshSource(socketIdx, sourceName));
			// Refetch on scene collection changed, since source-specific events are not emitted
			socket.on('CurrentSceneCollectionChanged', () => this._refreshSocket(socketIdx));
		});

		$SD.onDidReceiveGlobalSettings(() => {
			for (const [context] of this.contexts) this._updateDialFeedback(context);
		});
	}

	protected abstract resolveSourceName(socketIdx: number, socketSettings: SocketSettings<T> | null | undefined): string | undefined;

	protected resolveDisplayName(socketIdx: number, socketSettings: SocketSettings<T> | null | undefined): string | undefined {
		return this.resolveSourceName(socketIdx, socketSettings);
	}

	/** Refetch the filters of contexts whose resolved source changed (e.g. a dynamic ingest position now lands on another ingest) */
	protected async notifyTargetsChanged(socketIdx: number): Promise<void> {
		for (const [context, { settings }] of this.contexts) {
			const resolvedName = this.resolveSourceName(socketIdx, settings[socketIdx]);
			if (this._filterCache.get(context)?.[socketIdx]?.sourceName === resolvedName) continue;
			await this._refreshTarget(context, socketIdx);
			this._updateDialFeedback(context);
		}
	}

	override async onContextAppear(context: string, { settings }: ContextData<T>): Promise<void> {
		$SD.setFeedbackLayout(context, 'actions/filterdial/layout.json');
		this._filterCache.set(context, new Array(sockets.length).fill(undefined));
		await Promise.all(settings.map((_, socketIdx) => this._refreshTarget(context, socketIdx)));
		this._updateDialFeedback(context);
	}

	override async onContextSettingsUpdated(context: string, { settings }: ContextData<T>): Promise<void> {
		await Promise.all(settings.map((_, socketIdx) => this._refreshTarget(context, socketIdx)));
		this._updateDialFeedback(context);
	}

	override async onContextDisappear(context: string): Promise<void> {
		this._filterCache.delete(context);
		this._selectedFilter.delete(context);
	}

	override async onSocketConnected(socketIdx: number): Promise<void> {
		await this._refreshSocket(socketIdx);
	}

	override async onSocketDisconnected(socketIdx: number): Promise<void> {
		for (const [context] of this.contexts) {
			this._filterCache.get(context)?.splice(socketIdx, 1, undefined);
			this._updateDialFeedback(context);
		}
	}

	private async _refreshTarget(context: string, socketIdx: number): Promise<void> {
		const cache = this._filterCache.get(context);
		if (!cache) return;
		const socketSettings = this.contexts.get(context)?.settings[socketIdx];
		const sourceName = this.resolveSourceName(socketIdx, socketSettings);
		if (!sourceName || !sockets[socketIdx].isConnected) {
			cache[socketIdx] = undefined;
			return;
		}
		// Empty list if the source doesn't exist (yet) - still cached, so it isn't refetched until the source changes
		const filters = await getSourceFilterList(socketIdx, sourceName);
		const excluded = parseExcludedFilters(socketSettings?.excludedFilters);
		cache[socketIdx] = {
			sourceName,
			filters: filters
			.map(f => ({ filterName: String(f.filterName), filterEnabled: !!f.filterEnabled }))
			.filter(f => !excluded.has(f.filterName.toLowerCase())),
		};
	}

	private async _refreshSource(socketIdx: number, sourceName: string): Promise<void> {
		for (const [context] of this.contexts) {
			if (this._filterCache.get(context)?.[socketIdx]?.sourceName !== sourceName) continue;
			await this._refreshTarget(context, socketIdx);
			this._updateDialFeedback(context);
		}
	}

	private async _refreshSocket(socketIdx: number): Promise<void> {
		for (const [context] of this.contexts) {
			await this._refreshTarget(context, socketIdx);
			this._updateDialFeedback(context);
		}
	}

	/** The filter picked by rotating, or the first one if nothing is picked yet or the picked one no longer exists */
	private _getSelectedFilter(context: string, socketIdx: number): FilterEntry | undefined {
		const filters = this._filterCache.get(context)?.[socketIdx]?.filters ?? [];
		const selected = this._selectedFilter.get(context);
		return filters.find(f => f.filterName === selected) ?? filters[0];
	}

	/** Toggle the selected filter on every target that has a filter of that name, all set to the opposite of the displayed target's state */
	private async _toggleSelectedFilter(context: string): Promise<void> {
		if (!this.contexts.has(context)) return;
		const { settings, displayIdx } = this.contexts.get(context)!;
		this._warnIfDisconnected(context, settings);
		const selected = this._getSelectedFilter(context, displayIdx);
		if (!selected) return;

		const filterEnabled = !selected.filterEnabled;
		const cache = this._filterCache.get(context);
		const results = await Promise.allSettled(settings.map((socketSettings, socketIdx) => {
			const entry = cache?.[socketIdx];
			if (!socketSettings || !entry || !sockets[socketIdx].isConnected) return Promise.resolve();
			if (!entry.filters.some(f => f.filterName === selected.filterName)) return Promise.resolve();
			return sockets[socketIdx].call('SetSourceFilterEnabled', { sourceName: entry.sourceName, filterName: selected.filterName, filterEnabled });
		}));
		if (globalSettings.feedback !== 'hide' && results.some(result => result.status === 'rejected')) $SD.showAlert(context);
	}

	private _updateDialFeedback(context: string): void {
		if (!this.contexts.has(context)) return;
		const { settings, displayIdx } = this.contexts.get(context)!;
		const title = this.resolveDisplayName(displayIdx, settings[displayIdx]);
		if (!title) {
			$SD.setFeedback(context, this._dimFeedback({ status: '', title: 'N/A', value: 'No Source', indicator: 0 }, displayIdx));
			return;
		}
		const filters = this._filterCache.get(context)?.[displayIdx]?.filters ?? [];
		const selected = this._getSelectedFilter(context, displayIdx);
		if (!selected) {
			$SD.setFeedback(context, this._dimFeedback({ status: '', title, value: 'No Filters', indicator: 0 }, displayIdx));
			return;
		}
		const idx = filters.indexOf(selected);
		const percent = filters.length > 1 ? Math.round((idx / (filters.length - 1)) * 100) : 100;
		$SD.setFeedback(context, this._dimFeedback({
			status: { value: `${selected.filterEnabled ? 'ENABLED' : 'DISABLED'} · ${idx + 1}/${filters.length}`, color: selected.filterEnabled ? ENABLED_COLOR : DISABLED_COLOR },
			title,
			value: selected.filterName,
			indicator: percent,
		}, displayIdx));
	}
}
