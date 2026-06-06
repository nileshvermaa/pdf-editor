import React, { useState, useEffect } from 'react';
import { Type, Sparkles, RefreshCw } from 'lucide-react';

interface SelectedBlock {
  pageNumber: number;
  bbox: number[];
  text: string;
  font: string;
  size: number;
  color: string;
}

interface PropertiesPanelProps {
  selectedBlock: SelectedBlock | null;
  onSaveBlockEdits: (updatedText: string, size: number, font: string, color: string) => void;
  onSearchReplace: (searchTerm: string, replacement: string, pageOnly: boolean) => void;
  isLoading: boolean;
}

export const PropertiesPanel: React.FC<PropertiesPanelProps> = ({
  selectedBlock,
  onSaveBlockEdits,
  onSearchReplace,
  isLoading
}) => {
  const [textVal, setTextVal] = useState('');
  const [fontSize, setFontSize] = useState(12);
  const [fontFamily, setFontFamily] = useState('Helvetica');
  const [colorHex, setColorHex] = useState('#000000');

  const [searchWord, setSearchWord] = useState('');
  const [replaceWord, setReplaceWord] = useState('');

  // Sync state if selectedBlock changes
  useEffect(() => {
    if (selectedBlock) {
      setTextVal(selectedBlock.text);
      setFontSize(Math.round(selectedBlock.size));
      setFontFamily(selectedBlock.font || 'Helvetica');
      setColorHex(selectedBlock.color || '#000000');
    }
  }, [selectedBlock]);

  const handleApplyEdits = () => {
    if (!selectedBlock) return;
    onSaveBlockEdits(textVal, fontSize, fontFamily, colorHex);
  };

  return (
    <aside className="properties-panel">
      {selectedBlock ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }} className="fade-in">
          <h3 style={{ margin: 0, fontSize: '1rem', display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--accent-light)' }}>
            <Type size={18} /> Inspect Text Block
          </h3>
          
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            <label style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>Content Text</label>
            <textarea
              className="input-text"
              style={{ minHeight: '100px', resize: 'vertical', fontSize: '0.85rem' }}
              value={textVal}
              onChange={(e) => setTextVal(e.target.value)}
            />
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <label style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>Font Size (pt)</label>
              <input
                type="number"
                className="input-text"
                value={fontSize}
                onChange={(e) => setFontSize(Number(e.target.value))}
              />
            </div>
            
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <label style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>Text Color</label>
              <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                <input
                  type="color"
                  value={colorHex}
                  onChange={(e) => setColorHex(e.target.value)}
                  style={{ width: '32px', height: '32px', border: 'none', borderRadius: '4px', cursor: 'pointer', padding: 0 }}
                />
                <span style={{ fontSize: '0.8rem', fontFamily: 'monospace' }}>{colorHex.toUpperCase()}</span>
              </div>
            </div>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            <label style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>Font Style</label>
            <select
              className="input-text"
              value={fontFamily}
              onChange={(e) => setFontFamily(e.target.value)}
              style={{ background: 'var(--bg-secondary)' }}
            >
              <option value="Helvetica">Helvetica (Sans-Serif)</option>
              <option value="Times-Roman">Times New Roman (Serif)</option>
              <option value="Courier">Courier (Monospace)</option>
            </select>
          </div>

          <button
            className="btn btn-primary"
            onClick={handleApplyEdits}
            style={{ width: '100%', marginTop: '8px' }}
            disabled={isLoading}
          >
            {isLoading ? 'Saving...' : 'Apply Block Edits'}
          </button>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
          <div style={{ background: 'rgba(255,255,255,0.02)', padding: '16px', borderRadius: '8px', border: '1px solid var(--border-glass)' }}>
            <h4 style={{ margin: '0 0 8px 0', fontSize: '0.9rem', color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: '6px' }}>
              <Sparkles size={14} style={{ color: 'var(--accent-light)' }} /> Quick Help
            </h4>
            <ul style={{ margin: 0, paddingLeft: '16px', fontSize: '0.8rem', color: 'var(--text-secondary)', display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <li>Double-click any text block to open settings and edit content.</li>
              <li>Hovering over text areas displays visual coordinate margins.</li>
              <li>Orange page borders indicate scanned images: click them to perform OCR scans.</li>
            </ul>
          </div>

          <div style={{ borderTop: '1px solid var(--border-glass)', paddingTop: '20px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
            <h3 style={{ margin: 0, fontSize: '0.95rem', display: 'flex', alignItems: 'center', gap: '8px' }}>
              <RefreshCw size={16} /> Global Replace
            </h3>
            
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <label style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>Find Text</label>
              <input
                type="text"
                className="input-text"
                placeholder="Text to replace..."
                value={searchWord}
                onChange={(e) => setSearchWord(e.target.value)}
              />
            </div>
            
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <label style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>Replace With</label>
              <input
                type="text"
                className="input-text"
                placeholder="Replacement..."
                value={replaceWord}
                onChange={(e) => setReplaceWord(e.target.value)}
              />
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', marginTop: '4px' }}>
              <button
                className="btn btn-secondary"
                onClick={() => onSearchReplace(searchWord, replaceWord, true)}
                disabled={isLoading || !searchWord}
                style={{ fontSize: '0.8rem', padding: '6px 12px' }}
              >
                Page Only
              </button>
              <button
                className="btn btn-primary"
                onClick={() => onSearchReplace(searchWord, replaceWord, false)}
                disabled={isLoading || !searchWord}
                style={{ fontSize: '0.8rem', padding: '6px 12px' }}
              >
                All Pages
              </button>
            </div>
          </div>
        </div>
      )}
    </aside>
  );
};
