import { ArrowLeft, SpinnerGap } from "@phosphor-icons/react";
import type { BookSummary } from "../../../../shared/contracts.js";

type Props = {
  book: BookSummary;
  onBack(): void;
};

export function ReaderPreparingGate({ book, onBack }: Props) {
  return (
    <section className="reader-preparing-gate" aria-labelledby="reader-preparing-title">
      <SpinnerGap
        className="reader-preparing-gate__spinner"
        size={30}
        weight="duotone"
        aria-hidden="true"
      />
      <p className="reader-preparing-gate__eyebrow">AETHERBOUND READER</p>
      <h1 id="reader-preparing-title">正在准备本书</h1>
      <p className="reader-preparing-gate__book">《{book.title}》</p>
      <p className="reader-preparing-gate__detail">
        正在建立安全阅读副本。完成后会自动进入正文，你仍可使用左侧导航。
      </p>
      <button className="button" type="button" onClick={onBack}>
        <ArrowLeft size={17} />
        返回书架
      </button>
    </section>
  );
}
