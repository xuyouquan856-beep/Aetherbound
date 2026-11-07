import { useEffect, useRef, type ReactNode, type TransitionEvent } from "react";
import type { ReaderPhase } from "./reader-lifecycle.js";

type Props = {
  phase: ReaderPhase | "library";
  library: ReactNode;
  reader: ReactNode;
  onPresented(): void;
};

export function ReaderStage({
  phase,
  library,
  reader,
  onPresented,
}: Props) {
  const presentedRef = useRef(false);
  const callbackRef = useRef(onPresented);
  callbackRef.current = onPresented;
  const readerVisible = phase === "presenting" || phase === "active";

  useEffect(() => {
    if (phase !== "presenting") {
      presentedRef.current = false;
      return;
    }
    if (!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    const frame = requestAnimationFrame(() => {
      if (presentedRef.current) return;
      presentedRef.current = true;
      callbackRef.current();
    });
    return () => cancelAnimationFrame(frame);
  }, [phase]);

  function handleReaderTransitionEnd(event: TransitionEvent<HTMLDivElement>) {
    if (
      phase !== "presenting"
      || event.propertyName !== "opacity"
      || presentedRef.current
    ) return;
    presentedRef.current = true;
    callbackRef.current();
  }

  return (
    <div className="reader-transition-stage" data-reader-phase={phase}>
      <div
        className="reader-transition-layer reader-transition-layer--library"
        data-testid="reader-transition-library"
        aria-hidden={readerVisible}
        inert={readerVisible}
      >
        {library}
      </div>
      <div
        className="reader-transition-layer reader-transition-layer--reader"
        data-testid="reader-transition-reader"
        aria-hidden={!readerVisible}
        inert={!readerVisible}
        onTransitionEnd={handleReaderTransitionEnd}
      >
        {reader}
      </div>
    </div>
  );
}
