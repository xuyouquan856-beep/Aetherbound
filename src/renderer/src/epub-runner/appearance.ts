import type { ReadingAppearance } from "../../../shared/contracts.js";

export function paginatorLayoutAttributes(appearance: ReadingAppearance) {
  return {
    flow: appearance.epubFlow,
    "max-inline-size": `${appearance.measure}px`,
    "max-column-count": appearance.epubColumns === "single" ? "1" : "2",
  };
}

export function publicationAppearanceCss(appearance: ReadingAppearance) {
  const foreground = appearance.theme === "night" ? "#e6e1d8" : "#2d322f";
  const background = appearance.theme === "night" ? "#1c201e" : "#f5f1e8";
  const family = appearance.fontFamily === "serif"
    ? "ui-serif, 'Noto Serif CJK SC', 'Source Han Serif SC', serif"
    : "ui-sans-serif, 'Noto Sans CJK SC', 'Microsoft YaHei', sans-serif";
  const indent = appearance.firstLineIndent === "two-em" ? "2em" : "0";
  return `:root{--theme-bg-color:${background};color-scheme:${appearance.theme === "night" ? "dark" : "light"};background:${background}!important;color:${foreground}!important}
    body{background:${background}!important;color:${foreground}!important;font-family:${family};font-size:${appearance.fontSize}px!important;line-height:${appearance.lineHeight}!important;letter-spacing:${appearance.letterSpacing}em}
    body p:not([class*="verse"]):not([class*="poem"]):not([style*="text-indent"]){margin-block-start:0;margin-block-end:${appearance.paragraphSpacing}em;text-indent:${indent}}
    pre,code,ruby,rt,table,nav,[role="doc-toc"]{letter-spacing:normal!important;text-indent:0!important}
    h1,h2,h3,h4,h5,h6{letter-spacing:normal;text-indent:0}
    a{color:inherit} img,svg{max-width:100%;height:auto}`;
}
