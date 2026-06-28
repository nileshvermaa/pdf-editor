import React, { useState } from 'react';
import { X } from 'lucide-react';

interface PromptModalProps {
  title: string;
  label: string;
  defaultValue?: string;
  placeholder?: string;
  confirmLabel: string;
  hint?: string;
  isLoading: boolean;
  onConfirm: (value: string) => void;
  onClose: () => void;
}

/** Minimal single-field modal — used for watermark text and page-range extract. */
export const PromptModal: React.FC<PromptModalProps> = ({
  title,
  label,
  defaultValue = '',
  placeholder,
  confirmLabel,
  hint,
  isLoading,
  onConfirm,
  onClose,
}) => {
  const [value, setValue] = useState(defaultValue);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!value.trim() || isLoading) return;
    onConfirm(value.trim());
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-panel" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3><span>{title}</span></h3>
          <button onClick={onClose} className="modal-close-btn" aria-label="Close">
            <X size={14} />
          </button>
        </div>
        <form onSubmit={submit} className="modal-form">
          <label className="modal-label">
            {label}
            <input
              className="prop-input"
              autoFocus
              value={value}
              placeholder={placeholder}
              onChange={(e) => setValue(e.target.value)}
            />
          </label>
          {hint && <span className="prop-note">{hint}</span>}
          <button type="submit" className="download-btn" disabled={!value.trim() || isLoading}>
            {isLoading ? 'Working…' : confirmLabel}
          </button>
        </form>
      </div>
    </div>
  );
};
