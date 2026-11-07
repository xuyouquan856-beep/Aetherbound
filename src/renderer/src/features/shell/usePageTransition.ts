import { useLayoutEffect, useRef, type RefObject } from "react";

export function usePageTransition(ref: RefObject<HTMLElement | null>, view: string, frozen: boolean) {
  const previous = useRef(view);
  useLayoutEffect(() => {
    const changed = previous.current !== view;
    previous.current = view;
    const element = ref.current;
    if (!changed || frozen || !element?.animate || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    // Opacity keeps fixed dialogs anchored to the viewport during a rapid follow-up click.
    const transition = element.animate([{ opacity: .35 }, { opacity: 1 }], {
      duration: 220, easing: "cubic-bezier(.22,1,.36,1)",
    });
    return () => transition.cancel();
  }, [view, frozen, ref]);
}
