import React, { useEffect, useRef, useState } from 'react';
import { AeroLogo } from './AeroLogo';
import { getPdfDocument } from '../pdfCache';

interface PDFPage {
  number: number;
  width: number;
  height: number;
  blocks: any[];
  images: any[];
  objects: any[];
}

interface SidebarProps {
  pages: PDFPage[];
  activePage: number;
  filename: string;
  pdfUrl?: string;
  docVersion: number;
  setActivePage: (pageNum: number) => void;
}

const ThumbnailCanvas: React.FC<{ page: PDFPage; pdfDoc: any }> = ({ page, pdfDoc }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    let cancelled = false;
    let renderTask: any = null;

    const renderPage = async () => {
      if (!canvasRef.current || !pdfDoc) return;
      try {
        const pdfPage = await pdfDoc.getPage(page.number);
        if (cancelled) return;
        const viewport = pdfPage.getViewport({ scale: 1 });
        const thumbHeight = 126;
        const scale = thumbHeight / viewport.height;
        const scaledViewport = pdfPage.getViewport({ scale });

        const canvas = canvasRef.current;
        canvas.width = scaledViewport.width;
        canvas.height = scaledViewport.height;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        renderTask = pdfPage.render({ canvasContext: ctx, viewport: scaledViewport });
        await renderTask.promise;
      } catch {
        // ignore thumbnail errors
      }
    };

    renderPage();
    return () => {
      cancelled = true;
      renderTask?.cancel();
    };
  }, [page.number, pdfDoc]);

  return <canvas ref={canvasRef} className="thumb-canvas" />;
};

export const Sidebar: React.FC<SidebarProps> = ({ pages, activePage, filename, pdfUrl, docVersion, setActivePage }) => {
  const [pdfDoc, setPdfDoc] = useState<any>(null);

  useEffect(() => {
    if (!pdfUrl) {
      setPdfDoc(null);
      return;
    }
    let cancelled = false;
    let doc: any = null;

    const loadPdf = async () => {
      try {
        // Bytes are fetched once per version (shared with the canvas), but
        // this is the sidebar's OWN parsed document — see pdfCache.ts.
        doc = await getPdfDocument(pdfUrl, docVersion);
        if (!cancelled) setPdfDoc(doc);
      } catch {
        if (!cancelled) setPdfDoc(null);
      }
    };

    loadPdf();
    return () => {
      cancelled = true;
      // Free the worker once in-flight thumbnail renders have settled
      // (ThumbnailCanvas swallows render errors from a destroyed doc).
      const stale = doc;
      if (stale) {
        setTimeout(() => {
          try {
            stale.destroy();
          } catch {
            // already destroyed
          }
        }, 300);
      }
    };
  }, [pdfUrl, docVersion]);

  return (
    <aside className="left-panel">
      <div className="sidebar-header">
        <AeroLogo compact />
        <div className="panel-top-label" title={filename}>
          PAGES
        </div>
      </div>
      <div className="thumb-list">
        {pages.map((page) => {
          const isActive = page.number === activePage;
          return (
            <button
              key={page.number}
              className={`thumb-item${isActive ? ' active' : ''}`}
              onClick={() => setActivePage(page.number)}
              title={`Page ${page.number}`}
            >
              <div className="thumb-sheet">
                <div className="thumb-preview">
                  {pdfDoc ? <ThumbnailCanvas page={page} pdfDoc={pdfDoc} /> : <div className="thumb-placeholder" />}
                </div>
              </div>
              <div className="thumb-caption">
                <span className="thumb-index">{page.number}</span>
              </div>
            </button>
          );
        })}
      </div>
    </aside>
  );
};
