/**
 * Replaces the native <datalist> popup (which can't scroll and runs off-screen with long lists)
 * with a scrollable dropdown sized to the available viewport space. Works on any
 * <input list="..."> present now or added later; the datalist's options are read live on every open.
 */
(() => {
	const popup = document.createElement('div');
	Object.assign(popup.style, {
		position: 'fixed', zIndex: '10000', display: 'none', overflowY: 'auto', boxSizing: 'border-box',
		background: 'var(--sdpi-bgcolor, #2D2D2D)', color: 'var(--sdpi-color, #d8d8d8)',
		border: '1px solid var(--sdpi-bordercolor, #3a3a3a)', fontSize: '12px',
	});
	document.body.appendChild(popup);

	let activeInput = null;
	let items = [];
	let highlighted = -1;
	let choosing = false;

	function optionsFor(input) {
		const list = document.getElementById(input.dataset.list);
		if (!list) return [];
		return [...list.options].map((o) => ({ value: o.value, label: o.textContent && o.textContent !== o.value ? o.textContent : o.value }));
	}

	function highlight(idx) {
		highlighted = idx;
		[...popup.children].forEach((el, i) => {
			el.style.background = i === idx ? 'var(--sdpi-bordercolor, #3a3a3a)' : 'transparent';
			if (i === idx) el.scrollIntoView({ block: 'nearest' });
		});
	}

	function close() {
		popup.style.display = 'none';
		activeInput = null;
	}

	function choose(value) {
		if (!activeInput) return;
		const input = activeInput;
		input.value = value;
		close();
		choosing = true;
		input.dispatchEvent(new Event('input', { bubbles: true }));
		input.dispatchEvent(new Event('change', { bubbles: true }));
		choosing = false;
	}

	function open(input, filter = true) {
		const query = filter ? input.value.trim().toLowerCase() : '';
		items = optionsFor(input).filter((o) => !query || o.value.toLowerCase().includes(query) || o.label.toLowerCase().includes(query));
		if (!items.length || (items.length === 1 && items[0].value === input.value)) return close();
		activeInput = input;
		popup.replaceChildren(...items.map((o, i) => {
			const el = document.createElement('div');
			el.textContent = o.label;
			el.title = o.label;
			Object.assign(el.style, { padding: '3px 6px', cursor: 'pointer', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' });
			el.addEventListener('mousedown', (e) => { e.preventDefault(); choose(o.value); });
			el.addEventListener('mouseenter', () => highlight(i));
			return el;
		}));
		const rect = input.getBoundingClientRect();
		const below = window.innerHeight - rect.bottom - 4;
		const above = rect.top - 4;
		const openUp = below < 120 && above > below;
		popup.style.display = 'block';
		popup.style.left = `${rect.left}px`;
		popup.style.width = `${rect.width}px`;
		popup.style.maxHeight = `${Math.max(60, openUp ? above : below)}px`;
		if (openUp) { popup.style.top = ''; popup.style.bottom = `${window.innerHeight - rect.top}px`; }
		else { popup.style.bottom = ''; popup.style.top = `${rect.bottom}px`; }
		highlight(-1);
	}

	// Strip the native list on first touch so the browser popup never appears
	document.addEventListener('focusin', (e) => {
		const input = e.target;
		if (!(input instanceof HTMLInputElement)) return;
		if (input.hasAttribute('list')) {
			input.dataset.list = input.getAttribute('list');
			input.removeAttribute('list');
		}
		if (input.dataset.list) open(input, false);
	}, true);
	document.addEventListener('mousedown', (e) => {
		const input = e.target;
		if (input instanceof HTMLInputElement && input.dataset.list && input !== activeInput) open(input, false);
	}, true);
	document.addEventListener('input', (e) => {
		if (!choosing && e.target instanceof HTMLInputElement && e.target.dataset.list) open(e.target);
	});
	document.addEventListener('keydown', (e) => {
		if (!activeInput || e.target !== activeInput) return;
		if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
			e.preventDefault();
			highlight((highlighted + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length);
		}
		else if (e.key === 'Enter' && highlighted >= 0) { e.preventDefault(); choose(items[highlighted].value); }
		else if (e.key === 'Escape') close();
	});
	document.addEventListener('focusout', (e) => { if (e.target === activeInput) close(); });
	window.addEventListener('scroll', (e) => { if (e.target !== popup) close(); }, true);
	window.addEventListener('resize', close);
})();
