import { openMenuScope } from './bodyMenus';

const addMenu = (zIndex?: string): HTMLDivElement => {
  const menu = document.createElement('div');
  menu.className = 'sja_menu_div';
  if (zIndex) menu.style.zIndex = zIndex;
  document.body.appendChild(menu);
  return menu;
};

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => document.body.replaceChildren());

describe('openMenuScope', () => {
  it('removes the menus added while it was open and nothing older', async () => {
    const older = addMenu();
    const scope = openMenuScope();
    const mine = addMenu();
    const other = document.createElement('div');
    document.body.appendChild(other);
    await flush();
    expect(scope.release()).toBe(1);
    expect(mine.isConnected).toBe(false);
    expect(older.isConnected).toBe(true);
    expect(other.isConnected).toBe(true);
  });

  it('claims menus appended just before release', () => {
    const scope = openMenuScope();
    const late = addMenu();
    expect(scope.release()).toBe(1);
    expect(late.isConnected).toBe(false);
  });

  it('keeps a menu while another open scope may own it', async () => {
    const first = openMenuScope();
    const second = openMenuScope();
    const shared = addMenu();
    await flush();
    expect(first.release()).toBe(0);
    expect(shared.isConnected).toBe(true);
    expect(second.release()).toBe(1);
    expect(shared.isConnected).toBe(false);
  });

  it("keeps runproteinpaint's global headtip", async () => {
    const scope = openMenuScope();
    const headtip = addMenu('5555');
    await flush();
    expect(scope.release()).toBe(0);
    expect(headtip.isConnected).toBe(true);
  });

  it("removes a removed menu's body listener the way Menu.destroy() does", async () => {
    type D3Node = Element & { __on?: { type: string; name: string; listener: EventListener }[] };
    const body = document.body as D3Node;
    const unrelated = jest.fn();
    const menuHide = jest.fn();
    body.__on = [{ type: 'mousedown', name: 'other', listener: unrelated }];
    body.addEventListener('mousedown', unrelated);
    const scope = openMenuScope();
    const menu = addMenu() as D3Node;
    menu.__on = [{ type: 'mousedown', name: 'menu0.42', listener: jest.fn() }];
    body.__on.push({ type: 'mousedown', name: 'menu0.42', listener: menuHide });
    body.addEventListener('mousedown', menuHide);
    await flush();
    expect(scope.release()).toBe(1);
    body.dispatchEvent(new MouseEvent('mousedown'));
    expect(menuHide).not.toHaveBeenCalled();
    expect(unrelated).toHaveBeenCalledTimes(1);
    expect(body.__on.map((o) => o.name)).toEqual(['other']);
    body.removeEventListener('mousedown', unrelated);
    delete body.__on;
  });

  it('releases once', async () => {
    const scope = openMenuScope();
    addMenu();
    await flush();
    expect(scope.release()).toBe(1);
    expect(scope.release()).toBe(0);
  });
});
