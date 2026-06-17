// Shared PDF *byte* cache.
//
// The main canvas and the sidebar thumbnails need the same document, and the
// canvas re-runs its render effect on every page switch / zoom. Caching at
// the byte level deduplicates the network fetch (the expensive part) while
// giving every consumer its OWN pdf.js document.
//
// Deliberately NOT a document-level cache: sharing one PDFDocumentProxy means
// sharing PDFPageProxy objects, and a cancelled render on a shared page
// (StrictMode double-mounts, fast zooming) aborts the operator-list stream
// that another component's in-flight render is consuming — that render then
// hangs forever with no error. Separate documents isolate worker state.
import * as pdfjsLib from 'pdfjs-dist';
import pdfWorker from 'pdfjs-dist/build/pdf.worker.min.js?url';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorker;

type PDFDocument = any;

const byteCache = new Map<string, Promise<ArrayBuffer>>();

export async function getPdfDocument(url: string, version: number): Promise<PDFDocument> {
  const key = `${url}::v${version}`;

  if (!byteCache.has(key)) {
    // Evict stale versions of the same document.
    for (const staleKey of [...byteCache.keys()]) {
      if (staleKey.startsWith(`${url}::`) && staleKey !== key) {
        byteCache.delete(staleKey);
      }
    }
    const versionedUrl = url + (url.includes('?') ? '&' : '?') + 'v=' + version;
    const promise = fetch(versionedUrl)
      .then((res) => {
        if (!res.ok) throw new Error(`PDF fetch failed (${res.status})`);
        return res.arrayBuffer();
      })
      .catch((err) => {
        byteCache.delete(key); // don't poison the cache with a failed load
        throw err;
      });
    byteCache.set(key, promise);
  }

  const bytes = await byteCache.get(key)!;
  // Clone per consumer: pdf.js transfers the buffer to its worker, which
  // detaches it — handing out the cached copy would corrupt the cache.
  return pdfjsLib.getDocument({ data: bytes.slice(0) }).promise;
}
