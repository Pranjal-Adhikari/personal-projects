/* ===================================
   CONFIGURATION & CONSTANTS
   =================================== */
const CONFIG = {
  MAX_UNDO_STEPS: 20,
  TEXT_MODIFY_DEBOUNCE: 500,
  HANDLE_SIZE: 10,
  ROTATE_HANDLE_OFFSET: 30,
  DEFAULT_TEXT: "Double-click to edit",
  STROKE_QUALITY: 8,
  MIN_TEXT_WIDTH: 60,
  MIN_TEXT_HEIGHT: 30
};

const ACTION_LABELS = {
  initial: 'Initial State',
  brush: 'Brush Stroke',
  'text-create': 'Create Text',
  'text-delete': 'Delete Text',
  'text-modify': 'Modify Text',
  'text-duplicate': 'Duplicate Text'
};

/* ===================================
   DOM HELPERS & GLOBALS
   =================================== */
const $ = id => document.getElementById(id);
const $$ = sel => document.querySelectorAll(sel);

const canvasWrapper = $("canvasWrapper");
const emptyState = $("emptyState");
const [imageCanvas, editCanvas] = [$("imageCanvas"), $("editCanvas")];
const [ctxImage, ctxEdit] = [imageCanvas.getContext("2d"), editCanvas.getContext("2d")];
const loadingOverlay = $("loadingOverlay");

const textBoxes = new Set();

const state = {
  tool: "brush",
  drawing: false,
  brushSize: 20,
  brushColor: "#ffffff",
  eraserSize: 20,
  currentTextBox: null,
  undoStack: [],
  redoStack: [],
  modifyTimeout: null,
  imageLoaded: false,
  currentImageURL: null,
  pages: [],
  currentPageIndex: 0
};

/* ===================================
   UTILITY FUNCTIONS
   =================================== */
const debounce = (fn, delay) => {
  let timeout;
  return (...args) => {
    clearTimeout(timeout);
    timeout = setTimeout(() => fn(...args), delay);
  };
};

const enableTools = (enabled) => {
  ['brushBtn', 'eraserBtn', 'textBtn', 'exportBtn', 'exportCurrentBtn', 'exportAllBtn'].forEach(id => {
    $(id).disabled = !enabled;
  });
};

/* ===================================
   UNDO/REDO SYSTEM
   =================================== */
const saveState = action => {
  const currentUndoStack = state.undoStack;
  
  currentUndoStack.push({
    action,
    timestamp: Date.now(),
    editCanvas: ctxEdit.getImageData(0, 0, editCanvas.width, editCanvas.height),
    textBoxes: Array.from(textBoxes).map(box => ({
      id: box.dataset.id,
      left: parseFloat(box.style.left),
      top: parseFloat(box.style.top),
      width: parseFloat(box.style.width),
      height: parseFloat(box.style.height),
      fontSize: parseInt(box.style.fontSize),
      fontFamily: box.style.fontFamily,
      lineHeight: box.style.lineHeight,
      rotation: box._rotation,
      text: box.querySelector('.textbox-content')?.innerText || '',
      textColor: box._textColor || "#000000",
      strokeColor: box._strokeColor || "#ffffff",
      strokeWidth: box._strokeWidth || 0,
      bold: box._bold || false,
      italic: box._italic || false
    }))
  });
  
  if (currentUndoStack.length > CONFIG.MAX_UNDO_STEPS) {
    currentUndoStack.shift();
  }
  
  state.redoStack = [];
  
  if (state.pages.length > 0 && state.pages[state.currentPageIndex]) {
    state.pages[state.currentPageIndex].undoStack = currentUndoStack;
    state.pages[state.currentPageIndex].redoStack = [];
  }
  
  updateUndoRedoButtons();
  updateHistoryLog();
};

const undo = () => {
  if (state.undoStack.length <= 1) return;
  state.redoStack.push(state.undoStack.pop());
  restoreState(state.undoStack[state.undoStack.length - 1]);
  updateUndoRedoButtons();
  updateHistoryLog();
};

const redo = () => {
  if (!state.redoStack.length) return;
  const nextState = state.redoStack.pop();
  state.undoStack.push(nextState);
  restoreState(nextState);
  updateUndoRedoButtons();
  updateHistoryLog();
};

const restoreState = s => {
  ctxEdit.putImageData(s.editCanvas, 0, 0);
  
  textBoxes.forEach(box => box.remove());
  textBoxes.clear();
  state.currentTextBox = null;
  
  s.textBoxes.forEach(data => createTextBox(data, false));
};

const updateUndoRedoButtons = () => {
  $("undoBtn").disabled = state.undoStack.length <= 1;
  $("redoBtn").disabled = !state.redoStack.length;
};

const updateHistoryLog = () => {
  const log = $("historyLog");
  const items = [...state.undoStack].reverse();
  
  log.innerHTML = items.length 
    ? items.map((s, i) =>
        `<div class="history-item ${i === 0 ? 'current' : ''}" data-index="${i}">
          <div class="action-type">${ACTION_LABELS[s.action] || s.action}</div>
          <div class="timestamp">${new Date(s.timestamp).toLocaleTimeString()}</div>
        </div>`
      ).join('')
    : '<div style="color: #999; font-size: 11px; padding: 8px;">No history yet</div>';
};

$("historyLog").addEventListener('click', e => {
  const item = e.target.closest('.history-item');
  if (item) {
    const steps = parseInt(item.dataset.index);
    for (let i = 0; i < steps; i++) undo();
  }
});

/* ===================================
   TAB SWITCHING
   =================================== */
const switchToTab = tabName => {
  $$('.tab-btn').forEach(btn => btn.classList.toggle('active', btn.dataset.tab === tabName));
  $$('.tab-content').forEach(content => content.classList.toggle('active', content.id === tabName + 'Tab'));
  
  if (tabName === 'brush' && state.tool !== 'brush') setTool('brush');
  else if (tabName === 'eraser' && state.tool !== 'eraser') setTool('eraser');
  else if (tabName === 'text' && state.tool !== 'text') activateTextTool();
  else if (tabName === 'layers') setTool('none');
};

$$('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    if (btn.classList.contains('active') && btn.dataset.tab !== 'layers') {
      switchToTab('layers');
    } else {
      switchToTab(btn.dataset.tab);
    }
  });
});

/* ===================================
   IMAGE UPLOAD
   =================================== */
$("uploadBtn").addEventListener('click', () => $("fileInput").click());

$("fileInput").addEventListener('change', e => {
  const file = e.target.files[0];
  if (!file) return;
  
  if (state.currentImageURL) {
    URL.revokeObjectURL(state.currentImageURL);
  }
  
  const img = new Image();
  img.onload = () => {
    // Limit canvas size to reduce memory
    const MAX_DIMENSION = 4096;
    let width = img.width;
    let height = img.height;
    
    if (width > MAX_DIMENSION || height > MAX_DIMENSION) {
      const scale = Math.min(MAX_DIMENSION / width, MAX_DIMENSION / height);
      width = Math.floor(width * scale);
      height = Math.floor(height * scale);
    }
    
    if (state.imageLoaded && state.pages.length > 0) {
      saveCurrentPageState();
    }
    
    imageCanvas.width = editCanvas.width = width;
    imageCanvas.height = editCanvas.height = height;
    
    ctxImage.drawImage(img, 0, 0, width, height);
    ctxEdit.clearRect(0, 0, width, height);
    
    textBoxes.forEach(box => box.remove());
    textBoxes.clear();
    state.currentTextBox = null;
    
    state.undoStack = [];
    state.redoStack = [];
    
    const pageData = {
      imageData: ctxImage.getImageData(0, 0, width, height),
      width: width,
      height: height,
      undoStack: [],
      redoStack: [],
      editCanvas: ctxEdit.getImageData(0, 0, width, height),
      textBoxes: []
    };
    
    if (state.pages.length === 0) {
      state.pages.push(pageData);
      state.currentPageIndex = 0;
      state.imageLoaded = true;
    } else {
      state.pages[state.currentPageIndex] = pageData;
    }
    
    saveState('initial');
    
    emptyState.style.display = 'none';
    canvasWrapper.style.display = 'inline-block';
    
    enableTools(true);
    updatePageControls();
    
    setTimeout(() => {
      const container = $('centerArea');
      const wrapperWidth = width + 40;
      if (wrapperWidth > container.clientWidth) {
        container.scrollLeft = (wrapperWidth - container.clientWidth) / 2;
      }
    }, 50);
    
    URL.revokeObjectURL(state.currentImageURL);
    state.currentImageURL = null;
  };
  
  state.currentImageURL = URL.createObjectURL(file);
  img.src = state.currentImageURL;
});

/* ===================================
   BRUSH/ERASER TOOLS
   =================================== */
const setTool = (tool, skipTabSwitch = false) => {
  state.tool = tool;
  ['brushBtn', 'eraserBtn', 'textBtn'].forEach(id => {
    $(id).classList.toggle('active', id === tool + 'Btn');
  });
  
  if (tool === "text" && state.imageLoaded) {
    editCanvas.style.cursor = "crosshair";
    $("brushCursor").style.display = "none";
  } else if (tool === "brush" || tool === "eraser") {
    updateBrushCursor();
  } else {
    editCanvas.style.cursor = "default";
    $("brushCursor").style.display = "none";
  }
  
  if (!skipTabSwitch && tool !== 'none') switchToTab(tool);
};

$("brushBtn").addEventListener('click', () => {
  if (state.tool === 'brush') {
    switchToTab('layers');
  } else {
    setTool('brush');
  }
});

$("eraserBtn").addEventListener('click', () => {
  if (state.tool === 'eraser') {
    switchToTab('layers');
  } else {
    setTool('eraser');
  }
});

const updateBrushCursor = () => {
  const size = state.tool === "eraser" ? state.eraserSize : state.brushSize;
  const cursor = $("brushCursor");
  cursor.style.width = cursor.style.height = size + "px";
};

editCanvas.addEventListener('pointerdown', e => {
  if (!state.imageLoaded || (state.tool !== "brush" && state.tool !== "eraser")) return;
  
  state.drawing = true;
  const size = state.tool === "eraser" ? state.eraserSize : state.brushSize;
  
  ctxEdit.lineWidth = size;
  ctxEdit.lineCap = "round";
  ctxEdit.lineJoin = "round";
  ctxEdit.globalCompositeOperation = state.tool === "eraser" ? "destination-out" : "source-over";
  
  if (state.tool === "brush") {
    ctxEdit.strokeStyle = state.brushColor;
  }
  
  ctxEdit.beginPath();
  ctxEdit.moveTo(e.offsetX, e.offsetY);
  ctxEdit.lineTo(e.offsetX, e.offsetY);
  ctxEdit.stroke();
});

editCanvas.addEventListener('pointermove', e => {
  if (state.drawing && (state.tool === "brush" || state.tool === "eraser")) {
    ctxEdit.lineTo(e.offsetX, e.offsetY);
    ctxEdit.stroke();
  }
});

const endDrawing = () => {
  if (state.drawing) {
    saveState('brush');
  }
  state.drawing = false;
};

editCanvas.addEventListener('pointerup', endDrawing);
editCanvas.addEventListener('pointerleave', endDrawing);

$("brushSizeInput").addEventListener('input', e => {
  state.brushSize = parseInt(e.target.value);
  $("brushSizeValue").textContent = e.target.value;
  if (state.tool === "brush") updateBrushCursor();
});

$("eraserSizeInput").addEventListener('input', e => {
  state.eraserSize = parseInt(e.target.value);
  $("eraserSizeValue").textContent = e.target.value;
  if (state.tool === "eraser") updateBrushCursor();
});

$("brushColorInput").addEventListener('input', e => {
  state.brushColor = e.target.value;
});

editCanvas.addEventListener('mouseenter', () => {
  if (!state.imageLoaded) return;
  if (state.tool === "brush" || state.tool === "eraser") {
    $("brushCursor").style.display = "block";
    editCanvas.style.cursor = "none";
  } else if (state.tool === "text") {
    editCanvas.style.cursor = "crosshair";
  }
});

editCanvas.addEventListener('mouseleave', () => {
  $("brushCursor").style.display = "none";
  if (state.tool === "text") {
    editCanvas.style.cursor = "crosshair";
  } else {
    editCanvas.style.cursor = "default";
  }
});

editCanvas.addEventListener('mousemove', e => {
  if (!state.imageLoaded) return;
  if (state.tool === "brush" || state.tool === "eraser") {
    const rect = editCanvas.getBoundingClientRect();
    const cursor = $("brushCursor");
    cursor.style.left = (e.clientX - rect.left) + "px";
    cursor.style.top = (e.clientY - rect.top) + "px";
  }
});

/* ===================================
   TEXT TOOL - HELPER FUNCTIONS
   =================================== */
const applyFontStyle = box => {
  box.style.fontWeight = box._bold ? "bold" : "normal";
  box.style.fontStyle = box._italic ? "italic" : "normal";
};

const applyTextStroke = box => {
  box.style.color = box._textColor;
  if (box._strokeWidth > 0) {
    const shadows = [];
    for (let i = 0; i < CONFIG.STROKE_QUALITY; i++) {
      const angle = (i / CONFIG.STROKE_QUALITY) * Math.PI * 2;
      const x = (Math.cos(angle) * box._strokeWidth).toFixed(2);
      const y = (Math.sin(angle) * box._strokeWidth).toFixed(2);
      shadows.push(`${x}px ${y}px 0 ${box._strokeColor}`);
    }
    box.style.textShadow = shadows.join(', ');
  } else {
    box.style.textShadow = "none";
  }
};

const renderTextWithStroke = (ctx, text, x, y, textColor, strokeColor, strokeWidth) => {
  if (strokeWidth > 0) {
    ctx.lineWidth = strokeWidth * 2;
    ctx.strokeStyle = strokeColor;
    ctx.strokeText(text, x, y);
  }
  ctx.fillStyle = textColor;
  ctx.fillText(text, x, y);
};

const setCurrentTextBox = (box, updateSidebar = true) => {
  if (state.currentTextBox) {
    state.currentTextBox.classList.remove("selected");
  }
  
  state.currentTextBox = box;
  
  if (!box) return;
  
  box.classList.add("selected");
  
  if (updateSidebar) {
    $("textInput").value = box.querySelector('.textbox-content')?.innerText || '';
    $("fontSizeInput").value = parseInt(box.style.fontSize);
    $("fontFamilySel").value = box.style.fontFamily.replace(/['"]/g, "");
    $("lineHeightInput").value = parseFloat(box.style.lineHeight);
    $("rotateInput").value = Math.round(box._rotation);
    $("textColorInput").value = box._textColor || "#000000";
    $("strokeColorInput").value = box._strokeColor || "#ffffff";
    $("strokeWidthInput").value = box._strokeWidth || 0;
    $("boldCheck").checked = box._bold || false;
    $("italicCheck").checked = box._italic || false;
  }
};

/* ===================================
   TEXT TOOL - CREATE TEXT BOX
   =================================== */
const activateTextTool = () => {
  state.tool = "text";
  ['brushBtn', 'eraserBtn', 'textBtn'].forEach(id => {
    $(id).classList.toggle('active', id === 'textBtn');
  });
  if (state.imageLoaded) editCanvas.style.cursor = "crosshair";
  $("brushCursor").style.display = "none";
};

$("textBtn").addEventListener('click', () => {
  if (state.tool === 'text') {
    switchToTab('layers');
  } else {
    activateTextTool();
    switchToTab('text');
  }
});

editCanvas.addEventListener('click', e => {
  if (!state.imageLoaded) return;
  if (state.tool === "text") {
    createTextBox({ left: e.offsetX - 70, top: e.offsetY - 30 });
  }
});

const createTextBox = (opts = {}, shouldSaveState = true) => {
  const box = document.createElement("div");
  box.className = "textbox";
  box.dataset.id = opts.id || `text_${Date.now()}_${Math.random()}`;
  
  Object.assign(box.style, {
    left: (opts.left || 50) + "px",
    top: (opts.top || 50) + "px",
    width: (opts.width || 140) + "px",
    height: (opts.height || 60) + "px",
    fontSize: (opts.fontSize || 24) + "px",
    fontFamily: opts.fontFamily || "Arial",
    lineHeight: opts.lineHeight || "1.2",
    transform: `rotate(${opts.rotation || 0}deg)`
  });
  
  Object.assign(box, {
    _textColor: opts.textColor || "#000000",
    _strokeColor: opts.strokeColor || "#ffffff",
    _strokeWidth: opts.strokeWidth || 0,
    _bold: opts.bold || false,
    _italic: opts.italic || false,
    _rotation: opts.rotation || 0
  });
  
  applyFontStyle(box);
  applyTextStroke(box);
  
  const textContent = document.createElement("div");
  textContent.className = "textbox-content";
  textContent.contentEditable = true;
  textContent.innerText = opts.text || CONFIG.DEFAULT_TEXT;
  textContent.style.cssText = "width: 100%; height: 100%; outline: none;";
  box.appendChild(textContent);
  
  ["nw","n","ne","e","se","s","sw","w"].forEach(h => {
    const handle = document.createElement("div");
    handle.className = `handle ${h}`;
    box.appendChild(handle);
  });
  
  const rotateHandle = document.createElement("div");
  rotateHandle.className = "rotate-handle";
  box.appendChild(rotateHandle);
  
  canvasWrapper.appendChild(box);
  textBoxes.add(box);
  setCurrentTextBox(box);
  
  setupTextBoxInteraction(box);
  
  textContent.addEventListener('blur', () => {
    if (shouldSaveState) saveState('text-modify');
  });
  
  textContent.addEventListener('focus', () => {
    setCurrentTextBox(box);
    if (state.tool !== 'text') {
      state.tool = 'text';
      ['brushBtn', 'eraserBtn', 'textBtn'].forEach(id => {
        $(id).classList.toggle('active', id === 'textBtn');
      });
    }
    switchToTab('text');
  });
  
  if (shouldSaveState) saveState('text-create');
  return box;
};

const setupTextBoxInteraction = (box) => {
  let dragging = false, resizing = false, rotating = false;
  let activeHandle = null, start = null, hasMoved = false;
  
  const onMove = e => {
    if (!start) return;
    
    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;
    hasMoved = true;
    
    if (dragging) {
      box.style.left = (start.left + dx) + "px";
      box.style.top = (start.top + dy) + "px";
    }
    
    if (resizing) {
      if (activeHandle.includes("e")) {
        box.style.width = Math.max(CONFIG.MIN_TEXT_WIDTH, start.width + dx) + "px";
      }
      if (activeHandle.includes("s")) {
        box.style.height = Math.max(CONFIG.MIN_TEXT_HEIGHT, start.height + dy) + "px";
      }
      if (activeHandle.includes("w")) {
        const newWidth = Math.max(CONFIG.MIN_TEXT_WIDTH, start.width - dx);
        box.style.left = (start.left + (start.width - newWidth)) + "px";
        box.style.width = newWidth + "px";
      }
      if (activeHandle.includes("n")) {
        const newHeight = Math.max(CONFIG.MIN_TEXT_HEIGHT, start.height - dy);
        box.style.top = (start.top + (start.height - newHeight)) + "px";
        box.style.height = newHeight + "px";
      }
    }
    
    if (rotating) {
      const rect = box.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const deg = Math.atan2(e.clientY - cy, e.clientX - cx) * (180 / Math.PI) + 90;
      box._rotation = deg;
      box.style.transform = `rotate(${deg}deg)`;
      $("rotateInput").value = Math.round(deg);
    }
  };
  
  const onUp = () => {
    if (hasMoved && (dragging || resizing || rotating)) {
      saveState('text-modify');
    }
    dragging = resizing = rotating = hasMoved = false;
    activeHandle = null;
    start = null;
    
    if (state.tool === "text" && state.imageLoaded) {
      editCanvas.style.cursor = "crosshair";
    }
    
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
  };
  
  box.addEventListener('pointerdown', e => {
    e.stopPropagation();
    setCurrentTextBox(box);
    hasMoved = false;
    
    if (e.target.classList.contains("rotate-handle")) {
      rotating = true;
      start = { x: e.clientX, y: e.clientY, rot: box._rotation };
    } else if (e.target.classList.contains("handle")) {
      const h = e.target.classList[1];
      dragging = h === "nw";
      resizing = h !== "nw";
      activeHandle = h;
      start = {
        x: e.clientX,
        y: e.clientY,
        left: parseFloat(box.style.left),
        top: parseFloat(box.style.top),
        width: parseFloat(box.style.width),
        height: parseFloat(box.style.height)
      };
    } else {
      return;
    }
    
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  });
};

/* ===================================
   TEXT SIDEBAR CONTROLS
   =================================== */
const debouncedTextModify = debounce(() => saveState('text-modify'), CONFIG.TEXT_MODIFY_DEBOUNCE);

$("textInput").addEventListener('input', () => {
  if (!state.currentTextBox) return;
  const el = state.currentTextBox.querySelector('.textbox-content');
  if (el) el.innerText = $("textInput").value;
  state.currentTextBox.classList.add("selected");
  debouncedTextModify();
});

const textControls = [
  ['fontSizeInput', (v, box) => { box.style.fontSize = v + "px"; }],
  ['fontFamilySel', (v, box) => { box.style.fontFamily = v; }],
  ['lineHeightInput', (v, box) => { box.style.lineHeight = v; }],
  ['rotateInput', (v, box) => { 
    box._rotation = +v; 
    box.style.transform = `rotate(${v}deg)`; 
  }],
  ['textColorInput', (v, box) => { 
    box._textColor = v; 
    applyTextStroke(box); 
  }],
  ['strokeColorInput', (v, box) => { 
    box._strokeColor = v; 
    applyTextStroke(box); 
  }],
  ['strokeWidthInput', (v, box) => { 
    box._strokeWidth = +v; 
    applyTextStroke(box); 
  }],
  ['boldCheck', (v, box) => { 
    box._bold = v; 
    applyFontStyle(box); 
  }, 'checked'],
  ['italicCheck', (v, box) => { 
    box._italic = v; 
    applyFontStyle(box); 
  }, 'checked']
];

textControls.forEach(([id, fn, prop = 'value']) => {
  const el = $(id);
  const eventType = el.type === 'checkbox' ? 'change' : 'input';
  el.addEventListener(eventType, () => {
    if (!state.currentTextBox) return;
    fn(el[prop], state.currentTextBox);
    saveState('text-modify');
  });
});

$("deleteTextBtn").addEventListener('click', () => {
  if (!state.currentTextBox) return;
  textBoxes.delete(state.currentTextBox);
  state.currentTextBox.remove();
  state.currentTextBox = null;
  saveState('text-delete');
});

$("duplicateText").addEventListener('click', () => {
  if (!state.currentTextBox) return;
  const box = state.currentTextBox;
  const el = box.querySelector('.textbox-content');
  createTextBox({
    left: parseFloat(box.style.left) + 20,
    top: parseFloat(box.style.top) + 20,
    width: parseFloat(box.style.width),
    height: parseFloat(box.style.height),
    fontSize: parseInt(box.style.fontSize),
    fontFamily: box.style.fontFamily,
    lineHeight: box.style.lineHeight,
    rotation: box._rotation,
    text: el?.innerText || '',
    textColor: box._textColor,
    strokeColor: box._strokeColor,
    strokeWidth: box._strokeWidth,
    bold: box._bold,
    italic: box._italic
  });
  saveState('text-duplicate');
});

/* ===================================
   LAYERS
   =================================== */
$("showTextLayer").addEventListener('change', () => {
  const visible = $("showTextLayer").checked;
  textBoxes.forEach(box => {
    box.style.display = visible ? "block" : "none";
  });
});

$("showEditLayer").addEventListener('change', () => {
  editCanvas.style.display = $("showEditLayer").checked ? "block" : "none";
});

/* ===================================
   DESELECT
   =================================== */
canvasWrapper.addEventListener('click', e => {
  if ([canvasWrapper, imageCanvas, editCanvas].includes(e.target)) {
    setCurrentTextBox(null);
  }
});

/* ===================================
   KEYBOARD SHORTCUTS
   =================================== */
document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
    e.preventDefault();
    undo();
  }
  if (((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'z') || 
      ((e.ctrlKey || e.metaKey) && e.key === 'y')) {
    e.preventDefault();
    redo();
  }
});

$("undoBtn").addEventListener('click', undo);
$("redoBtn").addEventListener('click', redo);

/* ===================================
   EXPORT
   =================================== */
$("exportBtn").addEventListener('click', (e) => {
  e.stopPropagation();
  $('exportBtn').parentElement.classList.toggle('open');
});

// Close dropdown when clicking outside
document.addEventListener('click', (e) => {
  const dropdown = document.querySelector('.export-dropdown');
  if (dropdown && !dropdown.contains(e.target)) {
    dropdown.classList.remove('open');
  }
});

$("exportCurrentBtn").addEventListener('click', async () => {
  document.querySelector('.export-dropdown').classList.remove('open');
  saveCurrentPageState();
  
  loadingOverlay.style.display = 'flex';
  
  setTimeout(async () => {
    const currentPage = state.pages[state.currentPageIndex];
    exportSinglePage(currentPage, `scanlate-page-${state.currentPageIndex + 1}.png`);
    
    loadingOverlay.style.display = 'none';
  }, 100);
});

$("exportAllBtn").addEventListener('click', async () => {
  document.querySelector('.export-dropdown').classList.remove('open');
  saveCurrentPageState();
  
  loadingOverlay.style.display = 'flex';
  
  setTimeout(async () => {
    if (state.pages.length === 1) {
      exportSinglePage(state.pages[0], 'scanlate-page.png');
    } else {
      await exportAllPagesAsZip();
    }
    
    loadingOverlay.style.display = 'none';
  }, 100);
});

const exportSinglePage = (page, filename) => {
  const tmp = document.createElement("canvas");
  tmp.width = page.width;
  tmp.height = page.height;
  const ctx = tmp.getContext("2d");
  
  ctx.putImageData(page.imageData, 0, 0);
  
  const editTempCanvas = document.createElement("canvas");
  editTempCanvas.width = page.width;
  editTempCanvas.height = page.height;
  const editTempCtx = editTempCanvas.getContext("2d");
  editTempCtx.putImageData(page.editCanvas, 0, 0);
  ctx.drawImage(editTempCanvas, 0, 0);
  
  page.textBoxes.forEach(boxData => {
    ctx.save();
    
    const { left, top, width, height, fontSize, lineHeight, rotation, text,
            textColor, strokeColor, strokeWidth, bold, italic, fontFamily } = boxData;
    
    ctx.translate(left + width/2, top + height/2);
    ctx.rotate(rotation * Math.PI / 180);
    
    const fontStyle = italic ? "italic " : "";
    const fontWeight = bold ? "bold " : "";
    ctx.font = `${fontStyle}${fontWeight}${fontSize}px ${fontFamily}`;
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
    
    const lineHeightPx = lineHeight * fontSize;
    const maxWidth = width - 12;
    let y = -height/2 + 6 + fontSize * 0.8;
    const x = -width/2 + 6;
    
    text.split('\n').forEach((para, pIndex) => {
      if (!para) {
        y += lineHeightPx;
        return;
      }
      
      const words = para.split(' ');
      let currentLine = '';
      
      words.forEach(word => {
        const testLine = currentLine + (currentLine ? ' ' : '') + word;
        if (ctx.measureText(testLine).width > maxWidth && currentLine) {
          renderTextWithStroke(ctx, currentLine, x, y, textColor, strokeColor, strokeWidth);
          y += lineHeightPx;
          currentLine = word;
        } else {
          currentLine = testLine;
        }
      });
      
      if (currentLine) {
        renderTextWithStroke(ctx, currentLine, x, y, textColor, strokeColor, strokeWidth);
        if (pIndex < text.split('\n').length - 1) {
          y += lineHeightPx;
        }
      }
    });
    
    ctx.restore();
  });
  
  tmp.toBlob(blob => {
    const link = document.createElement("a");
    link.download = filename;
    link.href = URL.createObjectURL(blob);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(link.href);
  }, 'image/png');
};

const exportAllPages = () => {
  // Ensure all pages have valid data before exporting
  state.pages.forEach((page, index) => {
    // Check if page has required data, if not it means the page wasn't properly initialized
    if (!page.editCanvas || !page.textBoxes) {
      console.warn(`Page ${index + 1} missing data, using empty defaults`);
      page.editCanvas = page.editCanvas || ctxEdit.createImageData(page.width, page.height);
      page.textBoxes = page.textBoxes || [];
    }
    
    setTimeout(() => {
      exportSinglePage(page, `scanlate-page-${index + 1}.png`);
    }, index * 200);
  });
  
  alert(`Exporting ${state.pages.length} pages. Check your downloads folder.`);
};

const exportAllPagesAsZip = async () => {
  // Load JSZip from CDN if not already loaded
  if (typeof JSZip === 'undefined') {
    const script = document.createElement('script');
    script.src = 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js';
    document.head.appendChild(script);
    
    await new Promise((resolve, reject) => {
      script.onload = resolve;
      script.onerror = reject;
    });
  }
  
  const zip = new JSZip();
  
  // Generate all page images and add to ZIP
  state.pages.forEach((page, index) => {
    if (!page.editCanvas || !page.textBoxes) {
      console.warn(`Page ${index + 1} missing data, using empty defaults`);
      page.editCanvas = page.editCanvas || ctxEdit.createImageData(page.width, page.height);
      page.textBoxes = page.textBoxes || [];
    }
    
    const tmp = document.createElement("canvas");
    tmp.width = page.width;
    tmp.height = page.height;
    const ctx = tmp.getContext("2d");
    
    ctx.putImageData(page.imageData, 0, 0);
    
    const editTempCanvas = document.createElement("canvas");
    editTempCanvas.width = page.width;
    editTempCanvas.height = page.height;
    const editTempCtx = editTempCanvas.getContext("2d");
    editTempCtx.putImageData(page.editCanvas, 0, 0);
    ctx.drawImage(editTempCanvas, 0, 0);
    
    page.textBoxes.forEach(boxData => {
      ctx.save();
      
      const { left, top, width, height, fontSize, lineHeight, rotation, text,
              textColor, strokeColor, strokeWidth, bold, italic, fontFamily } = boxData;
      
      ctx.translate(left + width/2, top + height/2);
      ctx.rotate(rotation * Math.PI / 180);
      
      const fontStyle = italic ? "italic " : "";
      const fontWeight = bold ? "bold " : "";
      ctx.font = `${fontStyle}${fontWeight}${fontSize}px ${fontFamily}`;
      ctx.textAlign = "left";
      ctx.textBaseline = "alphabetic";
      
      const lineHeightPx = lineHeight * fontSize;
      const maxWidth = width - 12;
      let y = -height/2 + 6 + fontSize * 0.8;
      const x = -width/2 + 6;
      
      text.split('\n').forEach((para, pIndex) => {
        if (!para) {
          y += lineHeightPx;
          return;
        }
        
        const words = para.split(' ');
        let currentLine = '';
        
        words.forEach(word => {
          const testLine = currentLine + (currentLine ? ' ' : '') + word;
          if (ctx.measureText(testLine).width > maxWidth && currentLine) {
            renderTextWithStroke(ctx, currentLine, x, y, textColor, strokeColor, strokeWidth);
            y += lineHeightPx;
            currentLine = word;
          } else {
            currentLine = testLine;
          }
        });
        
        if (currentLine) {
          renderTextWithStroke(ctx, currentLine, x, y, textColor, strokeColor, strokeWidth);
          if (pIndex < text.split('\n').length - 1) {
            y += lineHeightPx;
          }
        }
      });
      
      ctx.restore();
    });
    
    // Convert canvas to blob and add to zip
    const dataUrl = tmp.toDataURL('image/png');
    const base64Data = dataUrl.split(',')[1];
    zip.file(`page-${String(index + 1).padStart(3, '0')}.png`, base64Data, {base64: true});
  });
  
  // Generate and download ZIP
  const blob = await zip.generateAsync({type: 'blob'});
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = 'scanlate-pages.zip';
  link.click();
  URL.revokeObjectURL(link.href);
};

/* ===================================
   MULTI-PAGE MANAGEMENT
   =================================== */
const saveCurrentPageState = () => {
  if (state.pages.length === 0 || !state.imageLoaded) return;
  
  const currentPage = state.pages[state.currentPageIndex];
  
  currentPage.editCanvas = ctxEdit.getImageData(0, 0, editCanvas.width, editCanvas.height);
  
  currentPage.textBoxes = Array.from(textBoxes).map(box => ({
    id: box.dataset.id,
    left: parseFloat(box.style.left),
    top: parseFloat(box.style.top),
    width: parseFloat(box.style.width),
    height: parseFloat(box.style.height),
    fontSize: parseInt(box.style.fontSize),
    fontFamily: box.style.fontFamily,
    lineHeight: box.style.lineHeight,
    rotation: box._rotation,
    text: box.querySelector('.textbox-content')?.innerText || '',
    textColor: box._textColor || "#000000",
    strokeColor: box._strokeColor || "#ffffff",
    strokeWidth: box._strokeWidth || 0,
    bold: box._bold || false,
    italic: box._italic || false
  }));
  
  currentPage.undoStack = [...state.undoStack];
  currentPage.redoStack = [...state.redoStack];
};

const loadPage = (pageIndex) => {
  if (pageIndex < 0 || pageIndex >= state.pages.length) return;
  
  saveCurrentPageState();
  
  const page = state.pages[pageIndex];
  state.currentPageIndex = pageIndex;
  
  imageCanvas.width = editCanvas.width = page.width;
  imageCanvas.height = editCanvas.height = page.height;
  
  ctxImage.putImageData(page.imageData, 0, 0);
  
  ctxEdit.putImageData(page.editCanvas, 0, 0);
  
  textBoxes.forEach(box => box.remove());
  textBoxes.clear();
  state.currentTextBox = null;
  
  page.textBoxes.forEach(data => createTextBox(data, false));
  
  state.undoStack = page.undoStack ? [...page.undoStack] : [];
  state.redoStack = page.redoStack ? [...page.redoStack] : [];
  
  updateUndoRedoButtons();
  updateHistoryLog();
  updatePageControls();
};

const updatePageControls = () => {
  const select = $("pageSelect");
  select.innerHTML = state.pages.map((_, i) => 
    `<option value="${i}">Page ${i + 1}</option>`
  ).join('');
  select.value = state.currentPageIndex;
  
  $("deletePageBtn").disabled = state.pages.length <= 1;
};

$("pageSelect").addEventListener('change', (e) => {
  loadPage(parseInt(e.target.value));
});

$("addPageBtn").addEventListener('click', () => {
  if (!state.imageLoaded) {
    alert('Please upload an image first');
    return;
  }
  
  saveCurrentPageState();
  
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.onchange = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    
    const img = new Image();
    img.onload = () => {
      imageCanvas.width = editCanvas.width = img.width;
      imageCanvas.height = editCanvas.height = img.height;
      
      ctxImage.drawImage(img, 0, 0);
      
      ctxEdit.clearRect(0, 0, img.width, img.height);
      
      textBoxes.forEach(box => box.remove());
      textBoxes.clear();
      state.currentTextBox = null;
      
      state.undoStack = [];
      state.redoStack = [];
      
      const newPage = {
        imageData: ctxImage.getImageData(0, 0, img.width, img.height),
        width: img.width,
        height: img.height,
        undoStack: [],
        redoStack: [],
        editCanvas: ctxEdit.getImageData(0, 0, img.width, img.height),
        textBoxes: []
      };
      
      state.pages.push(newPage);
      state.currentPageIndex = state.pages.length - 1;
      
      saveState('initial');
      
      updatePageControls();
      updateUndoRedoButtons();
      updateHistoryLog();
      
      URL.revokeObjectURL(img.src);
    };
    img.src = URL.createObjectURL(file);
  };
  input.click();
});

$("deletePageBtn").addEventListener('click', () => {
  if (state.pages.length <= 1) {
    alert('Cannot delete the last page');
    return;
  }
  
  if (!confirm(`Delete Page ${state.currentPageIndex + 1}?`)) return;
  
  state.pages.splice(state.currentPageIndex, 1);
  
  if (state.currentPageIndex >= state.pages.length) {
    state.currentPageIndex = state.pages.length - 1;
  }
  
  loadPage(state.currentPageIndex);
});

/* ===================================
   INITIALIZATION
   =================================== */
updateBrushCursor();
updateUndoRedoButtons();
updateHistoryLog();
$("brushBtn").classList.add('active');
