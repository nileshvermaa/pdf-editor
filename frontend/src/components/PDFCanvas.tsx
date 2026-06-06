import React, { useEffect, useRef, useState } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import { createWorker } from 'tesseract.js';
import { Eye, Sparkles } from 'lucide-react';

// Initialize PDF.js Worker using standard CDN
pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.4.120/pdf.worker.min.js';

interface PDFPage {
  number: number;
  width: number;
  height: number;
  blocks: any[];
  images: any[];
}

interface SelectedBlock {
  pageNumber: number;
  bbox: number[];
  text: string;
  font: string;
  size: number;
  color: string;
}

interface PDFCanvasProps {
  page: PDFPage;
  pdfUrl: string;
  onSelectBlock: (block: SelectedBlock) => void;
  onOCRComplete: (pageNum: number, ocrBlocks: any[]) => void;
}

export const PDFCanvas: React.FC<PDFCanvasProps> = ({
  page,
  pdfUrl,
  onSelectBlock,
  onOCRComplete
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [scale] = useState(1.25); // Scale of PDF page
  const [rendering, setRendering] = useState(false);
  const [ocrRunning, setOcrRunning] = useState(false);
  const [ocrProgress, setOcrProgress] = useState(0);
  const [ocrStatus, setOcrStatus] = useState('');

  // Render PDF Page onto HTML5 canvas
  useEffect(() => {
    let renderTask: any = null;

    const renderPage = async () => {
      if (!canvasRef.current || rendering) return;

      try {
        setRendering(true);
        const canvas = canvasRef.current;
        const context = canvas.getContext('2d');
        if (!context) return;

        // Load document through PDF.js
        const loadingTask = pdfjsLib.getDocument(pdfUrl);
        const pdf = await loadingTask.promise;
        const pdfPage = await pdf.getPage(page.number);

        const viewport = pdfPage.getViewport({ scale });
        canvas.width = viewport.width;
        canvas.height = viewport.height;

        const renderContext = {
          canvasContext: context,
          viewport: viewport,
        };

        renderTask = pdfPage.render(renderContext);
        await renderTask.promise;
      } catch (err) {
        console.error('Error rendering PDF page:', err);
      } finally {
        setRendering(false);
      }
    };

    renderPage();

    return () => {
      if (renderTask) {
        renderTask.cancel();
      }
    };
  }, [pdfUrl, page.number, scale]);

  // Client-Side OCR scanner using Tesseract.js (Web Worker)
  const runLocalOCR = async () => {
    if (!canvasRef.current) return;
    try {
      setOcrRunning(true);
      setOcrStatus('Initializing OCR engine...');
      setOcrProgress(5);

      const canvas = canvasRef.current;
      const worker = await createWorker({
        logger: (m) => {
          if (m.status === 'recognizing text') {
            setOcrStatus('Extracting characters...');
            setOcrProgress(Math.round(m.progress * 100));
          }
        },
      });

      setOcrStatus('Loading English language parameters...');
      await worker.loadLanguage('eng');
      await worker.initialize('eng');

      setOcrStatus('Scanning document elements...');
      // Extract image data directly from canvas context
      const dataUrl = canvas.toDataURL('image/png');
      const { data } = await worker.recognize(dataUrl);

      // Map Tesseract paragraph bounding boxes back to PDF coordinate spaces
      const ocrBlocks: any[] = [];
      const canvasWidth = canvas.width;
      const canvasHeight = canvas.height;

      data.paragraphs.forEach((p) => {
        const { x0, y0, x1, y1 } = p.bbox;
        
        // Translate back from render canvas coordinate bounds to PDF points bounds
        const pdfX0 = (x0 / canvasWidth) * page.width;
        const pdfY0 = (y0 / canvasHeight) * page.height;
        const pdfX1 = (x1 / canvasWidth) * page.width;
        const pdfY1 = (y1 / canvasHeight) * page.height;

        ocrBlocks.push({
          bbox: [pdfX0, pdfY0, pdfX1, pdfY1],
          lines: [
            {
              bbox: [pdfX0, pdfY0, pdfX1, pdfY1],
              spans: [
                {
                  text: p.text.trim(),
                  bbox: [pdfX0, pdfY0, pdfX1, pdfY1],
                  font: 'Helvetica',
                  size: 12,
                  color: '#000000'
                }
              ]
            }
          ]
        });
      });

      await worker.terminate();
      setOcrRunning(false);
      onOCRComplete(page.number, ocrBlocks);
    } catch (err) {
      console.error('OCR Error:', err);
      setOcrStatus('OCR Failed.');
      setOcrRunning(false);
    }
  };

  // Check if this is a scanned document (has images but zero text blocks)
  const isScanned = page.blocks.length === 0 && page.images.length > 0;

  return (
    <div
      ref={containerRef}
      className="pdf-page-container fade-in"
      style={{
        width: page.width * scale,
        height: page.height * scale,
      }}
    >
      {/* Dynamic OCR Loading overlay */}
      {ocrRunning && (
        <div className="ocr-progress-overlay">
          <Sparkles className="dropzone-icon" style={{ width: '40px', height: '40px' }} />
          <span style={{ fontSize: '1rem', fontWeight: 600 }}>{ocrStatus}</span>
          <div className="progress-bar-container">
            <div className="progress-bar-fill" style={{ width: `${ocrProgress}%` }}></div>
          </div>
          <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>{ocrProgress}% complete</span>
        </div>
      )}

      {/* Render Canvas */}
      <canvas ref={canvasRef} className="pdf-canvas" />

      {/* Overlay Transparent WYSIWYG Editable Layer */}
      <div className="editing-overlay-layer">
        {page.blocks.map((block, bIdx) => {
          return block.lines.map((line: any, lIdx: any) => {
            return line.spans.map((span: any, sIdx: any) => {
              const [x0, y0, x1, y1] = span.bbox;
              
              // Scale coordinates dynamically for screen layout
              const left = x0 * scale;
              const top = y0 * scale;
              const width = (x1 - x0) * scale;
              const height = (y1 - y0) * scale;
              
              // Estimate standard CSS font size based on scale
              const cssFontSize = span.size * scale;
              
              return (
                <div
                  key={`span-${bIdx}-${lIdx}-${sIdx}`}
                  className="editable-text-block"
                  style={{
                    left: `${left}px`,
                    top: `${top}px`,
                    width: `${width + 4}px`,
                    height: `${height + 2}px`,
                    fontSize: `${cssFontSize}px`,
                    color: 'transparent', // Make text transparent so it hides the underlying Canvas pixels
                    fontFamily: span.font.includes('Courier') ? 'Courier New' : span.font.includes('Times') ? 'Times New Roman' : 'Arial'
                  }}
                  title="Double click to edit font or content"
                  onDoubleClick={(e) => {
                    e.stopPropagation();
                    onSelectBlock({
                      pageNumber: page.number,
                      bbox: span.bbox,
                      text: span.text,
                      font: span.font,
                      size: span.size,
                      color: span.color
                    });
                  }}
                >
                  {span.text}
                </div>
              );
            });
          });
        })}

        {/* Scan Helper box if page is scanned */}
        {isScanned && (
          <div
            className="scanned-img-highlight"
            style={{
              left: '5%',
              top: '5%',
              width: '90%',
              height: '90%',
            }}
            onClick={runLocalOCR}
          >
            <div className="ocr-prompt-badge">
              Scanned Page Detected - Click to Run OCR
            </div>
            <div style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              height: '100%',
              gap: '12px',
              color: 'var(--warning)',
              opacity: 0.8
            }}>
              <Eye size={36} />
              <span style={{ fontSize: '1rem', fontWeight: 600 }}>Convert image elements to editable text layers</span>
              <button className="btn btn-primary" style={{ background: 'var(--warning)', color: '#000', fontWeight: 600 }}>
                Run OCR Text Extraction
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
