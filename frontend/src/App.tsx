import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Download,
  FolderOpen,
  Image,
  MessageSquare,
  Minus,
  MousePointer2,
  PenLine,
  Plus,
  Redo2,
  Shapes,
  Type,
  Undo2,
  X,
} from 'lucide-react';
import { Sidebar } from './components/Sidebar';
import { PDFCanvas } from './components/PDFCanvas';
import { PropertiesPanel } from './components/PropertiesPanel';
import { ImageInsertModal } from './components/ImageInsertModal';
import { PromptModal } from './components/PromptModal';
import { AeroLogo } from './components/AeroLogo';
import {
  api,
  EditResponse,
  EditorObject,
  HistoryState,
  OCRBlockPayload,
  PDFPage,
  ShapeObjectType,
  UpdateObjectPayload,
} from './api';

type ToolKey = 'cursor' | 'text' | 'image' | 'draw' | 'signature' | 'comment';

interface Session {
  session_id: string;
  filename: string;
  metadata: { title: string; author: string; pages: number };
  pages: PDFPage[];
}

interface SelectedBlock {
  pageNumber: number;
  bbox: number[];
  text: string;
  font: string;
  size: number;
  color: string;
  flags?: number;
}

interface Toast {
  text: string;
  type: 'success' | 'error' | 'info' | null;
}

const MOCK_PAGES: PDFPage[] = [1, 2, 3, 4].map((n) => ({
  number: n,
  width: 595,
  height: 842,
  blocks: [],
  images: [],
  objects: [],
}));

const ZOOM_LEVELS = [0.5, 0.625, 0.75, 0.875, 1, 1.25, 1.5, 1.75, 2, 2.5];
const DEFAULT_ZOOM = 1.25;

/** Parse a page-range string like "1-3,5" into sorted, in-bounds page numbers. */
function parsePageRange(spec: string, total: number): number[] {
  const out = new Set<number>();
  for (const part of spec.split(',')) {
    const p = part.trim();
    if (!p) continue;
    if (p.includes('-')) {
      const [a, b] = p.split('-').map((s) => parseInt(s.trim(), 10));
      if (Number.isFinite(a) && Number.isFinite(b)) {
        for (let n = Math.min(a, b); n <= Math.max(a, b); n++) out.add(n);
      }
    } else {
      const n = parseInt(p, 10);
      if (Number.isFinite(n)) out.add(n);
    }
  }
  return [...out].filter((n) => n >= 1 && n <= total).sort((x, y) => x - y);
}

/** Shift a bbox by (dx,dy) PDF points, clamping its envelope to the page. */
function shiftBBoxClamped(
  b: [number, number, number, number],
  dx: number,
  dy: number,
  pw: number,
  ph: number
): [number, number, number, number] {
  const minX = Math.min(b[0], b[2]);
  const maxX = Math.max(b[0], b[2]);
  const minY = Math.min(b[1], b[3]);
  const maxY = Math.max(b[1], b[3]);
  const cdx = Math.min(Math.max(dx, -minX), pw - maxX);
  const cdy = Math.min(Math.max(dy, -minY), ph - maxY);
  return [b[0] + cdx, b[1] + cdy, b[2] + cdx, b[3] + cdy];
}

const TOOL_LIST: Array<{ key: ToolKey; icon: React.ReactNode; label: string }> = [
  { key: 'cursor', icon: <MousePointer2 size={18} strokeWidth={1.75} />, label: 'Cursor (V)' },
  { key: 'text', icon: <Type size={18} strokeWidth={1.75} />, label: 'Text Tool (T)' },
  { key: 'image', icon: <Image size={18} strokeWidth={1.75} />, label: 'Image Tool' },
  { key: 'draw', icon: <Shapes size={18} strokeWidth={1.75} />, label: 'Shapes (rect, circle, line, arrow)' },
  { key: 'signature', icon: <PenLine size={18} strokeWidth={1.75} />, label: 'Signature' },
  { key: 'comment', icon: <MessageSquare size={18} strokeWidth={1.75} />, label: 'Comment' },
];

function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [history, setHistory] = useState<HistoryState | null>(null);
  const [activePage, setActivePage] = useState<number>(1);
  const [selectedBlock, setSelectedBlock] = useState<SelectedBlock | null>(null);
  const [selectedObjectId, setSelectedObjectId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [toast, setToast] = useState<Toast>({ text: '', type: null });
  // Default to the cursor (like Figma) — a 'text' default makes every stray
  // click on the page silently create a text object.
  const [activeTool, setActiveTool] = useState<ToolKey>('cursor');
  const [showImageModal, setShowImageModal] = useState(false);
  const [docModal, setDocModal] = useState<'watermark' | 'extract' | null>(null);
  const [activeShape, setActiveShape] = useState<ShapeObjectType>('rect');
  const [strokeColor, setStrokeColor] = useState('#000000');
  const [fillColor, setFillColor] = useState('#ffffff');
  const [lineWidth, setLineWidth] = useState(2);
  const [isDragging, setIsDragging] = useState(false);
  const [zoom, setZoom] = useState(DEFAULT_ZOOM);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const mergeInputRef = useRef<HTMLInputElement | null>(null);
  const stageRef = useRef<HTMLElement | null>(null);
  // Accumulates arrow-key nudges so the whole gesture commits as ONE history
  // entry (debounced), instead of one version per keypress.
  const nudgeRef = useRef<{ id: string; bbox: [number, number, number, number]; timer: number } | null>(null);

  const zoomIn = useCallback(() => setZoom((z) => ZOOM_LEVELS.find((l) => l > z + 1e-3) ?? z), []);
  const zoomOut = useCallback(() => setZoom((z) => [...ZOOM_LEVELS].reverse().find((l) => l < z - 1e-3) ?? z), []);
  const resetZoom = useCallback(() => setZoom(DEFAULT_ZOOM), []);

  // Ctrl+scroll zooms the canvas instead of the browser. Native listener
  // because React registers wheel handlers passively (preventDefault no-ops).
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      if (e.deltaY < 0) zoomIn();
      else zoomOut();
    };
    stage.addEventListener('wheel', onWheel, { passive: false });
    return () => stage.removeEventListener('wheel', onWheel);
  }, [zoomIn, zoomOut]);

  const showToast = useCallback((text: string, type: Toast['type']) => {
    setToast({ text, type });
    setTimeout(() => setToast({ text: '', type: null }), 3500);
  }, []);

  const displayPages = session?.pages ?? MOCK_PAGES;
  const displayedFilename = session?.filename || 'annual_report_draft.pdf';
  const sid = session?.session_id;
  const activePageData = displayPages[Math.max(0, activePage - 1)];

  const selectedObject = useMemo<EditorObject | null>(() => {
    if (!session || !selectedObjectId) return null;
    for (const page of session.pages) {
      const found = page.objects?.find((obj) => obj.id === selectedObjectId);
      if (found) return found;
    }
    return null;
  }, [session, selectedObjectId]);

  useEffect(() => {
    const maxPage = displayPages.length;
    setActivePage((current) => Math.min(Math.max(1, current), maxPage));
  }, [displayPages.length]);

  const syncEdit = useCallback(
    (
      data: EditResponse,
      options?: {
        keepObjectSelection?: boolean;
        selectObjectId?: string | null;
        clearBlock?: boolean;
      }
    ) => {
      setSession((prev) => (prev ? { ...prev, pages: data.pages, metadata: data.metadata } : prev));
      setHistory(data.history);
      setActivePage((p) => Math.min(Math.max(1, p), data.metadata.pages));
      if (options?.clearBlock !== false) {
        setSelectedBlock(null);
      }
      setSelectedObjectId((current) => {
        if (options && 'selectObjectId' in options) {
          return options.selectObjectId ?? null;
        }
        if (options?.keepObjectSelection && current) {
          const exists = data.pages.some((page) => page.objects?.some((obj) => obj.id === current));
          return exists ? current : null;
        }
        return null;
      });
    },
    []
  );

  const applyEdit = useCallback(
    (
      data: EditResponse,
      fallbackMsg?: string,
      options?: { keepObjectSelection?: boolean; selectObjectId?: string | null; clearBlock?: boolean }
    ) => {
      syncEdit(data, options);
      if (data.warnings?.length) {
        showToast(data.warnings[0], 'info');
      } else {
        showToast(data.message || fallbackMsg || 'Done', 'success');
      }
    },
    [showToast, syncEdit]
  );

  const run = useCallback(
    async (
      fn: () => Promise<EditResponse>,
      fallbackMsg?: string,
      options?: { keepObjectSelection?: boolean; selectObjectId?: string | null; clearBlock?: boolean }
    ) => {
      if (!session) return;
      setIsLoading(true);
      try {
        const data = await fn();
        applyEdit(data, fallbackMsg, options);
      } catch (err: any) {
        showToast(err.message || 'Request failed', 'error');
      } finally {
        setIsLoading(false);
      }
    },
    [session, applyEdit, showToast]
  );

  const findTopObjectId = useCallback((pages: PDFPage[], pageNumber: number) => {
    const page = pages.find((item) => item.number === pageNumber);
    if (!page?.objects?.length) return null;
    const ordered = [...page.objects].sort((a, b) => (a.z_index ?? 0) - (b.z_index ?? 0));
    return ordered[ordered.length - 1]?.id ?? null;
  }, []);

  const handleFileUpload = async (file: File) => {
    if (!file.name.toLowerCase().endsWith('.pdf')) {
      showToast('Only PDF files are supported.', 'error');
      return;
    }
    setIsLoading(true);
    try {
      const data = await api.upload(file);
      setSession({
        session_id: data.session_id,
        filename: data.filename,
        metadata: data.metadata,
        pages: data.pages,
      });
      setHistory(data.history);
      setActivePage(1);
      setSelectedBlock(null);
      setSelectedObjectId(null);
      setActiveTool('cursor');
      setZoom(DEFAULT_ZOOM);
      showToast(`${data.filename} loaded`, 'success');
    } catch (err: any) {
      showToast(err.message || 'Upload failed', 'error');
    } finally {
      setIsLoading(false);
    }
  };

  const openFilePicker = () => fileInputRef.current?.click();

  const onFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files?.[0]) {
      handleFileUpload(e.target.files[0]);
      e.target.value = '';
    }
  };

  const onDragOver = useCallback((e: React.DragEvent) => {
    if (session) return;
    e.preventDefault();
    setIsDragging(true);
  }, [session]);

  const onDragLeave = useCallback((e: React.DragEvent) => {
    if (session) return;
    e.preventDefault();
    setIsDragging(false);
  }, [session]);

  const onDrop = useCallback((e: React.DragEvent) => {
    if (session) return;
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file) handleFileUpload(file);
  }, [session]);

  const handleSaveBlockEdits = (text: string, size: number, font: string, color: string, align: number) =>
    sid &&
    selectedBlock &&
    run(
      () =>
        api.editBlock(sid, {
          page_number: selectedBlock.pageNumber,
          original_bbox: selectedBlock.bbox,
          new_text: text,
          font_size: size,
          font_name: font,
          hex_color: color,
          align,
        }),
      'Text updated'
    );

  const handleUndo = () => sid && run(() => api.undo(sid), 'Undid change');
  const handleRedo = () => sid && run(() => api.redo(sid), 'Redid change');
  const handleRotate = (deg: number) => sid && run(() => api.rotate(sid, activePage, deg), 'Page rotated');
  const handleDuplicate = () => sid && run(() => api.duplicate(sid, activePage), 'Page duplicated');
  const handleInsertBlank = () => sid && run(() => api.insertBlank(sid, activePage), 'Blank page inserted');
  const handleReorderPages = (order: number[]) =>
    sid && run(() => api.reorderPages(sid, order), 'Pages reordered');
  const handleNumberPages = () =>
    sid && run(() => api.numberPages(sid, { position: 'bottom-center', fmt: '{n}' }), 'Page numbers added');
  const handleWatermark = (text: string) => {
    if (!sid) return;
    setDocModal(null);
    run(() => api.watermark(sid, { text }), 'Watermark applied');
  };
  const handleExtract = async (rangeStr: string) => {
    if (!sid || !session) return;
    const pages = parsePageRange(rangeStr, session.pages.length);
    if (!pages.length) {
      showToast('Enter a valid page range, e.g. 1-3,5', 'error');
      return;
    }
    setDocModal(null);
    setIsLoading(true);
    try {
      const blob = await api.extractPages(sid, pages);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'extracted.pdf';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      showToast(`Extracted ${pages.length} page(s)`, 'success');
    } catch (e: any) {
      showToast(e.message || 'Extract failed', 'error');
    } finally {
      setIsLoading(false);
    }
  };
  const handleMergePdf = async (file: File) => {
    if (!sid) return;
    if (!file.name.toLowerCase().endsWith('.pdf')) {
      showToast('Only PDF files can be inserted.', 'error');
      return;
    }
    // Insert the uploaded PDF's pages right after the current page.
    await run(() => api.mergePdf(sid, file, activePage), 'PDF inserted');
  };
  const handleDelete = () => {
    if (!sid) return;
    if (!window.confirm(`Delete page ${activePage}? This action can be undone.`)) return;
    run(() => api.deletePages(sid, [activePage]), 'Page deleted');
  };

  const handleExportPDF = () => {
    if (!sid) return;
    window.open(api.downloadUrl(sid), '_blank');
  };

  const handleFlatten = () => sid && run(() => api.flatten(sid), 'Objects flattened into the PDF');

  const handleOCRComplete = async (pageNum: number, ocrBlocks: OCRBlockPayload[]) => {
    if (!sid) return;
    if (!ocrBlocks.length) {
      showToast('No text detected on this page.', 'info');
      return;
    }
    setIsLoading(true);
    try {
      const data = await api.persistOcr(sid, { page_number: pageNum, blocks: ocrBlocks });
      applyEdit(data, `OCR text saved on page ${pageNum}`);
    } catch (err: any) {
      showToast(err.message || 'OCR save failed', 'error');
    } finally {
      setIsLoading(false);
    }
  };

  const handleInsertImage = async (file: File, x: number, y: number, w: number, h: number) => {
    if (!sid) return;
    setIsLoading(true);
    try {
      const data = await api.addImage(sid, file, x, y, w, h, activePage);
      const objectId = findTopObjectId(data.pages, activePage);
      applyEdit(data, 'Image inserted', { selectObjectId: objectId });
      setShowImageModal(false);
      setActiveTool('cursor');
    } catch (err: any) {
      showToast(err.message || 'Image insert failed', 'error');
    } finally {
      setIsLoading(false);
    }
  };

  const handleDrawShape = async (bbox: number[]) => {
    if (!sid || activeTool !== 'draw') return;
    setIsLoading(true);
    try {
      const data = await api.drawShape(sid, {
        page_number: activePage,
        shape_type: activeShape,
        bbox,
        stroke_color: strokeColor,
        fill_color: activeShape === 'line' || activeShape === 'arrow' ? undefined : fillColor,
        line_width: lineWidth,
      });
      const objectId = findTopObjectId(data.pages, activePage);
      applyEdit(data, 'Shape added', { selectObjectId: objectId });
      setActiveTool('cursor');
    } catch (err: any) {
      showToast(err.message || 'Shape draw failed', 'error');
    } finally {
      setIsLoading(false);
    }
  };

  // Duplicate the selected object as a new object offset slightly down-right.
  const handleDuplicateObject = async () => {
    if (!sid || !selectedObject) return;
    const o = selectedObject;
    const off = 14;
    const page = session?.pages.find((p) => p.number === o.page_number);
    const pw = page?.width ?? 9999;
    const ph = page?.height ?? 9999;
    // Offset both corners, then shift back so the copy stays fully on-page.
    let [x0, y0, x1, y1] = o.bbox;
    const shiftX = Math.min(off, pw - Math.max(x0, x1));
    const shiftY = Math.min(off, ph - Math.max(y0, y1));
    x0 += shiftX; x1 += shiftX; y0 += shiftY; y1 += shiftY;
    const bbox: [number, number, number, number] = [x0, y0, x1, y1];

    // Carry over every type-specific field the create endpoint accepts.
    const payload: any = {
      page_number: o.page_number,
      type: o.type,
      bbox,
      rotation: o.rotation,
      opacity: o.opacity,
    };
    if (o.type === 'shape') {
      Object.assign(payload, {
        shape_type: o.shape_type,
        stroke_color: o.stroke_color,
        fill_color: o.fill_color,
        line_width: o.line_width,
      });
    } else if (o.type === 'image') {
      payload.asset_id = o.asset_id;
    } else {
      Object.assign(payload, {
        text: o.text,
        font_family: o.font_family,
        font_size: o.font_size,
        font_weight: o.font_weight,
        font_style: o.font_style,
        color: o.color,
        align: o.align,
        stroke_color: o.stroke_color,
        fill_color: o.fill_color,
        line_width: o.line_width,
      });
    }

    setIsLoading(true);
    try {
      const data = await api.createObject(sid, payload);
      const objectId = findTopObjectId(data.pages, o.page_number);
      applyEdit(data, 'Duplicated object', { selectObjectId: objectId, clearBlock: true });
    } catch (err: any) {
      showToast(err.message || 'Duplicate failed', 'error');
    } finally {
      setIsLoading(false);
    }
  };

  // Arrow-key nudge: move the selected object optimistically on each press and
  // commit once after the user pauses (quiet — no per-press toast or version).
  const commitNudge = useCallback(() => {
    const n = nudgeRef.current;
    nudgeRef.current = null;
    if (!n || !sid) return;
    api
      .updateObject(sid, n.id, { bbox: n.bbox })
      .then((data) => syncEdit(data, { keepObjectSelection: true, selectObjectId: n.id, clearBlock: true }))
      .catch((err: any) => showToast(err.message || 'Move failed', 'error'));
  }, [sid, syncEdit, showToast]);

  const nudgeSelectedObject = useCallback(
    (dx: number, dy: number) => {
      if (!sid || !selectedObject) return;
      const page = session?.pages.find((p) => p.number === selectedObject.page_number);
      const pw = page?.width ?? 9999;
      const ph = page?.height ?? 9999;
      const base =
        nudgeRef.current?.id === selectedObject.id ? nudgeRef.current.bbox : (selectedObject.bbox as [number, number, number, number]);
      const next = shiftBBoxClamped(base, dx, dy, pw, ph);
      // Optimistic local move for instant feedback.
      setSession((prev) =>
        prev
          ? {
              ...prev,
              pages: prev.pages.map((pg) => ({
                ...pg,
                objects: pg.objects?.map((o) => (o.id === selectedObject.id ? { ...o, bbox: next } : o)),
              })),
            }
          : prev
      );
      if (nudgeRef.current?.timer) window.clearTimeout(nudgeRef.current.timer);
      const timer = window.setTimeout(commitNudge, 400);
      nudgeRef.current = { id: selectedObject.id, bbox: next, timer };
    },
    [sid, selectedObject, session, commitNudge]
  );

  const handleCreateObject = async (
    tool: Extract<ToolKey, 'text' | 'comment' | 'signature'>,
    bbox: [number, number, number, number]
  ) => {
    if (!sid) return;
    const payload =
      tool === 'text'
        ? {
            page_number: activePage,
            type: 'text' as const,
            bbox,
            text: 'Editable text',
            font_family: 'Inter',
            font_size: 16,
            color: '#000000',
          }
        : tool === 'comment'
          ? {
              page_number: activePage,
              type: 'comment' as const,
              bbox,
              text: 'Comment',
              font_family: 'Inter',
              font_size: 12,
              color: '#333333',
              stroke_color: '#d7b200',
              fill_color: '#fff6bf',
              line_width: 1.5,
            }
          : {
              page_number: activePage,
              type: 'signature' as const,
              bbox,
              text: 'Signature',
              font_family: 'Times',
              font_size: 20,
              color: '#0f4f8a',
            };

    setIsLoading(true);
    try {
      const data = await api.createObject(sid, payload);
      const objectId = findTopObjectId(data.pages, activePage);
      applyEdit(data, `Added ${tool}`, { selectObjectId: objectId, clearBlock: true });
      setActiveTool('cursor');
    } catch (err: any) {
      showToast(err.message || 'Object creation failed', 'error');
    } finally {
      setIsLoading(false);
    }
  };

  const handleUpdateObject = (objectId: string, changes: UpdateObjectPayload) => {
    if (!sid) return;
    return run(() => api.updateObject(sid, objectId, changes), 'Object updated', {
      keepObjectSelection: true,
      selectObjectId: objectId,
      clearBlock: true,
    });
  };

  const handleDeleteObject = () => {
    if (!sid || !selectedObjectId) return;
    return run(() => api.deleteObject(sid, selectedObjectId), 'Object deleted', { selectObjectId: null, clearBlock: true });
  };

  const handleReorderObject = (direction: 'forward' | 'backward') => {
    if (!sid || !selectedObject) return;
    const page = session?.pages.find((item) => item.number === selectedObject.page_number);
    if (!page?.objects?.length) return;
    const ordered = [...page.objects].sort((a, b) => (a.z_index ?? 0) - (b.z_index ?? 0));
    const index = ordered.findIndex((item) => item.id === selectedObject.id);
    const swapIndex = direction === 'forward' ? index + 1 : index - 1;
    if (index < 0 || swapIndex < 0 || swapIndex >= ordered.length) return;
    [ordered[index], ordered[swapIndex]] = [ordered[swapIndex], ordered[index]];
    run(() => api.reorderObjects(sid, ordered.map((item) => item.id)), 'Object order updated', {
      keepObjectSelection: true,
      clearBlock: true,
    });
  };

  const onToolSelect = (tool: ToolKey) => {
    setActiveTool(tool);
    if (tool === 'draw') {
      setActiveShape((prev) => prev || 'rect');
    }
    if (tool === 'image' && session) {
      setShowImageModal(true);
    }
  };

  const handleSelectBlock = (block: SelectedBlock | null) => {
    setSelectedBlock(block);
    setSelectedObjectId(null);
    if (block) {
      setActiveTool('text');
    }
  };

  const handleSelectObject = (objectId: string | null) => {
    setSelectedObjectId(objectId);
    if (objectId) {
      setSelectedBlock(null);
      setActiveTool('cursor');
    }
  };

  // Keyboard shortcuts (the toolbar tooltips advertise V / T):
  // V cursor · T text · Esc deselect · Del remove object · Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y history
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target?.isContentEditable) return;

      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();

      if (mod && key === 'z' && !e.shiftKey) {
        e.preventDefault();
        if (sid && history?.can_undo && !isLoading) handleUndo();
        return;
      }
      if (mod && (key === 'y' || (key === 'z' && e.shiftKey))) {
        e.preventDefault();
        if (sid && history?.can_redo && !isLoading) handleRedo();
        return;
      }
      if (mod && (key === '=' || key === '+')) {
        e.preventDefault();
        zoomIn();
        return;
      }
      if (mod && key === '-') {
        e.preventDefault();
        zoomOut();
        return;
      }
      if (mod && key === '0') {
        e.preventDefault();
        resetZoom();
        return;
      }
      if (mod && key === 'd') {
        e.preventDefault();
        if (sid && selectedObjectId && !isLoading) handleDuplicateObject();
        return;
      }
      if (mod) return; // don't hijack browser shortcuts like Ctrl+S

      if (key === 'escape') {
        setSelectedBlock(null);
        setSelectedObjectId(null);
        setActiveTool('cursor');
        return;
      }
      if ((key === 'delete' || key === 'backspace') && selectedObjectId && !isLoading) {
        e.preventDefault();
        handleDeleteObject();
        return;
      }
      // Arrow-key nudge of the selected object (Shift = 10pt step).
      if (selectedObjectId && !isLoading) {
        const step = e.shiftKey ? 10 : 1;
        const delta: Record<string, [number, number]> = {
          arrowleft: [-step, 0],
          arrowright: [step, 0],
          arrowup: [0, -step],
          arrowdown: [0, step],
        };
        if (delta[key]) {
          e.preventDefault();
          nudgeSelectedObject(delta[key][0], delta[key][1]);
          return;
        }
      }
      if (key === 'v') setActiveTool('cursor');
      if (key === 't' && session) setActiveTool('text');
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sid, history, isLoading, selectedObjectId, session, zoomIn, zoomOut, resetZoom, nudgeSelectedObject]);

  return (
    <div className="app-shell">
      <header className="top-toolbar">
        <div className="toolbar-left">
          <AeroLogo />
          {TOOL_LIST.map((tool) => (
            <button
              key={tool.key}
              className={`tool-btn${activeTool === tool.key ? ' active' : ''}`}
              title={tool.label}
              onClick={() => onToolSelect(tool.key)}
              disabled={!session && tool.key !== 'text' && tool.key !== 'cursor'}
            >
              {tool.icon}
            </button>
          ))}
        </div>

        <div className="toolbar-center">
          <span className="doc-title">{displayedFilename}</span>
        </div>

        <div className="toolbar-right">
          <button className="icon-action" title="Open PDF" onClick={openFilePicker}>
            <FolderOpen size={16} strokeWidth={1.75} />
          </button>
          <button
            className="icon-action"
            title="Undo (Ctrl+Z)"
            onClick={handleUndo}
            disabled={!history?.can_undo || isLoading}
          >
            <Undo2 size={16} strokeWidth={1.75} />
          </button>
          <button
            className="icon-action"
            title="Redo (Ctrl+Shift+Z)"
            onClick={handleRedo}
            disabled={!history?.can_redo || isLoading}
          >
            <Redo2 size={16} strokeWidth={1.75} />
          </button>
          <button className="export-btn" onClick={handleExportPDF} disabled={!session}>
            <Download size={15} strokeWidth={1.75} />
            <span>Export PDF</span>
          </button>
        </div>
      </header>

      <div className="editor-shell">
        <Sidebar
          pages={displayPages}
          activePage={activePage}
          filename={displayedFilename}
          pdfUrl={session ? api.fileUrl(session.session_id) : undefined}
          docVersion={history?.version ?? 0}
          setActivePage={setActivePage}
          onReorder={session ? handleReorderPages : undefined}
        />

        <main
          ref={stageRef}
          className={`editor-stage${isDragging ? ' dragging' : ''}`}
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
          onDrop={onDrop}
        >
          {toast.text && (
            <div className={`toast${toast.type ? ` ${toast.type}` : ''}`}>
              {toast.type === 'success' ? <CheckCircle2 size={14} /> : null}
              {toast.type === 'error' ? <AlertCircle size={14} /> : null}
              <span>{toast.text}</span>
              <button onClick={() => setToast({ text: '', type: null })} className="toast-close">
                <X size={12} />
              </button>
            </div>
          )}

          {session && (
            <div className="zoom-bar">
              <button
                className="zoom-btn"
                onClick={zoomOut}
                disabled={zoom <= ZOOM_LEVELS[0] + 1e-3}
                title="Zoom out (Ctrl+-)"
              >
                <Minus size={14} strokeWidth={2} />
              </button>
              <button className="zoom-value" onClick={resetZoom} title="Reset zoom (Ctrl+0)">
                {Math.round(zoom * 100)}%
              </button>
              <button
                className="zoom-btn"
                onClick={zoomIn}
                disabled={zoom >= ZOOM_LEVELS[ZOOM_LEVELS.length - 1] - 1e-3}
                title="Zoom in (Ctrl+=)"
              >
                <Plus size={14} strokeWidth={2} />
              </button>
            </div>
          )}

          {session ? (
            <PDFCanvas
              page={activePageData}
              pdfUrl={api.fileUrl(session.session_id)}
              docVersion={history?.version ?? 0}
              scale={zoom}
              onSelectBlock={handleSelectBlock}
              onOCRComplete={handleOCRComplete}
              selectedBlock={selectedBlock}
              selectedObjectId={selectedObjectId}
              onSelectObject={handleSelectObject}
              activeTool={activeTool}
              activeShape={activeTool === 'draw' ? activeShape : null}
              onDrawShape={handleDrawShape}
              onCreateObject={handleCreateObject}
              onUpdateObject={handleUpdateObject}
              assetUrlFor={(assetId: string) => api.assetUrl(session.session_id, assetId)}
            />
          ) : (
            <button className="mock-document" onClick={openFilePicker}>
              <div className="mock-brand">
                <AeroLogo compact />
                <span>Design-grade PDF editing</span>
              </div>
              <div className="mock-title">Quarterly Revenue Summary</div>
              <div className="mock-paragraph">
                Open a PDF to place text, images, comments, signatures, and vector shapes on a clean editing canvas.
              </div>
              <div className="mock-image" />
              <div className="mock-selection">
                <span>Executive overview selected</span>
                {Array.from({ length: 8 }).map((_, i) => (
                  <b key={i} className={`mock-handle h-${i + 1}`} />
                ))}
              </div>
            </button>
          )}
        </main>

        <PropertiesPanel
          selectedBlock={selectedBlock}
          selectedObject={selectedObject}
          activeTool={activeTool}
          activeShape={activeShape}
          onChangeActiveShape={setActiveShape}
          isLoading={isLoading}
          activePage={activePage}
          onSaveBlockEdits={handleSaveBlockEdits}
          onSaveObjectEdits={(changes) => selectedObject && handleUpdateObject(selectedObject.id, changes)}
          onDeleteObject={handleDeleteObject}
          onBringForward={() => handleReorderObject('forward')}
          onSendBackward={() => handleReorderObject('backward')}
          onInsertImage={() => setShowImageModal(true)}
          onExport={handleExportPDF}
          onFlatten={handleFlatten}
          onRotate={handleRotate}
          onDuplicate={handleDuplicate}
          onDelete={handleDelete}
          onInsertBlank={handleInsertBlank}
          onInsertPdf={() => mergeInputRef.current?.click()}
          onNumberPages={handleNumberPages}
          onWatermark={() => setDocModal('watermark')}
          onExtract={() => setDocModal('extract')}
          strokeColor={strokeColor}
          onChangeStrokeColor={setStrokeColor}
          fillColor={fillColor}
          onChangeFillColor={setFillColor}
          lineWidth={lineWidth}
          onChangeLineWidth={setLineWidth}
          canEdit={!!session}
        />
      </div>

      <input type="file" ref={fileInputRef} onChange={onFileChange} accept="application/pdf" style={{ display: 'none' }} />
      <input
        type="file"
        ref={mergeInputRef}
        onChange={(e) => {
          if (e.target.files?.[0]) handleMergePdf(e.target.files[0]);
          e.target.value = '';
        }}
        accept="application/pdf"
        style={{ display: 'none' }}
      />

      {showImageModal && session && (
        <ImageInsertModal onClose={() => setShowImageModal(false)} onInsert={handleInsertImage} isLoading={isLoading} />
      )}

      {docModal === 'watermark' && session && (
        <PromptModal
          title="Add watermark"
          label="Watermark text"
          defaultValue="DRAFT"
          placeholder="e.g. CONFIDENTIAL"
          confirmLabel="Apply to all pages"
          hint="Stamped diagonally and semi-transparent across every page."
          isLoading={isLoading}
          onConfirm={handleWatermark}
          onClose={() => setDocModal(null)}
        />
      )}

      {docModal === 'extract' && session && (
        <PromptModal
          title="Extract pages"
          label="Page range"
          defaultValue={`1-${session.pages.length}`}
          placeholder="e.g. 1-3,5"
          confirmLabel="Download selected pages"
          hint="Downloads a new PDF with just these pages. Your document is unchanged."
          isLoading={isLoading}
          onConfirm={handleExtract}
          onClose={() => setDocModal(null)}
        />
      )}
    </div>
  );
}

export default App;
