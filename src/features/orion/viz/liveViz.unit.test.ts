import { createLiveVizRegistry } from './liveViz';

describe('createLiveVizRegistry', () => {
  it('keeps the two newest live and freezes the oldest', () => {
    const registry = createLiveVizRegistry();
    ['a', 'b', 'c'].forEach(registry.activate);
    expect(registry.snapshot()).toEqual(['b', 'c']);
  });

  it('re-opening a frozen card makes it newest and freezes the oldest live one', () => {
    const registry = createLiveVizRegistry();
    ['a', 'b', 'c'].forEach(registry.activate);
    registry.activate('a');
    expect(registry.snapshot()).toEqual(['c', 'a']);
  });

  it('releases a card that unmounts', () => {
    const registry = createLiveVizRegistry();
    ['a', 'b'].forEach(registry.activate);
    registry.release('a');
    expect(registry.snapshot()).toEqual(['b']);
  });

  it('notifies only when membership changes, with a stable snapshot otherwise', () => {
    const registry = createLiveVizRegistry();
    const listener = jest.fn();
    const unsubscribe = registry.subscribe(listener);
    registry.activate('a');
    const first = registry.snapshot();
    registry.activate('a');
    registry.release('missing');
    expect(listener).toHaveBeenCalledTimes(1);
    expect(registry.snapshot()).toBe(first);
    unsubscribe();
    registry.activate('b');
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
