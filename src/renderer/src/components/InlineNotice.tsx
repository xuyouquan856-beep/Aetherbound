import { WarningCircle } from "@phosphor-icons/react";
import type { ReaderNoticeModel } from "../errors/public-error.js";

export function InlineNotice({ notice, className = "" }: { notice: ReaderNoticeModel; className?: string }) {
  return (
    <div className={`inline-notice ${className}`.trim()} role="alert">
      <WarningCircle className="inline-notice__icon" size={20} weight="duotone" aria-hidden="true" />
      <div className="inline-notice__copy">
        <strong>{notice.title}</strong>
        <span>{notice.detail}</span>
      </div>
      <code className="inline-notice__code" aria-label={`错误代码 ${notice.code}`}>{notice.code}</code>
    </div>
  );
}