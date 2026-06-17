import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createWorker } from 'tesseract.js';
import type { EditorObject, OCRBlockPayload, PDFPage, ShapeObjectType, UpdateObjectPayload } from '../api';
import { getPdfDocument } from '../pdfCache';

/** Shift (and if necessary shrink) a rect so it lies fully inside the page. */
const clampRectToPage = (
  bbox: [number, number, number, number],
  pageWidth: number,
  pageHeight: number
): [number, number, number, number] => {
  let [x0, y0, x1, y1] = bbox;
  const w = Math.min(x1 - x0, pageWidth);
  const h = Math.min(y1 - y0, pageHeight);
  x0 = Math.min(Math.max(0, x0), pageWidth - w);
  y0 = Math.min(Math.max(0, y0), pageHeight - h);
  return [x0, y0, x0 + w, y0 + h];
};

/** Clamp a drag translation so the moved bbox stays on the page. */
const clampDelta = (
  origin: [number, number, number, number],
  dx: number,
  dy: number,
  pageWidth: number,
  pageHeight: number
): { dx: number; dy: number } => {
  // Lines keep direction in their bbox, so use min/max of each pair.
  const loX = Math.min(origin[0], origin[2]);
  const hiX = Math.max(origin[0], origin[2]);
  const loY = Math.min(origin[1], origin[3]);
  const hiY = Math.max(origin[1], origin[3]);
  return {
    dx: Math.min(Math.max(dx, -loX), Math.max(-loX, pageWidth - hiX)),
    dy: Math.min(Math.max(dy, -loY), Math.max(-loY, pageHeight - hiY)),
  };
};

type ToolKey = 'cursor' | 'text' | 'image' | 'draw' | 'signature' | 'comment';

interface SelectedBlock {
  pageNumber: number;
  bbox: number[];
  text: string;
  font: string;
  size: number;
  color: string;
  flags?: number;
}

interface PDFCanvasProps {
  page: PDFPage;
  pdfUrl: string;
  docVersion: number;
  /** Zoom factor: CSS px per PDF point (1.25 = 125%). */
  scale: number;
  onSelectBlock: (block: SelectedBlock | null) => void;
  onOCRComplete: (pageNum: number, ocrBlocks: OCRBlockPayload[]) => Promise<void> | void;
  selectedBlock: SelectedBlock | null;
  selectedObjectId: string | null;
  onSelectObject: (objectId: string | null) => void;
  activeTool: ToolKey;
  activeShape?: ShapeObjectType | null;
  onDrawShape?: (bbox: number[]) => void;
  onCreateObject: (tool: 'text' | 'comment' | 'signature', bbox: [number, number, number, number]) => Promise<void> | void;
  onUpdateObject: (objectId: string, changes: UpdateObjectPayload) => void;
  assetUrlFor: (assetId: string) => string;
}

interface Point {
  x: number;
  y: number;
}

interface DragState {
  id: string;
  start: Point;
  origin: [number, number, number, number];
  delta: Point;
}

export const PDFCanvas: React.FC<PDFCanvasProps> = ({
  page,
  pdfUrl,
  docVersion,
  scale,
  onSelectBlock,
  onOCRComplete,
  selectedBlock,
  selectedObjectId,
  onSelectObject,
  activeTool,
  activeShape,
  onDrawShape,
  onCreateObject,
  onUpdateObject,
  assetUrlFor,
}) => {
  // Alias so every coordinate conversion below reads naturally.
  const SCALE = scale;
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const layerRef = useRef<HTMLDivElement | null>(null);
  // True once any frame has been painted: re-renders (zoom, page switch,
  // edits) keep showing the previous frame instead of a blocking overlay.
  const hasFrameRef = useRef(false);
  // The in-flight pdf.js render task. A new render must wait for the previous
  // one to finish cancelling — starting two renders on one canvas makes
  // pdf.js throw "Cannot use the same canvas during multiple render
  // operations" and the page wedges on a stale frame.
  const renderTaskRef = useRef<any>(null);
  const [rendering, setRendering] = useState(false);
  const [ocrRunning, setOcrRunning] = useState(false);
  const [ocrProgress, setOcrProgress] = useState(0);
  const [ocrStatus, setOcrStatus] = useState('');
  const [isDrawing, setIsDrawing] = useState(false);
  const [startPoint, setStartPoint] = useState<Point | null>(null);
  const [currentPoint, setCurrentPoint] = useState<Point | null>(null);
  const [dragState, setDragState] = useState<DragState | null>(null);

  const objects = useMemo(() => [...(page.objects || [])].sort((a, b) => (a.z_index ?? 0) - (b.z_index ?? 0)), [page.objects]);

  useEffect(() => {
    let cancelled = false;
    let pdfDoc: any = null;

    const renderPage = async () => {
      if (!canvasRef.current) return;
      setRendering(true);
      try {
        const canvas = canvasRef.current;
        const ctx = canvas.getContext('2d');
        if (!ctx || cancelled) return;

        // Serialise canvas access: cancel any in-flight render and wait for
        // it to settle before drawing again. The wait is raced against a
        // short timeout because a task cancelled before its first paint tick
        // may never settle its promise (pdf.js quirk) — without the race the
        // canvas wedges on the overlay forever.
        const previousTask = renderTaskRef.current;
        if (previousTask) {
          renderTaskRef.current = null;
          previousTask.cancel();
          await Promise.race([
            previousTask.promise.catch(() => {}),
            new Promise((resolve) => setTimeout(resolve, 150)),
          ]);
        }
        if (cancelled) return;

        // Each run parses its own document from cached bytes (see pdfCache):
        // documents are never shared across components, so a cancel here can
        // never wedge another component's render.
        pdfDoc = await getPdfDocument(pdfUrl, docVersion);
        if (cancelled) return;

        const pdfPage = await pdfDoc.getPage(page.number);
        if (cancelled) return;

        const viewport = pdfPage.getViewport({ scale: SCALE });
        canvas.width = viewport.width;
        canvas.height = viewport.height;

        const renderTask = pdfPage.render({ canvasContext: ctx, viewport });
        renderTaskRef.current = renderTask;
        await renderTask.promise;
        hasFrameRef.current = true;
      } catch (err: any) {
        if (err?.name !== 'RenderingCancelledException') {
          console.error('PDF render error:', err);
        }
      } finally {
        if (!cancelled) setRendering(false);
      }
    };

    renderPage();
    return () => {
      cancelled = true;
      renderTaskRef.current?.cancel();
      // Free this run's private document (worker memory) once the cancelled
      // task has had a moment to flush.
      const doc = pdfDoc;
      if (doc) {
        setTimeout(() => {
          try {
            doc.destroy();
          } catch {
            // already destroyed
          }
        }, 300);
      }
    };
  }, [pdfUrl, page.number, docVersion, scale]);

  useEffect(() => {
    if (!dragState) return;

    const handlePointerMove = (event: PointerEvent) => {
      setDragState((current) =>
        current
          ? {
              ...current,
              delta: {
                x: event.clientX - current.start.x,
                y: event.clientY - current.start.y,
              },
            }
          : null
      );
    };

    const handlePointerUp = () => {
      // Read the latest drag state from the effect closure (the effect
      // re-subscribes on every delta change). Side effects like
      // onUpdateObject must NOT run inside a setState updater — React
      // warns "cannot update App while rendering PDFCanvas".
      const current = dragState;
      setDragState(null);
      if (!current) return;
      const { dx, dy } = clampDelta(
        current.origin,
        current.delta.x / SCALE,
        current.delta.y / SCALE,
        page.width,
        page.height
      );
      if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) {
        const [x0, y0, x1, y1] = current.origin;
        onUpdateObject(current.id, {
          bbox: [x0 + dx, y0 + dy, x1 + dx, y1 + dy],
        });
      }
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
    };
  }, [dragState, onUpdateObject, page.width, page.height, scale]);

  const isScanned = page.blocks.length === 0 && page.images.length > 0;

  const isSelectedSpan = (bbox: number[]) => {
    if (!selectedBlock || selectedBlock.pageNumber !== page.number) return false;
    const eps = 0.01;
    return bbox.length === 4 && selectedBlock.bbox.every((v, i) => Math.abs(v - bbox[i]) < eps);
  };

  const getPointerPoint = (event: React.PointerEvent<HTMLElement>): Point => {
    const rect = event.currentTarget.getBoundingClientRect();
    // Clamp into the page so pointer-captured draws can't leave the canvas.
    return {
      x: Math.min(Math.max(0, event.clientX - rect.left), page.width * SCALE),
      y: Math.min(Math.max(0, event.clientY - rect.top), page.height * SCALE),
    };
  };

  const beginShapeDraw = (event: React.PointerEvent<HTMLDivElement>) => {
    // Capture so pointerup still reaches us when released outside the page —
    // otherwise the preview rectangle is stranded mid-draw. Guarded because
    // capture can throw (NotFoundError) if the pointer is already gone, e.g.
    // a pen lifted between events.
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // capture is an enhancement, not a requirement
    }
    const point = getPointerPoint(event);
    setIsDrawing(true);
    setStartPoint(point);
    setCurrentPoint(point);
  };

  const continueShapeDraw = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!isDrawing || !startPoint) return;
    setCurrentPoint(getPointerPoint(event));
  };

  const finishShapeDraw = () => {
    if (!isDrawing || !startPoint || !currentPoint || !onDrawShape) return;
    setIsDrawing(false);

    let bbox: [number, number, number, number] = [
      Math.min(startPoint.x, currentPoint.x) / SCALE,
      Math.min(startPoint.y, currentPoint.y) / SCALE,
      Math.max(startPoint.x, currentPoint.x) / SCALE,
      Math.max(startPoint.y, currentPoint.y) / SCALE,
    ];
    if (activeShape === 'line' || activeShape === 'arrow') {
      bbox = [startPoint.x / SCALE, startPoint.y / SCALE, currentPoint.x / SCALE, currentPoint.y / SCALE];
    }

    if (Math.abs(currentPoint.x - startPoint.x) > 5 || Math.abs(currentPoint.y - startPoint.y) > 5) {
      onDrawShape(bbox);
    }

    setStartPoint(null);
    setCurrentPoint(null);
  };

  const handleLayerPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;

    if (activeTool === 'draw' && activeShape) {
      beginShapeDraw(event);
      return;
    }

    if (activeTool === 'text' || activeTool === 'comment' || activeTool === 'signature') {
      const point = getPointerPoint(event);
      const baseHeight = activeTool === 'comment' ? 88 : 48;
      const baseWidth = activeTool === 'comment' ? 190 : 220;
      // Clamp so clicks near the right/bottom edge don't produce a bbox the
      // backend rejects as out of bounds.
      onCreateObject(
        activeTool,
        clampRectToPage(
          [
            point.x / SCALE,
            point.y / SCALE,
            (point.x + baseWidth) / SCALE,
            (point.y + baseHeight) / SCALE,
          ],
          page.width,
          page.height
        )
      );
      return;
    }

    onSelectObject(null);
    onSelectBlock(null);
  };

  const handleLayerPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (activeTool === 'draw' && activeShape) {
      continueShapeDraw(event);
    }
  };

  const handleLayerPointerUp = () => {
    if (activeTool === 'draw' && activeShape) {
      finishShapeDraw();
    }
  };

  const handleObjectPointerDown = (event: React.PointerEvent<HTMLDivElement>, object: EditorObject) => {
    event.stopPropagation();
    onSelectObject(object.id);
    if (activeTool !== 'cursor' || object.locked) return;
    setDragState({
      id: object.id,
      start: { x: event.clientX, y: event.clientY },
      origin: [...object.bbox] as [number, number, number, number],
      delta: { x: 0, y: 0 },
    });
  };

  const getRenderBBox = (object: EditorObject): [number, number, number, number] => {
    if (dragState?.id !== object.id) return object.bbox;
    const { dx, dy } = clampDelta(
      object.bbox,
      dragState.delta.x / SCALE,
      dragState.delta.y / SCALE,
      page.width,
      page.height
    );
    return [
      object.bbox[0] + dx,
      object.bbox[1] + dy,
      object.bbox[2] + dx,
      object.bbox[3] + dy,
    ];
  };

  const renderObject = (object: EditorObject) => {
    const bbox = getRenderBBox(object);
    const [x0, y0, x1, y1] = bbox;
    // Lines/arrows store direction in the bbox (start -> end), so the CSS box
    // must be the normalised envelope and the SVG endpoints carry direction.
    const left = Math.min(x0, x1);
    const top = Math.min(y0, y1);
    const boxW = Math.max(Math.abs(x1 - x0) * SCALE, 2);
    const boxH = Math.max(Math.abs(y1 - y0) * SCALE, 2);
    const style: React.CSSProperties = {
      left: left * SCALE,
      top: top * SCALE,
      width: boxW,
      height: boxH,
      zIndex: (object.z_index ?? 0) + 10,
      opacity: object.opacity ?? 1,
    };
    const selected = selectedObjectId === object.id;

    if (object.type === 'image') {
      return (
        <div
          key={object.id}
          className={`canvas-object image-object${selected ? ' selected' : ''}`}
          style={style}
          onPointerDown={(event) => handleObjectPointerDown(event, object)}
        >
          <img src={assetUrlFor(object.asset_id)} alt="" draggable={false} />
          {selected && Array.from({ length: 8 }).map((_, idx) => <span key={idx} className={`selection-handle p-${idx + 1}`} />)}
        </div>
      );
    }

    if (object.type === 'shape') {
      if (object.shape_type === 'line' || object.shape_type === 'arrow') {
        // Endpoints relative to the envelope, preserving draw direction.
        const sx = (x0 - left) * SCALE;
        const sy = (y0 - top) * SCALE;
        const ex = (x1 - left) * SCALE;
        const ey = (y1 - top) * SCALE;
        return (
          <div
            key={object.id}
            className={`canvas-object line-object${selected ? ' selected' : ''}`}
            style={style}
            onPointerDown={(event) => handleObjectPointerDown(event, object)}
          >
            <svg className="line-object-svg" viewBox={`0 0 ${boxW} ${boxH}`}>
              <defs>
                <marker id={`arrow-${object.id}`} viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto">
                  <path d="M 0 0 L 10 5 L 0 10 z" fill={object.stroke_color || '#000000'} />
                </marker>
              </defs>
              <line
                x1={sx}
                y1={sy}
                x2={ex}
                y2={ey}
                stroke={object.stroke_color || '#000000'}
                strokeWidth={(object.line_width || 2) * SCALE}
                markerEnd={object.shape_type === 'arrow' ? `url(#arrow-${object.id})` : undefined}
              />
            </svg>
            {selected && Array.from({ length: 8 }).map((_, idx) => <span key={idx} className={`selection-handle p-${idx + 1}`} />)}
          </div>
        );
      }

      return (
        <div
          key={object.id}
          className={`canvas-object shape-object ${object.shape_type}${selected ? ' selected' : ''}`}
          style={{
            ...style,
            borderColor: object.stroke_color || '#000000',
            borderWidth: (object.line_width || 2) * SCALE,
            background: object.fill_color || 'transparent',
          }}
          onPointerDown={(event) => handleObjectPointerDown(event, object)}
        >
          {selected && Array.from({ length: 8 }).map((_, idx) => <span key={idx} className={`selection-handle p-${idx + 1}`} />)}
        </div>
      );
    }

    // Font size is in PDF points; multiply by SCALE so on-screen text matches
    // the flattened/export output (the page itself renders at SCALE).
    const textStyle: React.CSSProperties = {
      ...style,
      color: object.color || '#000000',
      fontSize: `${(object.font_size || (object.type === 'signature' ? 20 : 14)) * SCALE}px`,
      fontFamily: object.type === 'signature' ? `"Times New Roman", serif` : object.font_family || 'Inter',
      fontStyle: object.type === 'signature' ? 'italic' : object.font_style || 'normal',
      fontWeight: object.font_weight?.toLowerCase() === 'bold' ? 600 : 400,
      justifyContent:
        object.align === 'center' ? 'center' :
        object.align === 'right' ? 'flex-end' :
        'flex-start',
      textAlign: object.align || 'left',
      background: object.type === 'comment' ? object.fill_color || '#fff6bf' : 'transparent',
      borderColor: object.type === 'comment' ? object.stroke_color || '#d7b200' : 'transparent',
      borderWidth: object.type === 'comment' ? (object.line_width || 1.5) * SCALE : 1,
    };

    return (
      <div
        key={object.id}
        className={`canvas-object textlike-object ${object.type}${selected ? ' selected' : ''}`}
        style={textStyle}
        onPointerDown={(event) => handleObjectPointerDown(event, object)}
      >
        <span>{object.text}</span>
        {selected && Array.from({ length: 8 }).map((_, idx) => <span key={idx} className={`selection-handle p-${idx + 1}`} />)}
      </div>
    );
  };

  const runLocalOCR = async () => {
    if (!canvasRef.current || ocrRunning) return;
    let worker: any = null;
    try {
      setOcrRunning(true);
      setOcrProgress(5);
      setOcrStatus('Starting OCR engine...');

      const canvas = canvasRef.current;
      worker = await createWorker({
        logger: (m: any) => {
          if (m.status === 'recognizing text') {
            setOcrStatus('Reading characters...');
            setOcrProgress(Math.round(m.progress * 100));
          }
        },
      });

      setOcrStatus('Loading English language data...');
      await worker.loadLanguage('eng');
      await worker.initialize('eng');

      setOcrStatus('Scanning page...');
      const dataUrl = canvas.toDataURL('image/png');
      const { data } = await worker.recognize(dataUrl);

      const cw = canvas.width;
      const ch = canvas.height;
      const ocrBlocks: OCRBlockPayload[] = data.paragraphs
        .filter((p: any) => p.text.trim().length > 0)
        .map((p: any) => {
          const { x0, y0, x1, y1 } = p.bbox;
          return {
            text: p.text.trim(),
            bbox: [(x0 / cw) * page.width, (y0 / ch) * page.height, (x1 / cw) * page.width, (y1 / ch) * page.height],
            font_name: 'Helvetica',
            font_size: 12,
            hex_color: '#000000',
            auto_shrink: true,
          };
        });
      if (!ocrBlocks.length) {
        setOcrStatus('No text detected on this page.');
        return;
      }
      setOcrProgress(100);
      setOcrStatus('Saving OCR text...');
      await onOCRComplete(page.number, ocrBlocks);
    } catch (err) {
      console.error('OCR error:', err);
      setOcrStatus('OCR failed. Please try again.');
    } finally {
      try {
        await worker?.terminate();
      } catch {
        // no-op
      }
      setOcrRunning(false);
    }
  };

  return (
    <div className="pdf-page-container" style={{ width: page.width * SCALE, height: page.height * SCALE }}>
      {rendering && !hasFrameRef.current && (
        <div className="rendering-overlay">
          <span className="rendering-label">Rendering page {page.number}...</span>
        </div>
      )}

      {ocrRunning && (
        <div className="ocr-progress-overlay">
          <span className="ocr-status-label">{ocrStatus}</span>
          <div className="progress-bar-container">
            <div className="progress-bar-fill" style={{ width: `${ocrProgress}%` }} />
          </div>
          <span className="ocr-percent-label">{ocrProgress}% complete</span>
        </div>
      )}

      <canvas ref={canvasRef} className="pdf-canvas" />

      <div
        ref={layerRef}
        className={`editing-overlay-layer${activeTool === 'draw' ? ' drawing-mode' : ''}`}
        onPointerDown={handleLayerPointerDown}
        onPointerMove={handleLayerPointerMove}
        onPointerUp={handleLayerPointerUp}
      >
        <div className="object-overlay-layer">
          {objects.map((object) => renderObject(object))}
        </div>

        {isDrawing && startPoint && currentPoint && (
          <div
            className={`draw-preview${activeShape === 'line' || activeShape === 'arrow' ? ' line-preview' : ''}`}
            style={{
              left: Math.min(startPoint.x, currentPoint.x),
              top: Math.min(startPoint.y, currentPoint.y),
              width: Math.abs(currentPoint.x - startPoint.x),
              height: Math.abs(currentPoint.y - startPoint.y),
            }}
          >
            {(activeShape === 'line' || activeShape === 'arrow') && (
              <svg className="draw-preview-svg">
                <defs>
                  <marker id="shape-arrow-preview" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto">
                    <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--accent-blue)" />
                  </marker>
                </defs>
                <line
                  x1={startPoint.x < currentPoint.x ? 0 : Math.abs(currentPoint.x - startPoint.x)}
                  y1={startPoint.y < currentPoint.y ? 0 : Math.abs(currentPoint.y - startPoint.y)}
                  x2={startPoint.x < currentPoint.x ? Math.abs(currentPoint.x - startPoint.x) : 0}
                  y2={startPoint.y < currentPoint.y ? Math.abs(currentPoint.y - startPoint.y) : 0}
                  stroke="var(--accent-blue)"
                  strokeWidth={1.5}
                  markerEnd={activeShape === 'arrow' ? 'url(#shape-arrow-preview)' : undefined}
                />
              </svg>
            )}
          </div>
        )}

        {page.blocks.map((block, bIdx) =>
          block.lines.map((line: any, lIdx: number) =>
            line.spans.map((span: any, sIdx: number) => {
              const [x0, y0, x1, y1] = span.bbox;
              const fontFamily =
                span.font?.includes('Courier') ? 'Courier New' : span.font?.includes('Times') ? 'Times New Roman' : 'Arial';

              return (
                <div
                  key={`${bIdx}-${lIdx}-${sIdx}`}
                  className={`editable-text-block${isSelectedSpan(span.bbox) ? ' selected' : ''}`}
                  title={activeTool === 'draw' ? '' : 'Double-click to edit'}
                  style={{
                    left: `${x0 * SCALE}px`,
                    top: `${y0 * SCALE}px`,
                    width: `${(x1 - x0) * SCALE + 4}px`,
                    height: `${(y1 - y0) * SCALE + 2}px`,
                    fontSize: `${span.size * SCALE}px`,
                    fontFamily,
                    color: 'transparent',
                    pointerEvents: activeTool === 'draw' ? 'none' : 'auto',
                  }}
                  onDoubleClick={(e) => {
                    if (activeTool === 'draw') return;
                    e.stopPropagation();
                    onSelectObject(null);
                    onSelectBlock({
                      pageNumber: page.number,
                      bbox: span.bbox,
                      text: span.text,
                      font: span.font,
                      size: span.size,
                      color: span.color,
                      flags: span.flags,
                    });
                  }}
                >
                  {span.text}
                  {isSelectedSpan(span.bbox) && Array.from({ length: 8 }).map((_, idx) => <span key={idx} className={`selection-handle p-${idx + 1}`} />)}
                </div>
              );
            })
          )
        )}

        {isScanned && !ocrRunning && (
          <div
            className="scanned-img-highlight"
            style={{ left: '8%', top: '10%', width: '84%', height: '80%' }}
            onClick={runLocalOCR}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => e.key === 'Enter' && runLocalOCR()}
          >
            <div className="ocr-prompt-badge">Scanned page detected</div>
            <div className="ocr-empty-state">
              <span className="ocr-empty-label">Click to extract text with OCR</span>
              <button className="ocr-action-btn" style={{ pointerEvents: 'none' }}>
                Run OCR
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
