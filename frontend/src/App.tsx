import React, { useState, useRef } from 'react';
import { UploadCloud, FileText, Download, AlertCircle, Sparkles } from 'lucide-react';
import { Sidebar } from './components/Sidebar';
import { PDFCanvas } from './components/PDFCanvas';
import { PropertiesPanel } from './components/PropertiesPanel';
import { CommandConsole } from './components/CommandConsole';

interface PDFPage {
  number: number;
  width: number;
  height: number;
  blocks: any[];
  images: any[];
}

interface Session {
  session_id: string;
  filename: string;
  metadata: {
    title: string;
    author: string;
    pages: number;
  };
  pages: PDFPage[];
}

interface SelectedBlock {
  pageNumber: number;
  bbox: number[];
  text: string;
  font: string;
  size: number;
  color: string;
}

const API_BASE = import.meta.env.VITE_API_BASE || '/api';

function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [activePage, setActivePage] = useState<number>(1);
  const [selectedBlock, setSelectedBlock] = useState<SelectedBlock | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [consoleMsg, setConsoleMsg] = useState<{ text: string; type: 'success' | 'error' | 'info' | null }>({ text: '', type: null });

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Trigger file upload API
  const handleFileUpload = async (file: File) => {
    setIsLoading(true);
    setError(null);
    const formData = new FormData();
    formData.append('file', file);

    try {
      const response = await fetch(`${API_BASE}/upload`, {
        method: 'POST',
        body: formData,
      });

      if (!response.ok) {
        const errData = await response.json();
        throw new Error(errData.detail || 'Failed to upload and parse PDF file.');
      }

      const data: Session = await response.json();
      setSession(data);
      setActivePage(1);
      setSelectedBlock(null);
      setConsoleMsg({ text: `File "${file.name}" uploaded successfully!`, type: 'success' });
    } catch (err: any) {
      setError(err.message);
    } finally {
      setIsLoading(false);
    }
  };

  const onFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      handleFileUpload(e.target.files[0]);
    }
  };

  // Perform block updates (saving text modification with style)
  const handleSaveBlockEdits = async (updatedText: string, size: number, font: string, color: string) => {
    if (!session || !selectedBlock) return;
    setIsLoading(true);
    setError(null);

    try {
      const response = await fetch(`${API_BASE}/edit-block/${session.session_id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          page_number: selectedBlock.pageNumber,
          original_bbox: selectedBlock.bbox,
          new_text: updatedText,
          font_size: size,
          font_name: font,
          hex_color: color
        }),
      });

      if (!response.ok) throw new Error('Failed to save edited block on backend.');

      const data = await response.json();
      // Update session pages list state
      setSession({
        ...session,
        pages: data.pages
      });
      setSelectedBlock(null);
      setConsoleMsg({ text: 'Text block updated successfully!', type: 'success' });
    } catch (err: any) {
      setError(err.message);
    } finally {
      setIsLoading(false);
    }
  };

  // Execute global search and replace on page or all pages
  const handleSearchReplace = async (searchTerm: string, replacement: string, pageOnly: boolean) => {
    if (!session) return;
    setIsLoading(true);
    setError(null);

    try {
      const response = await fetch(`${API_BASE}/replace/${session.session_id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          search_term: searchTerm,
          replacement: replacement,
          page_number: pageOnly ? activePage : null
        }),
      });

      if (!response.ok) throw new Error('Failed to execute search and replace.');

      const data = await response.json();
      setSession({
        ...session,
        pages: data.pages
      });
      setSelectedBlock(null);
      setConsoleMsg({
        text: `Replaced ${data.replacements_made} instances of "${searchTerm}".`,
        type: 'success'
      });
    } catch (err: any) {
      setError(err.message);
    } finally {
      setIsLoading(false);
    }
  };

  // Run command line interpretations
  const handleExecuteCommand = async (commandStr: string) => {
    if (!session) return;
    setIsLoading(true);
    setError(null);

    try {
      const response = await fetch(`${API_BASE}/command/${session.session_id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: commandStr }),
      });

      const data = await response.json();
      if (!response.ok) throw new Error(data.message || 'Failed to run command.');

      setSession({
        ...session,
        pages: data.pages
      });
      setSelectedBlock(null);
      setConsoleMsg({ text: data.message, type: 'success' });
    } catch (err: any) {
      setConsoleMsg({ text: err.message, type: 'error' });
    } finally {
      setIsLoading(false);
    }
  };

  // Export and download PDF
  const handleExportPDF = () => {
    if (!session) return;
    window.open(`${API_BASE}/download/${session.session_id}`, '_blank');
  };

  // Local OCR completion callback
  const handleOCRComplete = (pageNum: number, ocrBlocks: any[]) => {
    if (!session) return;
    // Inject ocrBlocks into targeted page blocks list to enable dynamic typing overlay
    const updatedPages = session.pages.map((p) => {
      if (p.number === pageNum) {
        return {
          ...p,
          blocks: [...p.blocks, ...ocrBlocks]
        };
      }
      return p;
    });

    setSession({
      ...session,
      pages: updatedPages
    });
    setConsoleMsg({ text: 'OCR processing complete! Text is now editable.', type: 'success' });
  };

  return (
    <div className="app-container">
      {/* Header bar */}
      <header className="header">
        <div className="app-logo">
          <FileText size={22} style={{ color: 'var(--accent-light)' }} />
          <span>AeroPDF Editor</span>
        </div>

        {session && (
          <>
            <CommandConsole onExecuteCommand={handleExecuteCommand} isLoading={isLoading} />
            <button className="btn btn-primary" onClick={handleExportPDF}>
              <Download size={16} /> Export PDF
            </button>
          </>
        )}
      </header>

      {/* Main Workspace Router */}
      {!session ? (
        <div className="upload-overlay fade-in">
          <div style={{ textAlign: 'center', marginBottom: '32px' }}>
            <h1 style={{ fontSize: '2.5rem', fontWeight: 700, margin: '0 0 12px 0', background: 'var(--accent-gradient)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>
              Advanced In-Browser PDF Editor
            </h1>
            <p style={{ color: 'var(--text-secondary)', fontSize: '1.05rem', maxWidth: '500px', margin: '0 auto' }}>
              Upload, redact, edit, and run fast OCR text extractions directly in your viewport without losing formatting.
            </p>
          </div>

          <div
            className="dropzone"
            onClick={() => fileInputRef.current?.click()}
          >
            <UploadCloud className="dropzone-icon" />
            <h3 style={{ margin: '0 0 8px 0', fontSize: '1.15rem' }}>Drag & Drop PDF document</h3>
            <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem', margin: '0 0 20px 0' }}>or click to browse local files</p>
            <button className="btn btn-secondary" disabled={isLoading}>
              {isLoading ? 'Processing...' : 'Browse Documents'}
            </button>
            <input
              type="file"
              ref={fileInputRef}
              onChange={onFileChange}
              accept="application/pdf"
              style={{ display: 'none' }}
            />
          </div>

          {error && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--danger)', marginTop: '20px', background: 'rgba(239, 68, 68, 0.07)', padding: '10px 16px', borderRadius: '8px', border: '1px solid rgba(239, 68, 68, 0.2)' }}>
              <AlertCircle size={16} />
              <span style={{ fontSize: '0.9rem' }}>{error}</span>
            </div>
          )}
        </div>
      ) : (
        <div className="workspace-layout">
          {/* Sidebar */}
          <Sidebar
            pages={session.pages}
            activePage={activePage}
            setActivePage={(pageNum) => {
              setActivePage(pageNum);
              setSelectedBlock(null);
            }}
          />

          {/* Canvas Viewport */}
          <main className="canvas-viewport">
            {/* Status updates toast/status bar */}
            {consoleMsg.text && (
              <div style={{
                position: 'absolute',
                top: '20px',
                left: '50%',
                transform: 'translateX(-50%)',
                zIndex: 40,
                background: 'rgba(17, 24, 39, 0.85)',
                border: '1px solid var(--border-glass)',
                padding: '8px 16px',
                borderRadius: '8px',
                fontSize: '0.85rem',
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                boxShadow: '0 10px 25px rgba(0, 0, 0, 0.5)',
                color: consoleMsg.type === 'error' ? 'var(--danger)' : consoleMsg.type === 'success' ? 'var(--success)' : 'var(--text-primary)'
              }} className="fade-in">
                <Sparkles size={14} style={{ color: 'var(--accent-light)' }} />
                <span>{consoleMsg.text}</span>
                <button
                  onClick={() => setConsoleMsg({ text: '', type: null })}
                  style={{ background: 'transparent', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', marginLeft: '12px' }}
                >
                  ✕
                </button>
              </div>
            )}

            <PDFCanvas
              page={session.pages[activePage - 1]}
              pdfUrl={`${API_BASE}/download/${session.session_id}`}
              onSelectBlock={setSelectedBlock}
              onOCRComplete={handleOCRComplete}
            />
          </main>

          {/* Properties Panel */}
          <PropertiesPanel
            selectedBlock={selectedBlock}
            onSaveBlockEdits={handleSaveBlockEdits}
            onSearchReplace={handleSearchReplace}
            isLoading={isLoading}
          />
        </div>
      )}
    </div>
  );
}

export default App;
