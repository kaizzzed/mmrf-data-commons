import { useEffect, useRef, type RefObject } from 'react';

/**
 * When a card that waits on the researcher appears, focus moves to its heading, never to a
 * button. If the composer holds text, focus stays put (the live region announces the card), so
 * Enter typed there can never answer the card (E21, C-17). Read once, when the card appears.
 */
export const useAppearFocus = (
  headingRef: RefObject<HTMLHeadingElement | null>,
  composerHasText: boolean | (() => boolean),
): void => {
  const typing = useRef(composerHasText);
  useEffect(() => {
    const holdsText = typeof typing.current === 'function' ? typing.current() : typing.current;
    if (!holdsText) headingRef.current?.focus();
  }, [headingRef]);
};
