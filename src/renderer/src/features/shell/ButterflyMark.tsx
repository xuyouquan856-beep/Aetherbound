type Props = {
  className?: string;
  title?: string;
};

/** The butterfly is part of the product identity, so it is kept as a small
 * inline mark instead of relying on an icon font with a different silhouette. */
export function ButterflyMark({ className, title }: Props) {
  const instanceId = useId().replace(/:/g, "");
  const wingBlueId = `${instanceId}-wing-blue`;
  const wingIceId = `${instanceId}-wing-ice`;
  const labelled = Boolean(title);
  return (
    <svg
      className={className}
      viewBox="0 0 48 48"
      role={labelled ? "img" : undefined}
      aria-label={labelled ? title : undefined}
      aria-hidden={labelled ? undefined : true}
      focusable="false"
    >
      <defs>
        <linearGradient id={wingBlueId} x1="0" y1="0" x2=".75" y2="1">
          <stop stopColor="#243e89" />
          <stop offset=".48" stopColor="#348ad0" />
          <stop offset=".82" stopColor="#60dcf1" />
          <stop offset="1" stopColor="#d4ffff" />
        </linearGradient>
        <linearGradient id={wingIceId} x1="1" y1="0" x2="0" y2="1">
          <stop stopColor="#507dbb" />
          <stop offset=".65" stopColor="#7edff6" />
          <stop offset="1" stopColor="#efffff" />
        </linearGradient>
      </defs>
      <path d="M24 29C17 25 10 18 5 2L8 25C9 31 17 33 24 29Z" fill={`url(#${wingBlueId})`} />
      <path d="M25 29C27 17 35 9 44 3L38 24C35 31 30 32 25 29Z" fill={`url(#${wingIceId})`} />
      <path d="M23 30C15 27 9 31 2 38L15 36L12 45C19 41 22 36 24 31Z" fill={`url(#${wingBlueId})`} />
      <path d="M26 30C33 27 38 31 44 36L34 35L35 43C29 39 26 35 25 31Z" fill={`url(#${wingIceId})`} />
      <path d="M10 13L24 30L38 14M24 30L16 38M25 30L33 36" stroke="#c1fbff" strokeWidth=".55" opacity=".65" fill="none" />
      <path d="M24 25L25 36M24 26L20 20M25 26L29 20" stroke="#aeecf9" strokeWidth="1.1" fill="none" />
    </svg>
  );
}
import { useId } from "react";

