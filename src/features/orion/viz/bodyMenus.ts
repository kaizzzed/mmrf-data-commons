// ProteinPaint's Menu appends a div.sja_menu_div and a `mousedown.menu<id>` listener to
// document.body in its constructor, and only Menu.destroy() removes them. The Correlation and
// DE launchers expose no destroy(), so every mount leaves both behind. A scope claims the
// menus added while it is open and, once no other open scope could own a menu, does what
// Menu.destroy() does: removes the div and its body listener.

const MENU_CLASS = 'sja_menu_div';
/** runproteinpaint's module-global headtip (z-index 5555) serves every later mount. */
const HEADTIP_Z_INDEX = '5555';

/** d3-selection keeps an element's listeners in `__on` (d3-selection 3, bundled in 2.216.0). */
interface D3Listener {
  type: string;
  name: string;
  listener: EventListener;
  options?: boolean | AddEventListenerOptions;
}
type D3Element = Element & { __on?: D3Listener[] };

export interface MenuScope {
  /** Removes the menus no other open scope may own; returns how many it removed. */
  release(): number;
}

const open = new Set<symbol>();
const owners = new Map<Element, Set<symbol>>();
let observer: MutationObserver | null = null;

const claim = (records: MutationRecord[]) => {
  for (const record of records) {
    record.addedNodes.forEach((node) => {
      if (node instanceof Element && node.classList.contains(MENU_CLASS) && open.size > 0) {
        owners.set(node, new Set(open));
      }
    });
  }
};

/** The menu div and its body listener share the d3 name `menu<random id>`; drop the latter as d3 does. */
const dropBodyListener = (menu: D3Element, body: D3Element) => {
  const names = new Set(
    (menu.__on ?? []).filter((o) => o.name.startsWith('menu')).map((o) => `${o.type}.${o.name}`),
  );
  if (names.size === 0 || !body.__on) return;
  const kept = body.__on.filter((o) => {
    if (!names.has(`${o.type}.${o.name}`)) return true;
    body.removeEventListener(o.type, o.listener, o.options);
    return false;
  });
  if (kept.length > 0) body.__on = kept;
  else delete body.__on;
};

/** One scope per viewer session; a re-opened card gets a new one. */
export const openMenuScope = (body: HTMLElement = document.body): MenuScope => {
  const scopeId = Symbol('pp-menu-scope');
  open.add(scopeId);
  if (!observer) {
    observer = new MutationObserver(claim);
    observer.observe(body, { childList: true });
  }
  let released = false;
  return {
    release() {
      if (released) return 0;
      released = true;
      // Menus appended since the last callback still belong to this scope.
      if (observer) claim(observer.takeRecords());
      open.delete(scopeId);
      let removed = 0;
      owners.forEach((ids, menu) => {
        if (!ids.delete(scopeId) || ids.size > 0) return;
        owners.delete(menu);
        if ((menu as HTMLElement).style.zIndex === HEADTIP_Z_INDEX) return;
        dropBodyListener(menu, body);
        menu.remove();
        removed += 1;
      });
      if (open.size === 0 && observer) {
        observer.disconnect();
        observer = null;
      }
      return removed;
    },
  };
};
