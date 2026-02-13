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
const [ctxImage, ctxEdit] = [
  imageCanvas.getContext("2d"), 
  editCanvas.getContext("2d", { willReadFrequently: true, desynchronized: true })
];
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
  currentPageIndex: 0,
  currentStrokePoints: [],
  currentStrokeStart: null,
  textAlign: "left"
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
const saveState = async action => {
  const currentUndoStack = state.undoStack;
  
  // Delta compression for brush strokes
  if (action === 'brush' && state.currentStrokePoints.length > 0) {
    currentUndoStack.push({
      action,
      timestamp: Date.now(),
      strokeData: {
        points: [...state.currentStrokePoints],
        color: state.brushColor,
        size: state.brushSize,
        tool: state.tool === 'eraser' ? 'eraser' : 'brush',
        startCanvas: state.currentStrokeStart
      },
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
        italic: box._italic || false,
        textAlign: box._textAlign || "left"
      }))
	});
    state.currentStrokePoints = [];
    state.currentStrokeStart = null;
  } else {
    // Compress and store full state of non-brush strokes
    const compressedCanvas = await new Promise(resolve => {
      editCanvas.toBlob(blob => {
        resolve(blob);
      }, 'image/png', 0.8);
    });
    
    currentUndoStack.push({
      action,
      timestamp: Date.now(),
      editCanvasBlob: compressedCanvas,
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
        italic: box._italic || false,
        textAlign: box._textAlign || "left"
      }))
	});
  }
  
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

const undo = async () => {
  if (state.undoStack.length <= 1) return;
  state.redoStack.push(state.undoStack.pop());
  await restoreState(state.undoStack[state.undoStack.length - 1]);
  updateUndoRedoButtons();
  updateHistoryLog();
};

const redo = async () => {
  if (!state.redoStack.length) return;
  const nextState = state.redoStack.pop();
  state.undoStack.push(nextState);
  await restoreState(nextState);
  updateUndoRedoButtons();
  updateHistoryLog();
};

const restoreState = async s => {
  // Stroke data handling (delta)
  if (s.strokeData) {
    // Start from base canvas
    if (s.strokeData.startCanvas) {
      const img = await createImageBitmap(s.strokeData.startCanvas);
      ctxEdit.clearRect(0, 0, editCanvas.width, editCanvas.height);
      ctxEdit.drawImage(img, 0, 0);
    }
    
    // Replay the stroke
    const { points, color, size, tool } = s.strokeData;
    if (points.length > 0) {
      ctxEdit.lineWidth = size;
      ctxEdit.lineCap = "round";
      ctxEdit.lineJoin = "round";
      ctxEdit.globalCompositeOperation = tool === "eraser" ? "destination-out" : "source-over";
      if (tool === "brush") {
        ctxEdit.strokeStyle = color;
      }
      
      ctxEdit.beginPath();
      ctxEdit.moveTo(points[0].x, points[0].y);
      points.forEach(pt => ctxEdit.lineTo(pt.x, pt.y));
      ctxEdit.stroke();
    }
  } 
  // Handle compressed blob
  else if (s.editCanvasBlob) {
    const img = await createImageBitmap(s.editCanvasBlob);
    ctxEdit.clearRect(0, 0, editCanvas.width, editCanvas.height);
    ctxEdit.drawImage(img, 0, 0);
  }
  // Fallback
  else if (s.editCanvas) {
    ctxEdit.putImageData(s.editCanvas, 0, 0);
  }
  
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

$("historyLog").addEventListener('click', async e => {
  const item = e.target.closest('.history-item');
  if (item) {
    const steps = parseInt(item.dataset.index);
    for (let i = 0; i < steps; i++) await undo();
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
    
	// Centering code that doesn't work but I'm too lazy to re-do ;^;
    setTimeout(() => {
      const container = $('centerArea');
      const wrapper = canvasWrapper;
      
      // Calculate scroll positions to center image
      const scrollLeft = (wrapper.offsetWidth - container.clientWidth) / 2;
      const scrollTop = (wrapper.offsetHeight - container.clientHeight) / 2;
      
      container.scrollLeft = Math.max(0, scrollLeft);
      container.scrollTop = Math.max(0, scrollTop);
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

editCanvas.addEventListener('pointerdown', async e => {
  if (!state.imageLoaded || (state.tool !== "brush" && state.tool !== "eraser")) return;
  
  state.drawing = true;
  state.currentStrokePoints = [];
  
  // Save canvas state before stroke begins
  state.currentStrokeStart = await new Promise(resolve => {
    editCanvas.toBlob(blob => resolve(blob), 'image/png', 0.8);
  });
  
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
  
  state.currentStrokePoints.push({ x: e.offsetX, y: e.offsetY });
});

editCanvas.addEventListener('pointermove', e => {
  if (state.drawing && (state.tool === "brush" || state.tool === "eraser")) {
    ctxEdit.lineTo(e.offsetX, e.offsetY);
    ctxEdit.stroke();
    state.currentStrokePoints.push({ x: e.offsetX, y: e.offsetY });
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
    
    // Update alignment buttons
    const align = box._textAlign || "left";
    state.textAlign = align;
    $$('.alignment-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.align === align);
    });
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
    _rotation: opts.rotation || 0,
    _textAlign: opts.textAlign || "left"
  });
  
  applyFontStyle(box);
  applyTextStroke(box);
  
  const textContent = document.createElement("div");
  textContent.className = "textbox-content";
  textContent.contentEditable = true;
  textContent.innerText = opts.text || CONFIG.DEFAULT_TEXT;
  textContent.style.cssText = `width: 100%; height: 100%; outline: none; text-align: ${box._textAlign};`;
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

// Alignment buttons
$$('.alignment-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    if (!state.currentTextBox) return;
    
    const align = btn.dataset.align;
    state.textAlign = align;
    state.currentTextBox._textAlign = align;
    
    const textContent = state.currentTextBox.querySelector('.textbox-content');
    if (textContent) {
      textContent.style.textAlign = align;
    }
    
    $$('.alignment-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    
    saveState('text-modify');
  });
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
    italic: box._italic,
    textAlign: box._textAlign || "left"
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
            textColor, strokeColor, strokeWidth, bold, italic, fontFamily, textAlign } = boxData;
    
    ctx.translate(left + width/2, top + height/2);
    ctx.rotate(rotation * Math.PI / 180);
    
    const fontStyle = italic ? "italic " : "";
    const fontWeight = bold ? "bold " : "";
    ctx.font = `${fontStyle}${fontWeight}${fontSize}px ${fontFamily}`;
    
    // Set alignment based on textAlign property
    const align = textAlign || "left";
    ctx.textAlign = align === "justify" ? "left" : align; // Justify uses left alignment with word spacing
    ctx.textBaseline = "alphabetic";
    
    const lineHeightPx = lineHeight * fontSize;
    const maxWidth = width - 12;
    let y = -height/2 + 6 + fontSize * 0.8;
    
    // Calculate x position based on alignment
    let x;
    if (align === "left" || align === "justify") {
      x = -width/2 + 6;
    } else if (align === "center") {
      x = 0;
    } else if (align === "right") {
      x = width/2 - 6;
    }
    
    text.split('\n').forEach((para, pIndex) => {
      if (!para) {
        y += lineHeightPx;
        return;
      }
      
      const words = para.split(' ');
      let currentLine = '';
      
      words.forEach((word, wIndex) => {
        const testLine = currentLine + (currentLine ? ' ' : '') + word;
        if (ctx.measureText(testLine).width > maxWidth && currentLine) {
          // Render current line
          if (align === "justify" && wIndex < words.length - 1) {
            // Justify text by spacing words evenly
            const lineWords = currentLine.split(' ');
            if (lineWords.length > 1) {
              const lineWidth = lineWords.reduce((sum, w) => sum + ctx.measureText(w).width, 0);
              const spacing = (maxWidth - lineWidth) / (lineWords.length - 1);
              let xPos = -width/2 + 6;
              lineWords.forEach((w, i) => {
                renderTextWithStroke(ctx, w, xPos, y, textColor, strokeColor, strokeWidth);
                xPos += ctx.measureText(w).width + spacing;
              });
            } else {
              renderTextWithStroke(ctx, currentLine, x, y, textColor, strokeColor, strokeWidth);
            }
          } else {
            renderTextWithStroke(ctx, currentLine, x, y, textColor, strokeColor, strokeWidth);
          }
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
  // Valid data?
  state.pages.forEach((page, index) => {
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
              textColor, strokeColor, strokeWidth, bold, italic, fontFamily, textAlign } = boxData;
      
      ctx.translate(left + width/2, top + height/2);
      ctx.rotate(rotation * Math.PI / 180);
      
      const fontStyle = italic ? "italic " : "";
      const fontWeight = bold ? "bold " : "";
      ctx.font = `${fontStyle}${fontWeight}${fontSize}px ${fontFamily}`;
      
      // Set alignment based on textAlign property
      const align = textAlign || "left";
      ctx.textAlign = align === "justify" ? "left" : align;
      ctx.textBaseline = "alphabetic";
      
      const lineHeightPx = lineHeight * fontSize;
      const maxWidth = width - 12;
      let y = -height/2 + 6 + fontSize * 0.8;
      
      // Calculate x position based on alignment
      let x;
      if (align === "left" || align === "justify") {
        x = -width/2 + 6;
      } else if (align === "center") {
        x = 0;
      } else if (align === "right") {
        x = width/2 - 6;
      }
      
      text.split('\n').forEach((para, pIndex) => {
        if (!para) {
          y += lineHeightPx;
          return;
        }
        
        const words = para.split(' ');
        let currentLine = '';
        
        words.forEach((word, wIndex) => {
          const testLine = currentLine + (currentLine ? ' ' : '') + word;
          if (ctx.measureText(testLine).width > maxWidth && currentLine) {
            // Render current line
            if (align === "justify" && wIndex < words.length - 1) {
              // Justify text by spacing words evenly
              const lineWords = currentLine.split(' ');
              if (lineWords.length > 1) {
                const lineWidth = lineWords.reduce((sum, w) => sum + ctx.measureText(w).width, 0);
                const spacing = (maxWidth - lineWidth) / (lineWords.length - 1);
                let xPos = -width/2 + 6;
                lineWords.forEach((w, i) => {
                  renderTextWithStroke(ctx, w, xPos, y, textColor, strokeColor, strokeWidth);
                  xPos += ctx.measureText(w).width + spacing;
                });
              } else {
                renderTextWithStroke(ctx, currentLine, x, y, textColor, strokeColor, strokeWidth);
              }
            } else {
              renderTextWithStroke(ctx, currentLine, x, y, textColor, strokeColor, strokeWidth);
            }
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
    italic: box._italic || false,
    textAlign: box._textAlign || "left"
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
  
  // Center the image in the viewport
  setTimeout(() => {
    const container = $('centerArea');
    const wrapper = canvasWrapper;
    
    // Calculate scroll positions to center the image
    const scrollLeft = (wrapper.offsetWidth - container.clientWidth) / 2;
    const scrollTop = (wrapper.offsetHeight - container.clientHeight) / 2;
    
    container.scrollLeft = Math.max(0, scrollLeft);
    container.scrollTop = Math.max(0, scrollTop);
  }, 50);
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
   SIDEBAR COLLAPSE
   =================================== */
$("collapseLeftBtn").addEventListener('click', () => {
  $("leftSidebar").classList.toggle('collapsed');
});

$("collapseRightBtn").addEventListener('click', () => {
  $("rightSidebar").classList.toggle('collapsed');
});

/* ===================================
   CUSTOM FONT IMPORT
   =================================== */
const customFonts = new Set(); // Track imported font names

$("importFontBtn").addEventListener('click', () => {
  $("fontFileInput").click();
});

$("fontFileInput").addEventListener('change', async (e) => {
  const files = e.target.files;
  if (!files || files.length === 0) return;
  
  const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB per font
  const ALLOWED_EXTENSIONS = /\.(ttf|otf|woff|woff2)$/i;
  const ALLOWED_MIME_TYPES = [
    'font/ttf',
    'font/otf',
    'font/woff',
    'font/woff2',
    'application/x-font-ttf',
    'application/x-font-otf',
    'application/font-woff',
    'application/font-woff2',
    'application/octet-stream' // I don't think this is common
  ];
  
  let successCount = 0;
  let errorCount = 0;
  
  for (const file of files) {
    try {
      // 1. Check file extension
      if (!ALLOWED_EXTENSIONS.test(file.name)) {
        console.error(`Invalid file extension: ${file.name}`);
        errorCount++;
        continue;
      }
      
      // 2. Check file size
      if (file.size > MAX_FILE_SIZE) {
        console.error(`File too large: ${file.name} (${(file.size / 1024 / 1024).toFixed(2)}MB)`);
        errorCount++;
        continue;
      }
      
      // 3. Check MIME type
      if (!ALLOWED_MIME_TYPES.includes(file.type) && file.type !== '') {
        console.error(`Invalid MIME type: ${file.name} (${file.type})`);
        errorCount++;
        continue;
      }
      
      // 4. Validate font file by attempting to load it
      const fontName = file.name.replace(/\.(ttf|otf|woff|woff2)$/i, '');
      const fontUrl = URL.createObjectURL(file);
      const fontFace = new FontFace(fontName, `url(${fontUrl})`);
      
      // Valid font?
      await fontFace.load();
      
      document.fonts.add(fontFace);
      customFonts.add(fontName);
      
      const fontSelect = $("fontFamilySel");
      const existingOption = Array.from(fontSelect.options).find(
        opt => opt.value === fontName
      );
      
      if (!existingOption) {
        const option = document.createElement('option');
        option.value = fontName;
        option.textContent = fontName + ' (Custom)';
        fontSelect.appendChild(option);
      }
      
      successCount++;
      
      // Clean up the blob URL after a delay
      setTimeout(() => URL.revokeObjectURL(fontUrl), 60000);
      
    } catch (error) {
      console.error(`Failed to load font: ${file.name}`, error);
      errorCount++;
    }
  }
  
  if (successCount > 0) {
    showNotification(`Successfully imported ${successCount} font${successCount > 1 ? 's' : ''}!`, 'success');
  }
  
  if (errorCount > 0) {
    showNotification(`Failed to import ${errorCount} font${errorCount > 1 ? 's' : ''}. Invalid or corrupted files.`, 'error');
  }
  
  e.target.value = '';
});

const showNotification = (message, type = 'info') => {
  const notification = document.createElement('div');
  notification.textContent = message;
  notification.style.cssText = `
    position: fixed;
    top: 80px;
    right: 20px;
    padding: 12px 20px;
    background: ${type === 'success' ? '#0e639c' : '#c72e2e'};
    color: white;
    border-radius: 4px;
    z-index: 10001;
    font-size: 14px;
    box-shadow: 0 4px 12px rgba(0,0,0,0.3);
    animation: slideIn 0.3s ease;
  `;
  
  document.body.appendChild(notification);
  
  setTimeout(() => {
    notification.style.animation = 'slideOut 0.3s ease';
    setTimeout(() => notification.remove(), 300);
  }, 3000);
};

if (!document.querySelector('#notificationStyles')) {
  const style = document.createElement('style');
  style.id = 'notificationStyles';
  style.textContent = `
    @keyframes slideIn {
      from {
        transform: translateX(400px);
        opacity: 0;
      }
      to {
        transform: translateX(0);
        opacity: 1;
      }
    }
    @keyframes slideOut {
      from {
        transform: translateX(0);
        opacity: 1;
      }
      to {
        transform: translateX(400px);
        opacity: 0;
      }
    }
  `;
  document.head.appendChild(style);
}

/* ===================================
   INITIALIZATION FINALLY OMG
   =================================== */
// Help modal
$("helpBtn").addEventListener('click', () => {
  $("helpModal").classList.add('show');
});

$("closeHelpBtn").addEventListener('click', () => {
  $("helpModal").classList.remove('show');
});

// Close modal when clicking outside
$("helpModal").addEventListener('click', (e) => {
  if (e.target === $("helpModal")) {
    $("helpModal").classList.remove('show');
  }
});

// Close modal with Escape key
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && $("helpModal").classList.contains('show')) {
    $("helpModal").classList.remove('show');
  }
});

updateBrushCursor();
updateUndoRedoButtons();
updateHistoryLog();
$("brushBtn").classList.add('active');
