/**
 * Свои select и combobox вместо системных: нативный элемент остаётся единственным источником
 * значения, имени и события change — подменяется только его внешний вид. Только для браузера.
 */
let seq = 0;

/** Закрыватели всех открытых списков: клик где угодно ещё закрывает их. */
const open = new Set<(target: Node) => void>();
let listening = false;
function listenOutside() {
  if (listening) return;
  listening = true;
  document.addEventListener('pointerdown', e => { for (const close of [...open]) close(e.target as Node); }, true);
}

type List = { wrap: HTMLElement; list: HTMLUListElement; setItems: (items: string[], selected: number) => void; show: () => void; hide: (focusBack: boolean) => void; active: () => number };

function listbox(anchor: HTMLElement, control: HTMLElement, id: string, onPick: (index: number) => void): List {
  listenOutside();
  const wrap = document.createElement('div');
  wrap.className = 'cselect';
  const list = document.createElement('ul');
  list.className = 'cselect-list';
  list.id = id;
  list.role = 'listbox';
  list.tabIndex = -1;
  list.hidden = true;
  anchor.after(wrap);
  wrap.append(control, list);
  let active = 0, count = 0;

  const highlight = (index: number) => {
    active = Math.max(0, Math.min(index, count - 1));
    [...list.children].forEach((li, i) => li.classList.toggle('active', i === active && count > 0));
    const current = list.children[active] as HTMLElement | undefined;
    if (current?.id) { control.setAttribute('aria-activedescendant', current.id); current.scrollIntoView({ block: 'nearest' }); }
    else control.removeAttribute('aria-activedescendant');
  };
  const hide = (focusBack: boolean) => {
    if (list.hidden) return;
    list.hidden = true;
    wrap.removeAttribute('data-open');
    control.setAttribute('aria-expanded', 'false');
    control.removeAttribute('aria-activedescendant');
    open.delete(outside);
    if (focusBack) control.focus();
  };
  const show = () => {
    if (!count) return;
    list.hidden = false;
    wrap.setAttribute('data-open', '');
    control.setAttribute('aria-expanded', 'true');
    highlight(active);
    open.add(outside);
  };
  function outside(target: Node) { if (!wrap.contains(target)) hide(false); }

  const setItems = (items: string[], selected: number) => {
    count = items.length;
    list.replaceChildren(...items.map((text, i) => {
      const li = document.createElement('li');
      li.id = `${id}-${i}`;
      li.role = 'option';
      li.textContent = text;
      li.setAttribute('aria-selected', String(i === selected));
      if (i === selected) li.classList.add('active');
      li.addEventListener('mousedown', e => e.preventDefault());
      li.addEventListener('click', () => { onPick(i); hide(true); });
      return li;
    }));
    active = Math.max(0, selected);
    if (!count) hide(false);
  };

  list.addEventListener('keydown', e => {
    const keys: Record<string, () => void> = {
      Escape: () => hide(true), ArrowDown: () => highlight(active + 1), ArrowUp: () => highlight(active - 1),
      Home: () => highlight(0), End: () => highlight(count - 1),
      Enter: () => { onPick(active); hide(true); }, ' ': () => { onPick(active); hide(true); },
    };
    if (keys[e.key]) { e.preventDefault(); keys[e.key](); } else if (e.key === 'Tab') hide(false);
  });

  return { wrap, list, setItems, show, hide, active: () => active };
}

/** One listbox per select, reused across redraws so its open/close state stays live. */
const boxes = new WeakMap<HTMLSelectElement, List>();

/**
 * Прячет `select` и рисует кнопку + список, синхронизированные с ним. Можно вызывать повторно
 * после смены опций или значения — перерисует на месте.
 */
export function customSelect(select: HTMLSelectElement) {
  select.hidden = true;
  let box = boxes.get(select);
  if (!box) {
    const buttonId = `${select.id || `cs${++seq}`}-btn`, listId = `${buttonId}-list`;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'cselect-btn';
    button.id = buttonId;
    button.setAttribute('aria-haspopup', 'listbox');
    button.setAttribute('aria-expanded', 'false');
    button.setAttribute('aria-controls', listId);
    for (const attribute of ['aria-describedby', 'aria-label', 'aria-labelledby']) {
      const value = select.getAttribute(attribute);
      if (value) button.setAttribute(attribute, attribute === 'aria-labelledby' ? `${value} ${buttonId}` : value);
    }
    const label = select.id ? document.querySelector<HTMLLabelElement>(`label[for="${select.id}"]`) : null;
    if (label) label.htmlFor = buttonId;
    // Перерисовка через повторный customSelect(): кнопка и список отражают новое значение
    // независимо от того, слушает ли кто-нибудь ещё событие change.
    box = listbox(select, button, listId, index => {
      select.selectedIndex = index;
      select.dispatchEvent(new Event('change', { bubbles: true }));
      customSelect(select);
    });
    boxes.set(select, box);
    button.addEventListener('click', () => (box!.list.hidden ? (box!.show(), box!.list.focus()) : box!.hide(true)));
    button.addEventListener('keydown', e => { if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); box!.show(); box!.list.focus(); } });
  }
  const button = box.wrap.querySelector<HTMLButtonElement>('.cselect-btn')!;
  button.textContent = select.options[select.selectedIndex]?.textContent ?? '';
  // setItems (not a manual rebuild) keeps the listbox's own item count and click/hide wiring in sync — a
  // parallel rebuild here previously left that count at 0 forever, so the popup could never open (#admin role select bug).
  box.setItems([...select.options].map(option => option.textContent ?? ''), select.selectedIndex);
}

/**
 * Подсказки к текстовому полю: список фильтруется по введённому, но любое своё значение остаётся
 * допустимым — поле обычное, проверку делает та же форма, что и без подсказок.
 * `options` можно обновить позже через возвращённый setter.
 */
export function customCombo(input: HTMLInputElement, options: string[] = [], limit = 8): (next: string[]) => void {
  const listId = `${input.id || `cb${++seq}`}-list`;
  let all = options, shown: string[] = [];
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-expanded', 'false');
  input.setAttribute('aria-controls', listId);
  input.setAttribute('aria-autocomplete', 'list');
  input.autocomplete = 'off';

  const box = listbox(input, input, listId, index => {
    input.value = shown[index] ?? input.value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  box.wrap.classList.add('cselect--combo');

  const refresh = () => {
    const query = input.value.trim().toLowerCase();
    shown = all.filter(name => name.toLowerCase().includes(query)).slice(0, limit);
    box.setItems(shown, shown.findIndex(name => name.toLowerCase() === query));
  };
  const openList = () => { refresh(); if (shown.length) box.show(); };

  input.addEventListener('input', () => { refresh(); if (shown.length && document.activeElement === input) box.show(); else box.hide(false); });
  input.addEventListener('focus', openList);
  input.addEventListener('blur', () => setTimeout(() => { if (!box.wrap.contains(document.activeElement)) box.hide(false); }, 0));
  input.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); openList(); box.list.focus(); }
    else if (e.key === 'Escape') box.hide(false);
  });

  return (next: string[]) => { all = next; if (document.activeElement === input) refresh(); };
}
