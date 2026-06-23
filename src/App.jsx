import React, { useState, useRef } from 'react';
import JSZip from 'jszip';

// Convert base64 data to local Blob URLs for browser memory efficiency
const base64ToBlobUrl = (base64Data) => {
    try {
        const [prefix, bytes] = base64Data.split(',');
        const mimeType = prefix.match(/:(.*?);/)[1];
        const binaryStr = atob(bytes);
        const len = binaryStr.length;
        const u8arr = new Uint8Array(len);
        for (let i = 0; i < len; i++) {
            u8arr[i] = binaryStr.charCodeAt(i);
        }
        const blob = new Blob([u8arr], { type: mimeType });
        return URL.createObjectURL(blob);
    } catch (e) {
        console.error('Failed to convert base64 to blob url:', e);
        return base64Data; // fallback to original base64 if conversion fails
    }
};

const MAX_PRODUCTS = 6;
const MAX_TEMPLATES = 12;
const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:5000';

function App() {
    // State management
    const [productFiles, setProductFiles] = useState([]);
    const [templateFiles, setTemplateFiles] = useState([]);
    const [prompt, setPrompt] = useState('');
    const [statusText, setStatusText] = useState('Ready for synthesis');
    const [generating, setGenerating] = useState(false);
    const [outputs, setOutputs] = useState([]);

    // Lightbox modal state
    const [lightboxActive, setLightboxActive] = useState(false);
    const [lightboxSrc, setLightboxSrc] = useState('');

    // DOM Refs
    const productInputRef = useRef(null);
    const templateInputRef = useRef(null);

    // Get thumbnail previews (supports HEIC/AVIF placeholders)
    const getFilePreviewSrc = (file) => {
        const isHEIC = /\.(heic|heif)$/i.test(file.name);
        if (isHEIC) {
            return 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100" fill="none"><rect width="100" height="100" fill="%231e293b"/><text x="50" y="45" font-family="sans-serif" font-size="12" fill="%2394a3b8" font-weight="bold" text-anchor="middle">HEIC IMAGE</text><text x="50" y="65" font-family="sans-serif" font-size="8" fill="%2364748b" text-anchor="middle">iPhone Format</text></svg>';
        }
        return URL.createObjectURL(file);
    };

    const isValidImage = (file) => {
        return file.type.startsWith('image/') || /\.(heic|heif|avif)$/i.test(file.name);
    };

    // Product File Handlers
    const handleProductFiles = (files) => {
        if (productFiles.length >= MAX_PRODUCTS) {
            alert(`You can only upload up to ${MAX_PRODUCTS} product images.`);
            return;
        }
        const remaining = MAX_PRODUCTS - productFiles.length;
        const validList = Array.from(files).filter(isValidImage).slice(0, remaining);
        setProductFiles(prev => [...prev, ...validList]);
    };

    const removeProductFile = (index) => {
        setProductFiles(prev => prev.filter((_, idx) => idx !== index));
    };

    // Template File Handlers
    const handleTemplateFiles = (files) => {
        if (templateFiles.length >= MAX_TEMPLATES) {
            alert(`You can only upload up to ${MAX_TEMPLATES} template images.`);
            return;
        }
        const remaining = MAX_TEMPLATES - templateFiles.length;
        const validList = Array.from(files).filter(isValidImage).slice(0, remaining);
        setTemplateFiles(prev => [...prev, ...validList]);
    };

    const removeTemplateFile = (index) => {
        setTemplateFiles(prev => prev.filter((_, idx) => idx !== index));
    };

    // Drag-over animations
    const handleDragOver = (e) => {
        e.preventDefault();
        e.currentTarget.classList.add('dragover');
    };

    const handleDragLeave = (e) => {
        e.preventDefault();
        e.currentTarget.classList.remove('dragover');
    };

    // Form Submission & NDJSON Stream Processing
    const handleGenerate = async (e) => {
        e.preventDefault();

        if (productFiles.length === 0) {
            alert('Please upload at least one raw product image.');
            return;
        }
        if (templateFiles.length === 0) {
            alert('Please upload at least one reference template.');
            return;
        }

        // Revoke any existing blob URLs to prevent memory leaks
        outputs.forEach(item => {
            if (item.status === 'success' && item.image && item.image.startsWith('blob:')) {
                URL.revokeObjectURL(item.image);
            }
        });

        setGenerating(true);
        setStatusText('Allocating worker threads...');
        
        // Setup slot skeletons
        const initialSlots = templateFiles.map((_, idx) => ({
            index: idx,
            status: 'skeleton'
        }));
        setOutputs(initialSlots);

        // Prep multipart form data
        const formData = new FormData();
        formData.append('prompt', prompt);
        productFiles.forEach(file => {
            formData.append('product_images', file);
        });
        templateFiles.forEach(file => {
            formData.append('template_images', file);
        });

        try {
            // Point to backend API
            const response = await fetch(`${API_URL}/generate`, {
                method: 'POST',
                body: formData
            });

            if (!response.ok) {
                const errData = await response.json().catch(() => ({}));
                throw new Error(errData.message || `Server returned error status ${response.status}`);
            }

            const reader = response.body.getReader();
            const decoder = new TextDecoder('utf-8');
            let buffer = '';

            setStatusText('Processing templates in batches of 3...');

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop(); // Retain partial lines in buffer

                for (const line of lines) {
                    if (line.trim() === '') continue;
                    try {
                        let chunk = JSON.parse(line);
                        if (chunk.status === 'success' && chunk.image && chunk.image.startsWith('data:')) {
                            chunk.image = base64ToBlobUrl(chunk.image);
                        }
                        setOutputs(prev => prev.map(item => item.index === chunk.index ? chunk : item));
                    } catch (err) {
                        console.error('Error parsing NDJSON chunk:', err);
                    }
                }
            }

            if (buffer.trim() !== '') {
                try {
                    let chunk = JSON.parse(buffer);
                    if (chunk.status === 'success' && chunk.image && chunk.image.startsWith('data:')) {
                        chunk.image = base64ToBlobUrl(chunk.image);
                    }
                    setOutputs(prev => prev.map(item => item.index === chunk.index ? chunk : item));
                } catch (err) {
                    console.error('Error parsing final chunk:', err);
                }
            }

            // Check errors
            setOutputs(currOutputs => {
                const hasErrors = currOutputs.some(item => item.status === 'error');
                setStatusText(hasErrors ? 'Synthesis complete (some variations failed)' : 'Synthesis complete!');
                return currOutputs;
            });

        } catch (err) {
            console.error('Connection failed:', err);
            setStatusText('Failed to stage jewelry renders.');
            setOutputs(prev => prev.map(item => 
                item.status === 'skeleton' 
                    ? { ...item, status: 'error', message: err.message || 'Stream connection lost.' } 
                    : item
            ));
        } finally {
            setGenerating(false);
        }
    };

    // Pack all completed renders into a single ZIP file for downloading
    const handleDownloadAll = async () => {
        const successfulOutputs = outputs.filter(item => item.status === 'success');
        if (successfulOutputs.length === 0) return;

        setGenerating(true);
        setStatusText('Creating ZIP archive...');

        try {
            const zip = new JSZip();
            
            // Fetch and append each Blob Object URL into the zip archive
            for (const item of successfulOutputs) {
                const response = await fetch(item.image);
                const blob = await response.blob();
                zip.file(`jwele_star_render_${item.index + 1}.png`, blob);
            }

            const zipBlob = await zip.generateAsync({ type: 'blob' });
            const downloadUrl = URL.createObjectURL(zipBlob);
            
            const link = document.createElement('a');
            link.href = downloadUrl;
            link.download = 'jwele_star_renderings.zip';
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            URL.revokeObjectURL(downloadUrl);
            
            setStatusText('Download completed!');
        } catch (err) {
            console.error('Failed to create ZIP package:', err);
            setStatusText('Failed to download archive.');
        } finally {
            setGenerating(false);
        }
    };

    // Regenerate a single specific slot image
    const handleRegenerateSingle = async (targetIndex) => {
        if (generating) return;

        // Revoke the existing blob URL for this specific slot to free memory
        const targetOutput = outputs.find(item => item.index === targetIndex);
        if (targetOutput && targetOutput.image && targetOutput.image.startsWith('blob:')) {
            URL.revokeObjectURL(targetOutput.image);
        }

        setGenerating(true);
        setStatusText(`Regenerating slot ${targetIndex + 1}...`);

        // Set just this specific slot back to skeleton
        setOutputs(prev => prev.map(item => 
            item.index === targetIndex 
                ? { index: targetIndex, status: 'skeleton' } 
                : item
        ));

        const formData = new FormData();
        formData.append('prompt', prompt);
        formData.append('target_index', targetIndex.toString());
        
        // Append all product images
        productFiles.forEach(file => {
            formData.append('product_images', file);
        });
        
        // Append ONLY the target template image
        formData.append('template_images', templateFiles[targetIndex]);

        try {
            const response = await fetch(`${API_URL}/generate`, {
                method: 'POST',
                body: formData
            });

            if (!response.ok) {
                const errData = await response.json().catch(() => ({}));
                throw new Error(errData.message || `Server returned error status ${response.status}`);
            }

            const reader = response.body.getReader();
            const decoder = new TextDecoder('utf-8');
            let buffer = '';

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop();

                for (const line of lines) {
                    if (line.trim() === '') continue;
                    try {
                        let chunk = JSON.parse(line);
                        if (chunk.status === 'success' && chunk.image && chunk.image.startsWith('data:')) {
                            chunk.image = base64ToBlobUrl(chunk.image);
                        }
                        setOutputs(prev => prev.map(item => item.index === chunk.index ? chunk : item));
                    } catch (err) {
                        console.error('Error parsing NDJSON chunk:', err);
                    }
                }
            }

            if (buffer.trim() !== '') {
                try {
                    let chunk = JSON.parse(buffer);
                    if (chunk.status === 'success' && chunk.image && chunk.image.startsWith('data:')) {
                        chunk.image = base64ToBlobUrl(chunk.image);
                    }
                    setOutputs(prev => prev.map(item => item.index === chunk.index ? chunk : item));
                } catch (err) {
                    console.error('Error parsing final chunk:', err);
                }
            }

            // Update status text
            setOutputs(currOutputs => {
                const hasErrors = currOutputs.some(item => item.status === 'error');
                setStatusText(hasErrors ? 'Synthesis complete (some variations failed)' : 'Synthesis complete!');
                return currOutputs;
            });

        } catch (err) {
            console.error('Regeneration failed:', err);
            setOutputs(prev => prev.map(item => 
                item.index === targetIndex 
                    ? { index: targetIndex, status: 'error', message: err.message || 'Stream connection lost.' } 
                    : item
            ));
            setStatusText('Regeneration failed.');
        } finally {
            setGenerating(false);
        }
    };

    // Open full image
    const openLightbox = (imgSrc) => {
        setLightboxSrc(imgSrc);
        setLightboxActive(true);
    };

    const closeLightbox = () => {
        setLightboxActive(false);
        setLightboxSrc('');
    };

    const isCustomPromptActive = prompt.trim() !== '';

    return (
        <React.Fragment>
            <div className="glow-backdrop"></div>
            
            <div className="app-container">
                {/* Header */}
                <header className="app-header">
                    <div className="brand">
                        <h1>Jwele<span>Star</span></h1>
                    </div>
                    <p className="subtitle">AI-Powered Jewelry Staging & Image Synthesis</p>
                </header>

                {/* Main Content */}
                <main className="app-main">
                    {/* Left: Configuration Form */}
                    <section className="controls-panel card">
                        <div className="section-title">
                            <span className="step-num">1</span>
                            <h2>Input Media</h2>
                        </div>
                        
                        {/* Zone A: Product Uploads */}
                        <div className="upload-container">
                            <div className="upload-label-row">
                                <label className="upload-section-title">
                                    1. Raw Product Images <span className="badge badge-info">{productFiles.length} / {MAX_PRODUCTS}</span>
                                </label>
                            </div>
                            <div 
                                className="upload-dropzone" 
                                onDragOver={handleDragOver}
                                onDragLeave={handleDragLeave}
                                onDrop={(e) => {
                                    e.preventDefault();
                                    e.currentTarget.classList.remove('dragover');
                                    handleProductFiles(e.dataTransfer.files);
                                }}
                            >
                                <input 
                                    type="file" 
                                    ref={productInputRef}
                                    multiple 
                                    accept="image/*" 
                                    className="file-input-hidden" 
                                    onChange={(e) => handleProductFiles(e.target.files)}
                                />
                                <svg className="upload-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" stroke-linecap="round" stroke-linejoin="round">
                                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                                    <polyline points="17 8 12 3 7 8"></polyline>
                                    <line x1="12" y1="3" x2="12" y2="15"></line>
                                </svg>
                                <p className="upload-text">Drag & drop raw product photos</p>
                                <p className="upload-subtext" style={{ color: productFiles.length > 0 ? 'var(--emerald)' : 'var(--text-muted)' }}>
                                    {productFiles.length > 0 ? `${productFiles.length} files selected` : `Max ${MAX_PRODUCTS} images (JPG, PNG, HEIC, AVIF)`}
                                </p>
                                <button type="button" className="btn btn-secondary" onClick={() => productInputRef.current.click()}>Browse Products</button>
                            </div>
                            
                            {productFiles.length > 0 && (
                                <div className="previews-grid">
                                    {productFiles.map((file, idx) => (
                                        <div className="preview-card" key={idx}>
                                            <img src={getFilePreviewSrc(file)} alt={file.name} />
                                            <button className="preview-remove-btn" onClick={() => removeProductFile(idx)}>&times;</button>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>

                        <div className="divider-small"></div>

                        {/* Zone B: Template Uploads */}
                        <div className="upload-container">
                            <div className="upload-label-row">
                                <label className="upload-section-title">
                                    2. Reference Templates <span className="badge badge-info">{templateFiles.length} / {MAX_TEMPLATES}</span>
                                </label>
                            </div>
                            <div 
                                className="upload-dropzone" 
                                onDragOver={handleDragOver}
                                onDragLeave={handleDragLeave}
                                onDrop={(e) => {
                                    e.preventDefault();
                                    e.currentTarget.classList.remove('dragover');
                                    handleTemplateFiles(e.dataTransfer.files);
                                }}
                            >
                                <input 
                                    type="file" 
                                    ref={templateInputRef}
                                    multiple 
                                    accept="image/*" 
                                    className="file-input-hidden" 
                                    onChange={(e) => handleTemplateFiles(e.target.files)}
                                />
                                <svg className="upload-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                                    <polyline points="17 8 12 3 7 8"></polyline>
                                    <line x1="12" y1="3" x2="12" y2="15"></line>
                                </svg>
                                <p className="upload-text">Drag & drop template backgrounds</p>
                                <p className="upload-subtext" style={{ color: templateFiles.length > 0 ? 'var(--emerald)' : 'var(--text-muted)' }}>
                                    {templateFiles.length > 0 ? `${templateFiles.length} templates selected` : `Max ${MAX_TEMPLATES} images (JPG, PNG, HEIC, AVIF)`}
                                </p>
                                <button type="button" className="btn btn-secondary" onClick={() => templateInputRef.current.click()}>Browse Templates</button>
                            </div>
                            
                            {templateFiles.length > 0 && (
                                <div className="previews-grid">
                                    {templateFiles.map((file, idx) => (
                                        <div className="preview-card" key={idx}>
                                            <img src={getFilePreviewSrc(file)} alt={file.name} />
                                            <button className="preview-remove-btn" onClick={() => removeTemplateFile(idx)}>&times;</button>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>

                        <div className="divider"></div>

                        <div className="section-title">
                            <span className="step-num">2</span>
                            <h2>Configuration</h2>
                        </div>

                        <form onSubmit={handleGenerate}>
                            <div className="form-group">
                                <div className="form-label-row">
                                    <label htmlFor="prompt-textarea">Staging Prompt <span className="label-optional">(Optional)</span></label>
                                    <span className={`badge ${isCustomPromptActive ? 'badge-custom' : 'badge-info'}`}>
                                        {isCustomPromptActive ? 'Custom Prompt Enabled' : 'Default Jewelry Staging Enabled'}
                                    </span>
                                </div>
                                <textarea 
                                    id="prompt-textarea" 
                                    rows="5" 
                                    value={prompt}
                                    onChange={(e) => setPrompt(e.target.value)}
                                    placeholder="Describe the rendering scene. If left empty, Jwele-Star will automatically apply the default high-precision ring replacement instruction..."
                                />
                            </div>

                            <button type="submit" className={`btn btn-primary btn-generate ${generating ? 'loading' : ''}`} disabled={generating}>
                                <span>{generating ? 'Synthesizing...' : 'Generate Renderings'}</span>
                                <div className="btn-glow"></div>
                            </button>
                        </form>
                    </section>

                    {/* Right: Synthesis Output Gallery */}
                    <section className="gallery-panel card">
                        <div className="gallery-header">
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                                <h2>Generated Renders</h2>
                                <div className="gallery-status" style={{ color: statusText.includes('failed') || statusText.includes('Failed') ? 'var(--error)' : statusText.includes('complete') ? 'var(--emerald)' : 'var(--blue)' }}>
                                    {statusText}
                                </div>
                            </div>
                            {outputs.some(item => item.status === 'success') && (
                                <button onClick={handleDownloadAll} className="btn btn-primary" style={{ padding: '0.5rem 1rem', fontSize: '0.85rem' }}>
                                    <svg className="download-icon-svg" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="14" height="14" style={{ marginRight: '6px' }}>
                                        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                                        <polyline points="7 10 12 15 17 10"></polyline>
                                        <line x1="12" y1="15" x2="12" y2="3"></line>
                                    </svg>
                                    Download All
                                </button>
                            )}
                        </div>

                        <div className="outputs-grid">
                            {outputs.length === 0 ? (
                                <div className="gallery-empty-state">
                                    <svg className="empty-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round">
                                        <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
                                        <circle cx="8.5" cy="8.5" r="1.5"></circle>
                                        <polyline points="21 15 16 10 5 21"></polyline>
                                    </svg>
                                    <p>Generate variations to view synthetic renderings here</p>
                                    <span>Outputs are generated for each Reference Template (up to 12) at 2K resolution (1:1 ratio) in parallel batches of 3</span>
                                </div>
                            ) : (
                                outputs.map((slot) => (
                                    <div className={`render-slot ${slot.status === 'skeleton' ? 'skeleton' : ''}`} key={slot.index}>
                                        {slot.status === 'skeleton' && (
                                            <div className="skeleton-spinner">
                                                <div className="spinner-ring"></div>
                                                <span className="spinner-text">Staging Template {slot.index + 1}</span>
                                            </div>
                                        )}
                                        
                                        {slot.status === 'success' && (
                                            <div className="render-success-wrapper">
                                                <img 
                                                    src={slot.image} 
                                                    alt={`Staged Render ${slot.index + 1}`} 
                                                    className="render-img loaded"
                                                />
                                                <div className="render-actions-overlay">
                                                    <button onClick={() => openLightbox(slot.image)} className="action-btn" title="View Fullscreen">
                                                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="18" height="18">
                                                            <circle cx="11" cy="11" r="8"></circle>
                                                            <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
                                                        </svg>
                                                    </button>
                                                    <button onClick={() => handleRegenerateSingle(slot.index)} className="action-btn" title="Regenerate This Image" disabled={generating}>
                                                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="18" height="18">
                                                            <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"></path>
                                                        </svg>
                                                    </button>
                                                    <a href={slot.image} download={`jwele_star_render_${slot.index + 1}.png`} className="action-btn" title="Download Image">
                                                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="18" height="18">
                                                            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                                                            <polyline points="7 10 12 15 17 10"></polyline>
                                                            <line x1="12" y1="15" x2="12" y2="3"></line>
                                                        </svg>
                                                    </a>
                                                </div>
                                            </div>
                                        )}

                                        {slot.status === 'error' && (
                                            <div className="render-error-container">
                                                <svg className="render-error-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                                    <circle cx="12" cy="12" r="10"></circle>
                                                    <line x1="12" y1="8" x2="12" y2="12"></line>
                                                    <line x1="12" y1="16" x2="12.01" y2="16"></line>
                                                </svg>
                                                <div className="render-error-text">{slot.message || 'Generation failed.'}</div>
                                                <button onClick={() => handleRegenerateSingle(slot.index)} className="btn btn-retry-slot" disabled={generating}>
                                                    Retry Synthesis
                                                </button>
                                            </div>
                                        )}
                                    </div>
                                ))
                            )}
                        </div>
                    </section>
                </main>
            </div>

            {/* Lightbox viewport */}
            <div className={`lightbox-modal ${lightboxActive ? 'active' : ''}`} onClick={(e) => e.target.id === 'lightbox' && closeLightbox()} id="lightbox">
                <button className="lightbox-close" onClick={closeLightbox}>&times;</button>
                <div className="lightbox-content">
                    {lightboxSrc && <img src={lightboxSrc} alt="Full resolution synthesis" />}
                    <div className="lightbox-actions">
                        {lightboxSrc && (
                            <a href={lightboxSrc} download="jwele_star_render.png" className="btn btn-primary">
                                <svg className="download-icon-svg" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="16" height="16">
                                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                                    <polyline points="7 10 12 15 17 10"></polyline>
                                    <line x1="12" y1="15" x2="12" y2="3"></line>
                                </svg>
                                Download 2K Image
                            </a>
                        )}
                    </div>
                </div>
            </div>
        </React.Fragment>
    );
}

export default App;
