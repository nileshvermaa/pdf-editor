import React, { useEffect, useMemo, useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  Copy,
  FilePlus,
  FileStack,
  Hash,
  Image as ImageIcon,
  RotateCcw,
  RotateCw,
  Trash2,
} from 'lucide-react';
import type { EditorObject, ShapeObjectType, UpdateObjectPayload } from '../api';

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

interface PropertiesPanelProps {
  selectedBlock: SelectedBlock | null;
  selectedObject: EditorObject | null;
  activeTool: ToolKey;
  activeShape: ShapeObjectType;
  onChangeActiveShape: (shape: ShapeObjectType) => void;
  onSaveBlockEdits: (updatedText: string, size: number, font: string, color: string, align: number) => void;
  onSaveObjectEdits: (changes: UpdateObjectPayload) => void;
  onDeleteObject: () => void;
  onBringForward: () => void;
  onSendBackward: () => void;
  onInsertImage: () => void;
  isLoading: boolean;
  activePage: number;
  onExport: () => void;
  onFlatten: () => void;
  onRotate: (degrees: number) => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onInsertBlank: () => void;
  onInsertPdf: () => void;
  onNumberPages: () => void;
  strokeColor: string;
  onChangeStrokeColor: (color: string) => void;
  fillColor: string;
  onChangeFillColor: (color: string) => void;
  lineWidth: number;
  onChangeLineWidth: (width: number) => void;
  canEdit: boolean;
}

export const PropertiesPanel: React.FC<PropertiesPanelProps> = ({
  selectedBlock,
  selectedObject,
  activeTool,
  activeShape,
  onChangeActiveShape,
  onSaveBlockEdits,
  onSaveObjectEdits,
  onDeleteObject,
  onBringForward,
  onSendBackward,
  onInsertImage,
  isLoading,
  activePage,
  onExport,
  onFlatten,
  onRotate,
  onDuplicate,
  onDelete,
  onInsertBlank,
  onInsertPdf,
  onNumberPages,
  strokeColor,
  onChangeStrokeColor,
  fillColor,
  onChangeFillColor,
  lineWidth,
  onChangeLineWidth,
  canEdit,
}) => {
  const [textVal, setTextVal] = useState('');
  const [fontSize, setFontSize] = useState(12);
  const [fontFamily, setFontFamily] = useState('Inter');
  const [colorHex, setColorHex] = useState('#000000');
  const [align, setAlign] = useState(0);
  const [fontWeight, setFontWeight] = useState('Regular');

  const [objectText, setObjectText] = useState('');
  const [objectFontSize, setObjectFontSize] = useState(14);
  const [objectColor, setObjectColor] = useState('#000000');
  const [objectFill, setObjectFill] = useState('#ffffff');
  const [objectStroke, setObjectStroke] = useState('#000000');
  const [objectLineWidth, setObjectLineWidth] = useState(2);
  const [objectAlign, setObjectAlign] = useState<'left' | 'center' | 'right' | 'justify'>('left');
  const [x, setX] = useState(0);
  const [y, setY] = useState(0);
  const [w, setW] = useState(0);
  const [h, setH] = useState(0);

  useEffect(() => {
    if (!selectedBlock) return;
    setTextVal(selectedBlock.text);
    setFontSize(Math.round(selectedBlock.size));
    setColorHex(selectedBlock.color || '#000000');
    setFontFamily((selectedBlock.font || 'Inter').includes('Courier') ? 'Courier' : 'Inter');
    const flags = selectedBlock.flags || 0;
    const isBold = !!(flags & (1 << 4)) || (selectedBlock.font || '').toLowerCase().includes('bold');
    setFontWeight(isBold ? 'Bold' : 'Regular');
    setAlign(0);
  }, [selectedBlock]);

  useEffect(() => {
    if (!selectedObject) return;
    const [x0, y0, x1, y1] = selectedObject.bbox;
    // Lines/arrows keep their direction in the bbox, so show the normalised
    // envelope here (W/H must never display negative).
    setX(Number(Math.min(x0, x1).toFixed(1)));
    setY(Number(Math.min(y0, y1).toFixed(1)));
    setW(Number(Math.abs(x1 - x0).toFixed(1)));
    setH(Number(Math.abs(y1 - y0).toFixed(1)));
    if (selectedObject.type === 'text' || selectedObject.type === 'comment' || selectedObject.type === 'signature') {
      setObjectText(selectedObject.text || '');
      setObjectFontSize(Math.round(selectedObject.font_size || (selectedObject.type === 'signature' ? 20 : 14)));
      setObjectColor(selectedObject.color || '#000000');
      setObjectAlign(selectedObject.align || 'left');
    }
    if (selectedObject.type === 'shape') {
      setObjectFill(selectedObject.fill_color || '#ffffff');
      setObjectStroke(selectedObject.stroke_color || '#000000');
      setObjectLineWidth(selectedObject.line_width || 2);
    } else if (selectedObject.type === 'comment') {
      setObjectFill(selectedObject.fill_color || '#fff6bf');
      setObjectStroke(selectedObject.stroke_color || '#d7b200');
      setObjectLineWidth(selectedObject.line_width || 1.5);
    } else {
      setObjectFill('#ffffff');
      setObjectStroke('#000000');
      setObjectLineWidth(2);
    }
  }, [selectedObject]);

  const selectionLabel = useMemo(() => {
    if (selectedObject) return selectedObject.type.toUpperCase();
    if (selectedBlock) return 'TEXT BLOCK';
    return activeTool === 'draw' ? 'DRAW' : 'TEXT PROPERTIES';
  }, [activeTool, selectedBlock, selectedObject]);

  const saveObject = () => {
    if (!selectedObject) return;
    const isDirectional =
      selectedObject.type === 'shape' &&
      (selectedObject.shape_type === 'line' || selectedObject.shape_type === 'arrow');
    let bbox: [number, number, number, number];
    if (isDirectional) {
      // Re-apply the original draw direction to the edited envelope so the
      // arrowhead keeps pointing the same way.
      const [ox0, oy0, ox1, oy1] = selectedObject.bbox;
      const flipX = ox1 < ox0;
      const flipY = oy1 < oy0;
      const safeW = Math.max(w, 0);
      const safeH = Math.max(h, 0);
      bbox = [
        flipX ? x + safeW : x,
        flipY ? y + safeH : y,
        flipX ? x : x + safeW,
        flipY ? y : y + safeH,
      ];
    } else {
      bbox = [x, y, x + Math.max(w, 2), y + Math.max(h, 2)];
    }
    const payload: UpdateObjectPayload = { bbox };

    if (selectedObject.type === 'text' || selectedObject.type === 'comment' || selectedObject.type === 'signature') {
      payload.text = objectText;
      payload.font_size = objectFontSize;
      payload.color = objectColor;
      payload.align = objectAlign;
    }
    if (selectedObject.type === 'shape' || selectedObject.type === 'comment') {
      payload.fill_color = objectFill;
      payload.stroke_color = objectStroke;
      payload.line_width = objectLineWidth;
    }

    onSaveObjectEdits(payload);
  };

  return (
    <aside className="right-panel">
      <section className="prop-section">
        <header className="prop-title">PAGE</header>
        <div className="prop-row">
          <span className="prop-label">Page Size</span>
          <span className="prop-value">A4</span>
        </div>
        <div className="prop-row">
          <span className="prop-label">Orientation</span>
          <span className="prop-value">Portrait</span>
        </div>
        <div className="page-actions">
          <button className="mini-icon-btn" title="Rotate Left" onClick={() => onRotate(-90)} disabled={!canEdit || isLoading}>
            <RotateCcw size={14} strokeWidth={1.5} />
          </button>
          <button className="mini-icon-btn" title="Rotate Right" onClick={() => onRotate(90)} disabled={!canEdit || isLoading}>
            <RotateCw size={14} strokeWidth={1.5} />
          </button>
          <button className="mini-icon-btn" title="Duplicate Page" onClick={onDuplicate} disabled={!canEdit || isLoading}>
            <Copy size={14} strokeWidth={1.5} />
          </button>
          <button className="mini-icon-btn" title="Insert Blank Page" onClick={onInsertBlank} disabled={!canEdit || isLoading}>
            <FilePlus size={14} strokeWidth={1.5} />
          </button>
          <button className="mini-icon-btn" title="Insert PDF after this page" onClick={onInsertPdf} disabled={!canEdit || isLoading}>
            <FileStack size={14} strokeWidth={1.5} />
          </button>
          <button className="mini-icon-btn" title="Number all pages (bottom center)" onClick={onNumberPages} disabled={!canEdit || isLoading}>
            <Hash size={14} strokeWidth={1.5} />
          </button>
          <button className="mini-icon-btn danger" title="Delete Page" onClick={onDelete} disabled={!canEdit || isLoading}>
            <Trash2 size={14} strokeWidth={1.5} />
          </button>
        </div>
        <div className="prop-note">Page {activePage}</div>
      </section>

      <section className="prop-section">
        <header className="prop-title">{selectionLabel}</header>
        {selectedObject ? (
          <div className="panel-stack">
            <div className="prop-grid">
              <label className="prop-field">
                <span className="prop-label">X</span>
                <input className="prop-input" type="number" value={x} onChange={(e) => setX(Number(e.target.value) || 0)} />
              </label>
              <label className="prop-field">
                <span className="prop-label">Y</span>
                <input className="prop-input" type="number" value={y} onChange={(e) => setY(Number(e.target.value) || 0)} />
              </label>
              <label className="prop-field">
                <span className="prop-label">W</span>
                <input className="prop-input" type="number" min={2} value={w} onChange={(e) => setW(Number(e.target.value) || 2)} />
              </label>
              <label className="prop-field">
                <span className="prop-label">H</span>
                <input className="prop-input" type="number" min={2} value={h} onChange={(e) => setH(Number(e.target.value) || 2)} />
              </label>
            </div>

            {selectedObject.type !== 'image' && (
              <>
                <textarea className="prop-textarea" value={objectText} onChange={(e) => setObjectText(e.target.value)} disabled={!canEdit || isLoading} />
                <div className="prop-grid">
                  <label className="prop-field">
                    <span className="prop-label">Size</span>
                    <input
                      className="prop-input"
                      type="number"
                      min={4}
                      max={144}
                      value={objectFontSize}
                      onChange={(e) => setObjectFontSize(Math.max(4, Number(e.target.value) || 12))}
                    />
                  </label>
                  <label className="prop-field">
                    <span className="prop-label">Align</span>
                    <select className="prop-input" value={objectAlign} onChange={(e) => setObjectAlign(e.target.value as typeof objectAlign)}>
                      <option value="left">Left</option>
                      <option value="center">Center</option>
                      <option value="right">Right</option>
                      <option value="justify">Justify</option>
                    </select>
                  </label>
                </div>
              </>
            )}

            <div className="inline-actions">
              <button className="mini-icon-btn" title="Send backward" onClick={onSendBackward} disabled={!canEdit || isLoading}>
                <ArrowDown size={14} strokeWidth={1.5} />
              </button>
              <button className="mini-icon-btn" title="Bring forward" onClick={onBringForward} disabled={!canEdit || isLoading}>
                <ArrowUp size={14} strokeWidth={1.5} />
              </button>
              <button className="mini-icon-btn danger" title="Delete object" onClick={onDeleteObject} disabled={!canEdit || isLoading}>
                <Trash2 size={14} strokeWidth={1.5} />
              </button>
            </div>

            <button className="block-save-btn" onClick={saveObject} disabled={!canEdit || isLoading}>
              {isLoading ? 'Applying...' : 'Apply Object'}
            </button>
          </div>
        ) : activeTool === 'text' && selectedBlock ? (
          <div className="panel-stack">
            <div className="prop-row">
              <span className="prop-label">Font</span>
              <span className="prop-value">{fontFamily}</span>
            </div>
            <div className="prop-row">
              <span className="prop-label">Weight</span>
              <span className="prop-value">{fontWeight}</span>
            </div>
            <div className="prop-row">
              <span className="prop-label">Size</span>
              <span className="prop-value">{fontSize}px</span>
            </div>
            <textarea className="prop-textarea" value={textVal} onChange={(e) => setTextVal(e.target.value)} disabled={!canEdit || isLoading} />
            <div className="prop-grid">
              <label className="prop-field">
                <span className="prop-label">Size</span>
                <input
                  className="prop-input"
                  type="number"
                  min={4}
                  max={144}
                  value={fontSize}
                  onChange={(e) => setFontSize(Math.max(4, Number(e.target.value) || 12))}
                />
              </label>
              <label className="prop-field">
                <span className="prop-label">Align</span>
                <select className="prop-input" value={align} onChange={(e) => setAlign(Number(e.target.value))}>
                  <option value={0}>Left</option>
                  <option value={1}>Center</option>
                  <option value={2}>Right</option>
                  <option value={3}>Justify</option>
                </select>
              </label>
            </div>
            <button className="block-save-btn" onClick={() => onSaveBlockEdits(textVal, fontSize, fontFamily, colorHex, align)} disabled={!canEdit || isLoading}>
              {isLoading ? 'Saving...' : 'Apply Text'}
            </button>
          </div>
        ) : (
          <div className="prop-note">
            {activeTool === 'draw'
              ? 'Drag on the page to place a shape.'
              : activeTool === 'image'
                ? 'Place an image from the toolbar or button below.'
                : 'Click on the page to create a new element, or select an object to edit it.'}
          </div>
        )}
      </section>

      <section className="prop-section">
        <header className="prop-title">COLOR</header>
        <div className="color-row">
          <span className="color-swatch" style={{ background: selectedObject ? objectColor : colorHex }} />
          <span className="prop-value">{(selectedObject ? objectColor : colorHex).toUpperCase()}</span>
          <input
            className="hidden-color"
            type="color"
            value={selectedObject ? objectColor : colorHex}
            onChange={(e) => (selectedObject ? setObjectColor(e.target.value) : setColorHex(e.target.value))}
            disabled={!canEdit || isLoading}
            title="Color"
          />
        </div>

        {selectedObject && (selectedObject.type === 'shape' || selectedObject.type === 'comment') && (
          <div className="draw-controls">
            <div className="draw-control">
              <span className="prop-label">Stroke</span>
              <input type="color" value={objectStroke} onChange={(e) => setObjectStroke(e.target.value)} />
            </div>
            <div className="draw-control">
              <span className="prop-label">Fill</span>
              <input type="color" value={objectFill} onChange={(e) => setObjectFill(e.target.value)} />
            </div>
            <div className="draw-control">
              <span className="prop-label">Width</span>
              <input className="prop-input compact" type="number" min={1} max={20} value={objectLineWidth} onChange={(e) => setObjectLineWidth(Math.max(1, Number(e.target.value) || 1))} />
            </div>
          </div>
        )}

        {!selectedObject && activeTool === 'draw' && (
          <div className="draw-controls">
            <div className="draw-control">
              <span className="prop-label">Shape</span>
              <select className="prop-input compact-wide" value={activeShape} onChange={(e) => onChangeActiveShape(e.target.value as ShapeObjectType)}>
                <option value="rect">Rectangle</option>
                <option value="circle">Ellipse</option>
                <option value="line">Line</option>
                <option value="arrow">Arrow</option>
              </select>
            </div>
            <div className="draw-control">
              <span className="prop-label">Stroke</span>
              <input type="color" value={strokeColor} onChange={(e) => onChangeStrokeColor(e.target.value)} />
            </div>
            <div className="draw-control">
              <span className="prop-label">Fill</span>
              <input type="color" value={fillColor} onChange={(e) => onChangeFillColor(e.target.value)} />
            </div>
            <div className="draw-control">
              <span className="prop-label">Width</span>
              <input className="prop-input compact" type="number" min={1} max={20} value={lineWidth} onChange={(e) => onChangeLineWidth(Math.max(1, Number(e.target.value) || 1))} />
            </div>
          </div>
        )}

        {!selectedObject && activeTool === 'image' && (
          <button className="block-save-btn secondary" onClick={onInsertImage} disabled={!canEdit || isLoading}>
            <ImageIcon size={14} strokeWidth={1.5} />
            <span>Insert Image</span>
          </button>
        )}
      </section>

      <section className="prop-section">
        <header className="prop-title">EXPORT</header>
        <div className="panel-stack">
          <button className="download-btn" onClick={onExport} disabled={!canEdit}>
            Download PDF
          </button>
          <button className="block-save-btn secondary" onClick={onFlatten} disabled={!canEdit || isLoading}>
            Flatten Objects
          </button>
        </div>
      </section>
    </aside>
  );
};
