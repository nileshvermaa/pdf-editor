// Centralised API client for the AeroPDF backend.
// Every mutating endpoint returns the same EditResponse shape, so callers can
// uniformly refresh pages + history from one place (see App.applyEdit).

// API base resolution:
//   - Production (frontend on Vercel, backend on Render): set VITE_API_BASE to the
//     Render backend's public URL + "/api", e.g. https://aeropdf-backend.onrender.com/api
//   - Local dev: leave VITE_API_BASE unset and "/api" is proxied to the backend by
//     vite.config.ts (target http://localhost:8000).
const API_BASE = import.meta.env.VITE_API_BASE || '/api';

export interface HistoryState {
  can_undo: boolean;
  can_redo: boolean;
  version: number;
  total_versions: number;
}

export type EditorObjectType = 'text' | 'shape' | 'comment' | 'signature' | 'image';
export type ShapeObjectType = 'rect' | 'circle' | 'line' | 'arrow';

interface EditorObjectBase {
  id: string;
  page_number: number;
  type: EditorObjectType;
  bbox: [number, number, number, number];
  rotation?: number;
  opacity?: number;
  z_index?: number;
  locked?: boolean;
  hidden?: boolean;
}

export interface ShapeObject extends EditorObjectBase {
  type: 'shape';
  shape_type: ShapeObjectType;
  stroke_color?: string;
  fill_color?: string;
  line_width?: number;
}

export interface TextLikeObject extends EditorObjectBase {
  type: 'text' | 'comment' | 'signature';
  text: string;
  font_family?: string;
  font_size?: number;
  font_weight?: string;
  font_style?: string;
  color?: string;
  align?: 'left' | 'center' | 'right' | 'justify';
  stroke_color?: string;
  fill_color?: string;
  line_width?: number;
}

export interface ImageObject extends EditorObjectBase {
  type: 'image';
  asset_id: string;
}

export type EditorObject = ShapeObject | TextLikeObject | ImageObject;

export interface PDFPage {
  number: number;
  width: number;
  height: number;
  rotation?: number;
  is_scanned?: boolean;
  blocks: any[];
  images: any[];
  objects: EditorObject[];
}

export interface EditResponse {
  success: boolean;
  message?: string;
  pages: PDFPage[];
  metadata: { title: string; author: string; pages: number };
  history: HistoryState;
  replacements_made?: number;
  warnings?: string[];
}

export interface OCRBlockPayload {
  text: string;
  bbox: [number, number, number, number];
  font_name?: string;
  font_size?: number;
  hex_color?: string;
  auto_shrink?: boolean;
}

export interface CreateObjectPayload {
  page_number: number;
  type: EditorObjectType;
  bbox: [number, number, number, number];
  rotation?: number;
  opacity?: number;
  z_index?: number;
  locked?: boolean;
  hidden?: boolean;
  text?: string;
  font_family?: string;
  font_size?: number;
  font_weight?: string;
  font_style?: string;
  color?: string;
  align?: 'left' | 'center' | 'right' | 'justify';
  shape_type?: ShapeObjectType;
  stroke_color?: string;
  fill_color?: string;
  line_width?: number;
  asset_id?: string;
}

export interface UpdateObjectPayload extends Partial<CreateObjectPayload> {}

async function parse<T>(res: Response): Promise<T> {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((data as any).detail || (data as any).message || `Request failed (${res.status})`);
  }
  return data as T;
}

const post = (path: string, body?: unknown) =>
  fetch(API_BASE + path, {
    method: 'POST',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });

export const api = {
  base: API_BASE,
  // Export: flattens pending overlay objects server-side.
  downloadUrl: (sid: string) => `${API_BASE}/download/${sid}`,
  // Canvas rendering: raw current version — objects are drawn by the DOM
  // overlay, so the bitmap must NOT have them baked in (double render).
  fileUrl: (sid: string) => `${API_BASE}/file/${sid}`,

  async upload(file: File) {
    const fd = new FormData();
    fd.append('file', file);
    return parse<EditResponse & { session_id: string; filename: string }>(
      await fetch(API_BASE + '/upload', { method: 'POST', body: fd })
    );
  },

  replace: (sid: string, body: object) => post(`/replace/${sid}`, body).then(parse<EditResponse>),
  editBlock: (sid: string, body: object) => post(`/edit-block/${sid}`, body).then(parse<EditResponse>),
  persistOcr: (sid: string, body: { page_number: number; blocks: OCRBlockPayload[] }) =>
    post(`/ocr/${sid}`, body).then(parse<EditResponse>),
  command: (sid: string, command: string) => post(`/command/${sid}`, { command }).then(parse<EditResponse>),
  undo: (sid: string) => post(`/undo/${sid}`).then(parse<EditResponse>),
  redo: (sid: string) => post(`/redo/${sid}`).then(parse<EditResponse>),
  flatten: (sid: string) => post(`/flatten/${sid}`).then(parse<EditResponse>),

  rotate: (sid: string, page: number, degrees: number) =>
    post(`/pages/rotate/${sid}`, { page_numbers: [page], degrees }).then(parse<EditResponse>),
  deletePages: (sid: string, pages: number[]) =>
    post(`/pages/delete/${sid}`, { page_numbers: pages }).then(parse<EditResponse>),
  duplicate: (sid: string, page: number) =>
    post(`/pages/duplicate/${sid}`, { page_number: page }).then(parse<EditResponse>),
  insertBlank: (sid: string, afterPage: number) =>
    post(`/pages/insert-blank/${sid}`, { after_page: afterPage }).then(parse<EditResponse>),
  reorderPages: (sid: string, order: number[]) =>
    post(`/pages/reorder/${sid}`, { order }).then(parse<EditResponse>),

  createObject: (sid: string, body: CreateObjectPayload) => post(`/objects/${sid}`, body).then(parse<EditResponse>),
  updateObject: (sid: string, objectId: string, body: UpdateObjectPayload) =>
    fetch(`${API_BASE}/objects/${sid}/${objectId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then(parse<EditResponse>),
  deleteObject: (sid: string, objectId: string) =>
    fetch(`${API_BASE}/objects/${sid}/${objectId}`, { method: 'DELETE' }).then(parse<EditResponse>),
  reorderObjects: (sid: string, objectIds: string[]) =>
    post(`/objects/${sid}/reorder`, { object_ids: objectIds }).then(parse<EditResponse>),

  drawShape: (sid: string, body: object) => post(`/draw-shape/${sid}`, body).then(parse<EditResponse>),
  addHighlight: (sid: string, body: object) => post(`/add-highlight/${sid}`, body).then(parse<EditResponse>),
  async addImage(sid: string, file: File, x: number, y: number, width: number, height: number, pageNumber: number) {
    const fd = new FormData();
    fd.append('file', file);
    fd.append('x', x.toString());
    fd.append('y', y.toString());
    fd.append('width', width.toString());
    fd.append('height', height.toString());
    fd.append('page_number', pageNumber.toString());
    return parse<EditResponse>(
      await fetch(`${API_BASE}/add-image/${sid}`, { method: 'POST', body: fd })
    );
  },
  assetUrl: (sid: string, assetId: string) => `${API_BASE}/assets/${sid}/${assetId}`,
};
