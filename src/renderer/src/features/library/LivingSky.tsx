import { useMemo, useRef } from "react";
import { useButterflyFlight } from "./useButterflyFlight.js";
import { ButterflyMark } from "../shell/ButterflyMark.js";

/** One decoration layer per shell; flight and trails share the same coordinates. */
export function LivingSky({ active = true }: { active?: boolean }) {
  const stars = useMemo(() => Array.from({ length: 62 }, () => ({
    left: `${Math.random() * 100}%`, top: `${Math.random() * 100}%`,
    width: Math.random() > .85 ? 3 : 1.5, height: Math.random() > .85 ? 3 : 1.5,
    animationDelay: `${-Math.random() * 12}s`, animationDuration: `${3 + Math.random() * 6}s`,
  })), []);
  const layerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useButterflyFlight(layerRef, canvasRef, active);
  return <div ref={layerRef} className="living-sky" aria-hidden="true" data-active={active}>
    {stars.map((style, index) => <i key={index} style={style} />)}
    <canvas ref={canvasRef} className="butterfly-trails" />
    {[0, 1, 2].map(index => <span className={`sky-flight__butterfly sky-flight__butterfly--${index}`} key={index}><ButterflyMark /></span>)}
  </div>;
}
