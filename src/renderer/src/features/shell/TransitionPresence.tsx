import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

/** Retain only the departing surface; never delay its logical action or let it receive input. */
export function TransitionPresence({ children, kind = "dialog" }: { children: ReactNode; kind?: "dialog" | "menu" | "toolbar" }) {
  const visible = Boolean(children);
  const [retained, setRetained] = useState(visible);
  const last = useRef(children);
  const root = useRef<HTMLDivElement>(null);
  if (visible) last.current = children;
  useLayoutEffect(() => {
    const wrapper = root.current;
    if (!wrapper) return;
    const surface = wrapper.querySelector<HTMLElement>('[role="dialog"], [role="menu"], nav') ?? wrapper.firstElementChild as HTMLElement | null;
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (visible) setRetained(true);
    if (!surface?.animate || reduced) {
      if (!visible) setRetained(false);
      return;
    }
    let cancelled = false;
    const transform = kind === "dialog" ? "translateY(12px) scale(.975)" : kind === "menu" ? "translateY(-6px) scale(.97)" : "translateY(-8px)";
    const animation = surface.animate(visible
      ? [{ opacity: 0, transform }, { opacity: 1, transform: "none" }]
      : [{ opacity: 1, transform: "none" }, { opacity: 0, transform }], {
      duration: visible ? 230 : 150,
      easing: "cubic-bezier(.22,1,.36,1)", fill: "both",
    });
    const backdrop = kind === "dialog" && surface.parentElement !== wrapper ? surface.parentElement : null;
    const shade = backdrop?.animate(visible ? [{ opacity: 0 }, { opacity: 1 }] : [{ opacity: 1 }, { opacity: 0 }], { duration: visible ? 200 : 150, fill: "both" });
    void animation.finished.then(() => {
      if (cancelled) return;
      if (!visible) setRetained(false);
      else { animation.cancel(); shade?.cancel(); }
    }).catch(() => undefined);
    return () => { cancelled = true; animation.cancel(); shade?.cancel(); };
  }, [visible, kind]);
  if (!visible && !retained) return null;
  return <div ref={root} className="transition-presence" data-state={visible ? "open" : "closing"} inert={!visible} aria-hidden={!visible || undefined}>{visible ? children : last.current}</div>;
}
