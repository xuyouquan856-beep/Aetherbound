import { ImageSquare, X } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { EpubGalleryImage, EpubImageCatalog } from "./epub-image-catalog.js";

type Props = {
  publicationBytes: Uint8Array | null;
  open: boolean;
  onChapters(): void;
  onClose(): void;
};

function ImageTile({ image, catalog, onOpen }: {
  image: EpubGalleryImage;
  catalog: EpubImageCatalog;
  onOpen(): void;
}) {
  const button = useRef<HTMLButtonElement>(null);
  const [visible, setVisible] = useState(false);
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    const element = button.current;
    if (!element) return;
    if (typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setVisible(true);
        observer.disconnect();
      }
    }, { root: element.closest(".epub-gallery-list"), rootMargin: "180px" });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!visible) return;
    let current = true;
    let objectUrl: string | null = null;
    catalog.readImage(image).then((bytes) => {
      if (!current) return;
      objectUrl = URL.createObjectURL(new Blob([Uint8Array.from(bytes)], { type: image.mediaType }));
      setUrl(objectUrl);
    }).catch(() => undefined);
    return () => {
      current = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [catalog, image, visible]);

  return <button className="epub-gallery-tile" type="button" ref={button} onClick={onOpen} aria-label={`查看${image.label}`}>
    <span className="epub-gallery-tile__picture">
      {url ? <img src={url} alt="" loading="lazy" /> : <ImageSquare size={28} aria-hidden="true" />}
    </span>
    <span className="epub-gallery-tile__label">{image.label}</span>
  </button>;
}

function ImagePreview({ image, catalog, index, count, onStep, onClose }: {
  image: EpubGalleryImage;
  catalog: EpubImageCatalog;
  index: number;
  count: number;
  onStep(step: -1 | 1): void;
  onClose(): void;
}) {
  const dialog = useRef<HTMLDivElement>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => { dialog.current?.focus(); }, []);
  useEffect(() => {
    let current = true;
    let objectUrl: string | null = null;
    setUrl(null);
    setError(false);
    catalog.readImage(image).then((bytes) => {
      if (!current) return;
      objectUrl = URL.createObjectURL(new Blob([Uint8Array.from(bytes)], { type: image.mediaType }));
      setUrl(objectUrl);
    }).catch(() => { if (current) setError(true); });
    return () => {
      current = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [catalog, image]);

  return createPortal(<div
    className="epub-image-preview"
    role="dialog"
    aria-modal="true"
    aria-label={`${image.label}大图`}
    ref={dialog}
    tabIndex={-1}
    onKeyDown={(event) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); }
      if (event.key === "ArrowLeft") { event.preventDefault(); event.stopPropagation(); onStep(-1); }
      if (event.key === "ArrowRight") { event.preventDefault(); event.stopPropagation(); onStep(1); }
    }}
  >
    <header className="epub-image-preview__header">
      <div><strong>{image.label}</strong><span>{index + 1} / {count}</span></div>
      <button className="icon-button" type="button" aria-label="关闭图片预览" onClick={onClose}><X size={22} /></button>
    </header>
    <div className="epub-image-preview__canvas">
      {url ? <img src={url} alt={image.label} /> : error ? <p>这张图片暂时无法打开</p> : <p>正在载入图片…</p>}
    </div>
    <div className="epub-image-preview__navigation">
      <button type="button" onClick={() => onStep(-1)} disabled={index === 0} aria-label="上一张图片">‹</button>
      <button type="button" onClick={() => onStep(1)} disabled={index === count - 1} aria-label="下一张图片">›</button>
    </div>
  </div>, document.querySelector(".app") ?? document.body);
}

export function EpubImageGalleryPanel({ publicationBytes, open, onChapters, onClose }: Props) {
  const [catalog, setCatalog] = useState<EpubImageCatalog | null>(null);
  const [error, setError] = useState(false);
  const [shown, setShown] = useState(12);
  const [selected, setSelected] = useState<number | null>(null);

  useEffect(() => {
    if (!open || !publicationBytes) {
      setCatalog(null);
      setSelected(null);
      return;
    }
    let current = true;
    setCatalog(null);
    setError(false);
    setShown(12);
    import("./epub-image-catalog.js")
      .then(({ openEpubImageCatalog }) => openEpubImageCatalog(publicationBytes))
      .then((result) => { if (current) setCatalog(result); })
      .catch(() => { if (current) setError(true); });
    return () => { current = false; };
  }, [open, publicationBytes]);

  const images = catalog?.images ?? [];
  return <aside className="reader-panel reader-panel--chapters" data-open={open} aria-label="图片目录" aria-hidden={!open}>
    <header className="panel-header">
      <div><strong>图片目录</strong><span>{catalog ? `${images.length} 张图片` : "封面与插图"}</span></div>
      <button className="icon-button" type="button" aria-label="收起图片目录" onClick={onClose}><X size={20} /></button>
    </header>
    <div className="reader-catalog-tabs" role="group" aria-label="目录类型">
      <button type="button" onClick={onChapters}>章节</button>
      <button type="button" data-active="true" aria-current="page">图片</button>
    </div>
    {open && <div className="epub-gallery-list">
      {!publicationBytes || (!catalog && !error) ? <p className="epub-gallery-message">正在整理图片…</p>
        : error ? <p className="epub-gallery-message">这本书的图片目录暂时无法打开。</p>
          : images.length === 0 ? <p className="epub-gallery-message">这本书没有可浏览的封面或插图。</p>
            : <>
              <div className="epub-gallery-grid">
                {images.slice(0, shown).map((image, index) => <ImageTile key={image.href} image={image} catalog={catalog!} onOpen={() => setSelected(index)} />)}
              </div>
              {shown < images.length && <button className="epub-gallery-more" type="button" onClick={() => setShown((count) => count + 12)}>显示更多图片</button>}
            </>}
    </div>}
    {open && catalog && selected !== null && images[selected] && <ImagePreview
      image={images[selected]}
      catalog={catalog}
      index={selected}
      count={images.length}
      onStep={(step) => setSelected((current) => current === null ? null : Math.max(0, Math.min(images.length - 1, current + step)))}
      onClose={() => setSelected(null)}
    />}
  </aside>;
}
