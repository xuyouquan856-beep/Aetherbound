/// <reference types="vite/client" />

import type { ReaderApi } from "../../shared/contracts.js";

declare global {
  interface Window {
    readerApi: ReaderApi;
  }
}

declare module "*?url" {
  const src: string;
  export default src;
}

declare module "*.png" {
  const src: string;
  export default src;
}

export {};
