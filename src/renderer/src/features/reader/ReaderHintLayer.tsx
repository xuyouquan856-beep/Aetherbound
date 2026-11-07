type Props = {
  chapter: string;
  progression?: number;
  onPrevious(): void;
  onNext(): void;
  onSeekProgression?(ratio: number): void;
  blocked?: boolean;
  historyHint?: string;
};

export function ReaderHintLayer({
  chapter,
  progression,
  onPrevious,
  onNext,
  onSeekProgression,
  blocked = false,
  historyHint,
}: Props) {
  const clampedProgression = typeof progression === "number"
    ? Math.max(0, Math.min(1, progression))
    : null;
  const progress = clampedProgression !== null
    ? `${Math.round(clampedProgression * 100)}%`
    : "计算中";

  return (
    <div className="reader-hints" data-testid="reader-hints" aria-live="off">
      <div className="reader-hints__top">
        <span>{chapter}</span>
        <span>{progress}</span>
      </div>
      {historyHint && <span className="reader-history-hint">{historyHint}</span>}
      {clampedProgression !== null && (
        <div
          className="reader-hints__progress"
          data-interactive={!blocked && !!onSeekProgression ? "true" : undefined}
          title={!blocked && onSeekProgression ? "点击跳转阅读进度" : undefined}
          aria-hidden="true"
          onClick={(event) => {
            if (blocked || !onSeekProgression) return;
            const rect = event.currentTarget.getBoundingClientRect();
            const ratio = rect.width > 0
              ? Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width))
              : 0;
            onSeekProgression(ratio);
          }}
        >
          <span style={{ transform: `scaleX(${clampedProgression})` }} />
        </div>
      )}
      <button
        type="button"
        className="reader-edge reader-edge--left"
        aria-label="上一页"
        disabled={blocked}
        onClick={(event) => {
          onPrevious();
          if (event.detail > 0) event.currentTarget.blur();
        }}
      >
        <span aria-hidden="true">‹</span>
      </button>
      <button
        type="button"
        className="reader-edge reader-edge--right"
        aria-label="下一页"
        disabled={blocked}
        onClick={(event) => {
          onNext();
          if (event.detail > 0) event.currentTarget.blur();
        }}
      >
        <span aria-hidden="true">›</span>
      </button>
    </div>
  );
}
