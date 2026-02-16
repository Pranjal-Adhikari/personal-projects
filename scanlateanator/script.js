

let supportsWebP = false;
let webpBlobSupport = false;


const detectWebPSupportAsync = async () => {
  return new Promise((resolve) => {
    const webpData = 'data:image/webp;base64,UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoBAAEAAwA0JaQAA3AA/vuUAAA=';
    const img = new Image();
    img.onload = () => resolve(img.width === 1 && img.height === 1);
    img.onerror = () => resolve(false);
    img.src = webpData;
  });
};


let webpDetectionComplete = false;
const ensureWebPDetection = async () => {
  if (webpDetectionComplete) return;
  
  try {
    supportsWebP = await detectWebPSupportAsync();
    
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const blob = await new Promise(resolve => {
      canvas.toBlob(resolve, 'image/webp', 0.9);
    });
    webpBlobSupport = blob && blob.type === 'image/webp';
    
    const hasWebPSupport = supportsWebP || webpBlobSupport;
    CONFIG.EXPORT_FORMAT = hasWebPSupport ? 'webp' : 'png';
    
    webpDetectionComplete = true;
    
    if (document.readyState === 'complete') {
      initializeExportSettings();
    }
  } catch (e) {
    CONFIG.EXPORT_FORMAT = 'png';
    webpDetectionComplete = true;
  }
};

const CONFIG = {
  MAX_UNDO_STEPS: 20,
  TEXT_MODIFY_DEBOUNCE: 500,
  HANDLE_SIZE: 10,
  ROTATE_HANDLE_OFFSET: 30,
  DEFAULT_TEXT: "Double-click to edit",
  STROKE_QUALITY: 8,
  MIN_TEXT_WIDTH: 60,
  MIN_TEXT_HEIGHT: 30,

  REGION_PADDING: 10,
  USE_WEBP: true,
  BLOB_QUALITY: 0.85,
  MIN_REGION_SIZE: 50,

  EXPORT_FORMAT: supportsWebP ? 'webp' : 'png',  // Auto-detect, fallba
  EXPORT_QUALITY: 0.92
};

const ACTION_LABELS = {
  initial: 'Initial State',
  brush: 'Brush Stroke',
  eraser: 'Eraser Stroke',
  'text-create': 'Create Text',
  'text-delete': 'Delete Text',
  'text-modify': 'Modify Text',
  'text-duplicate': 'Duplicate Text'
};


const $ = id => document.getElementById(id);
const $$ = sel => document.querySelectorAll(sel);

const canvasContainer = $("canvasContainer");
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
  textAlign: "left",

  zoom: 1,
  panX: 0,
  panY: 0,
  isPanning: false,
  panStartX: 0,
  panStartY: 0
};


const debounce = (fn, delay) => {
  let timeout;
  return (...args) => {
    clearTimeout(timeout);
    timeout = setTimeout(() => fn(...args), delay);
  };
};

const enableTools = (enabled) => {
  ['brushBtn', 'eraserBtn', 'textBtn', 'exportBtn', 'exportCurrentBtn', 'exportAllBtn',
   'zoomInBtn', 'zoomOutBtn', 'zoomResetBtn', 'zoomFitBtn'].forEach(id => {
    const el = $(id);
    if (el) el.disabled = !enabled;
  });
};


let currentProgress = 0;

const updateProgress = (target, total, message = '') => {
  const percentage = Math.round((target / total) * 100);
  const progressBar = $("progressBar");
  const percentageText = $("loadingPercentage");
  const subtitle = $("loadingSubtitle");
  
  currentProgress = percentage;
  
  if (progressBar) progressBar.style.width = percentage + '%';
  if (percentageText) percentageText.textContent = percentage + '%';
  if (subtitle && message) subtitle.textContent = message;
};

const animateProgress = async (from, to, duration, message = '') => {
  const steps = 20;
  const stepSize = (to - from) / steps;
  const stepDuration = duration / steps;
  
  for (let i = 0; i <= steps; i++) {
    const current = from + (stepSize * i);
    updateProgress(current, 100, message);
    await new Promise(resolve => setTimeout(resolve, stepDuration));
  }
};

const showLoading = async (message = 'Processing image and text layers') => {
  loadingOverlay.style.display = 'flex';
  currentProgress = 0;
  updateProgress(0, 100, message);

  await new Promise(resolve => setTimeout(resolve, 100));
};

const hideLoading = () => {
  loadingOverlay.style.display = 'none';
  currentProgress = 0;
  updateProgress(0, 100);
};




const getRegionBounds = (imageData, padding = CONFIG.REGION_PADDING) => {
  const { data, width, height } = imageData;
  let minX = width, minY = height, maxX = 0, maxY = 0;
  let hasContent = false;
  

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const alpha = data[(y * width + x) * 4 + 3];
      if (alpha > 0) {
        hasContent = true;
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }
  }
  
  if (!hasContent) return null;
  

  return {
    x: Math.max(0, minX - padding),
    y: Math.max(0, minY - padding),
    width: Math.min(width - Math.max(0, minX - padding), maxX - minX + 1 + padding * 2),
    height: Math.min(height - Math.max(0, minY - padding), maxY - minY + 1 + padding * 2)
  };
};


const getStrokeBounds = (points, size, padding = CONFIG.REGION_PADDING) => {
  if (points.length === 0) return null;
  
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  
  for (const point of points) {
    minX = Math.min(minX, point.x - size);
    minY = Math.min(minY, point.y - size);
    maxX = Math.max(maxX, point.x + size);
    maxY = Math.max(maxY, point.y + size);
  }
  
  return {
    x: Math.max(0, Math.floor(minX - padding)),
    y: Math.max(0, Math.floor(minY - padding)),
    width: Math.min(editCanvas.width, Math.ceil(maxX - minX + size * 2 + padding * 2)),
    height: Math.min(editCanvas.height, Math.ceil(maxY - minY + size * 2 + padding * 2))
  };
};


const compressRegionToBlob = async (imageData) => {

  const tempCanvas = document.createElement('canvas');
  tempCanvas.width = imageData.width;
  tempCanvas.height = imageData.height;
  const tempCtx = tempCanvas.getContext('2d');
  tempCtx.putImageData(imageData, 0, 0);
  

  return new Promise(resolve => {
    tempCanvas.toBlob(resolve, 
      CONFIG.USE_WEBP ? 'image/webp' : 'image/png', 
      CONFIG.BLOB_QUALITY
    );
  });
};


const saveState = async (action) => {
  console.log(`Saving state: ${action}, stack length before: ${state.undoStack.length}`);
  

  const textBoxesData = Array.from(textBoxes).map(box => ({
    id: box.dataset.id,
    left: parseFloat(box.style.left),
    top: parseFloat(box.style.top),
    width: parseFloat(box.style.width),
    height: parseFloat(box.style.height),
    fontSize: parseInt(box.style.fontSize),
    fontFamily: box.style.fontFamily,
    lineHeight: parseFloat(box.style.lineHeight),
    rotation: box._rotation || 0,
    text: box.querySelector('.textbox-content')?.innerText || '',
    textColor: box._textColor || '#000000',
    strokeColor: box._strokeColor || '#ffffff',
    strokeWidth: box._strokeWidth || 0,
    bold: box._bold || false,
    italic: box._italic || false,
    textAlign: box._textAlign || 'left',
    backgroundColor: box._backgroundColor || 'transparent'
  }));
  
  let editCanvasData = null;
  let regionBounds = null;
  


  if (action === 'brush' && state.currentStrokePoints.length > 0) {
    const size = state.brushSize;
    regionBounds = getStrokeBounds(state.currentStrokePoints, size);
  }
  

  if (regionBounds && regionBounds.width > 0 && regionBounds.height > 0) {

    const regionData = ctxEdit.getImageData(
      regionBounds.x, 
      regionBounds.y, 
      regionBounds.width, 
      regionBounds.height
    );
    

    editCanvasData = {
      type: 'region',
      bounds: regionBounds,
      blob: await compressRegionToBlob(regionData)
    };
    
    console.log(`  Optimized: Storing region ${regionBounds.width}x${regionBounds.height} instead of full ${editCanvas.width}x${editCanvas.height}`);
  } else {

    editCanvasData = {
      type: 'full',
      blob: await new Promise(resolve => {
        editCanvas.toBlob(resolve, 
          CONFIG.USE_WEBP ? 'image/webp' : 'image/png', 
          CONFIG.BLOB_QUALITY
        );
      })
    };
    
    console.log(`  Storing full canvas (action: ${action})`);
  }
  

  const stateEntry = {
    action,
    timestamp: Date.now(),
    editCanvasData,
    textBoxes: textBoxesData
  };
  

  state.undoStack.push(stateEntry);
  
  console.log(`Stack length after: ${state.undoStack.length}, actions: [${state.undoStack.map(s => s.action).join(', ')}]`);
  

  if (state.undoStack.length > CONFIG.MAX_UNDO_STEPS) {
    const removed = state.undoStack.shift();

    if (removed.editCanvasData?.blob) {
      URL.revokeObjectURL(removed.editCanvasData.blob);
    }
  }
  


  state.redoStack.forEach(entry => {
    if (entry.editCanvasData?.blob) {
      URL.revokeObjectURL(entry.editCanvasData.blob);
    }
  });
  state.redoStack = [];
  

  if (state.pages.length > 0 && state.pages[state.currentPageIndex]) {
    state.pages[state.currentPageIndex].undoStack = [...state.undoStack];
    state.pages[state.currentPageIndex].redoStack = [...state.redoStack];
  }
  
  updateUndoRedoButtons();
  updateHistoryLog();
};


const restoreState = async (stateEntry) => {
  if (!stateEntry) return;
  
  console.log(`RESTORE: Restoring action: ${stateEntry.action}`);
  

  ctxEdit.clearRect(0, 0, editCanvas.width, editCanvas.height);
  

  const targetIndex = state.undoStack.indexOf(stateEntry);
  
  if (targetIndex === -1) {
    console.error('RESTORE: State not found in undo stack!');
    return;
  }
  



  ctxEdit.globalCompositeOperation = 'source-over';
  
  for (let i = 0; i <= targetIndex; i++) {
    const currentState = state.undoStack[i];
    const canvasData = currentState.editCanvasData || { type: 'full', blob: currentState.editCanvasBlob };
    
    if (canvasData && canvasData.blob) {
      const img = await createImageBitmap(canvasData.blob);
      
      if (canvasData.type === 'region' && canvasData.bounds) {


        ctxEdit.drawImage(img, canvasData.bounds.x, canvasData.bounds.y);
        
        console.log(`  Applied ${currentState.action} region at (${canvasData.bounds.x}, ${canvasData.bounds.y})`);
      } else {

        ctxEdit.clearRect(0, 0, editCanvas.width, editCanvas.height);
        ctxEdit.drawImage(img, 0, 0);
        
        console.log(`  Applied full canvas`);
      }
    }
  }
  
  console.log(`RESTORE: Replayed ${targetIndex + 1} states`);
  

  textBoxes.forEach(box => box.remove());
  textBoxes.clear();
  state.currentTextBox = null;
  
  if (stateEntry.textBoxes) {
    stateEntry.textBoxes.forEach(data => createTextBox(data, false));
  }
};


const undo = async () => {

  if (state.undoStack.length <= 1) return;
  
  console.log(`UNDO: Before - undoStack length: ${state.undoStack.length}, actions: [${state.undoStack.map(s => s.action).join(', ')}]`);
  

  const currentState = state.undoStack.pop();
  state.redoStack.push(currentState);
  

  const previousState = state.undoStack[state.undoStack.length - 1];
  console.log(`UNDO: Restoring state with action: ${previousState.action}, blob size: ${previousState.editCanvasBlob?.size || 'none'}`);
  
  await restoreState(previousState);
  
  console.log(`UNDO: After - undoStack length: ${state.undoStack.length}, actions: [${state.undoStack.map(s => s.action).join(', ')}]`);
  

  if (state.pages.length > 0 && state.pages[state.currentPageIndex]) {
    state.pages[state.currentPageIndex].undoStack = [...state.undoStack];
    state.pages[state.currentPageIndex].redoStack = [...state.redoStack];
  }
  
  updateUndoRedoButtons();
  updateHistoryLog();
};


const redo = async () => {
  if (state.redoStack.length === 0) return;
  

  const nextState = state.redoStack.pop();
  state.undoStack.push(nextState);
  

  await restoreState(nextState);
  

  if (state.pages.length > 0 && state.pages[state.currentPageIndex]) {
    state.pages[state.currentPageIndex].undoStack = [...state.undoStack];
    state.pages[state.currentPageIndex].redoStack = [...state.redoStack];
  }
  
  updateUndoRedoButtons();
  updateHistoryLog();
};


const updateUndoRedoButtons = () => {
  $("undoBtn").disabled = state.undoStack.length <= 1;
  $("redoBtn").disabled = state.redoStack.length === 0;
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
  if (!item) return;
  
  const clickedIndex = parseInt(item.dataset.index);
  

  if (clickedIndex === 0) return;
  


  


  const reversedStack = [...state.undoStack].reverse();
  const targetStateIndex = state.undoStack.length - 1 - clickedIndex;
  

  state.undoStack = state.undoStack.slice(0, targetStateIndex + 1);
  

  state.redoStack = [];
  

  const targetState = state.undoStack[state.undoStack.length - 1];
  await restoreState(targetState);
  

  if (state.pages.length > 0 && state.pages[state.currentPageIndex]) {
    state.pages[state.currentPageIndex].undoStack = [...state.undoStack];
    state.pages[state.currentPageIndex].redoStack = [...state.redoStack];
  }
  
  updateUndoRedoButtons();
  updateHistoryLog();
});




const updateCanvasTransform = () => {

  const transformedWidth = editCanvas.width * state.zoom;
  const transformedHeight = editCanvas.height * state.zoom;
  

  const viewportWidth = centerArea.clientWidth;
  const viewportHeight = centerArea.clientHeight;
  

  const centerOffsetX = (viewportWidth - transformedWidth) / 2;
  const centerOffsetY = (viewportHeight - transformedHeight) / 2;
  

  const transform = `translate(${centerOffsetX + state.panX}px, ${centerOffsetY + state.panY}px) scale(${state.zoom})`;
  canvasWrapper.style.transform = transform;
  canvasWrapper.style.transformOrigin = '0 0';
  


  const containerWidth = Math.max(transformedWidth, viewportWidth);
  const containerHeight = Math.max(transformedHeight, viewportHeight);
  
  canvasContainer.style.width = containerWidth + 'px';
  canvasContainer.style.height = containerHeight + 'px';
};


const getCanvasCoordinates = (clientX, clientY) => {
  const rect = editCanvas.getBoundingClientRect();
  const x = (clientX - rect.left) / state.zoom;
  const y = (clientY - rect.top) / state.zoom;
  return { x, y };
};


const centerArea = $('centerArea');

centerArea.addEventListener('wheel', (e) => {
  if (!state.imageLoaded) return;
  

  if (!e.ctrlKey && !e.metaKey) return;
  
  e.preventDefault();
  

  const rect = centerArea.getBoundingClientRect();
  const mouseX = e.clientX - rect.left;
  const mouseY = e.clientY - rect.top;
  

  const oldTransformedWidth = editCanvas.width * state.zoom;
  const oldTransformedHeight = editCanvas.height * state.zoom;
  const oldCenterX = (rect.width - oldTransformedWidth) / 2 + state.panX;
  const oldCenterY = (rect.height - oldTransformedHeight) / 2 + state.panY;
  

  const mouseDeltaX = mouseX - oldCenterX;
  const mouseDeltaY = mouseY - oldCenterY;
  

  const zoomDelta = e.deltaY > 0 ? 0.9 : 1.1;
  const oldZoom = state.zoom;
  const newZoom = Math.max(0.1, Math.min(5, state.zoom * zoomDelta));
  

  const newTransformedWidth = editCanvas.width * newZoom;
  const newTransformedHeight = editCanvas.height * newZoom;
  const newCenterX = (rect.width - newTransformedWidth) / 2;
  const newCenterY = (rect.height - newTransformedHeight) / 2;
  

  const zoomRatio = newZoom / oldZoom;
  state.panX = mouseX - newCenterX - mouseDeltaX * zoomRatio;
  state.panY = mouseY - newCenterY - mouseDeltaY * zoomRatio;
  
  state.zoom = newZoom;
  updateCanvasTransform();
  

  updateZoomDisplay();
}, { passive: false });


let spacebarPressed = false;

document.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && !e.repeat && state.imageLoaded) {

    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable) {
      return;
    }
    spacebarPressed = true;
    centerArea.style.cursor = 'grab';
    e.preventDefault();
  }
});

document.addEventListener('keyup', (e) => {
  if (e.code === 'Space') {
    spacebarPressed = false;
    if (!state.isPanning) {
      centerArea.style.cursor = '';

      if (state.tool === 'brush' || state.tool === 'eraser') {
        editCanvas.style.cursor = 'none';
      } else if (state.tool === 'text') {
        editCanvas.style.cursor = 'crosshair';
      }
    }
  }
});

centerArea.addEventListener('mousedown', (e) => {
  if (!state.imageLoaded) return;
  

  if (e.button === 1 || (spacebarPressed && e.button === 0)) {
    e.preventDefault();
    state.isPanning = true;
    state.panStartX = e.clientX - state.panX;
    state.panStartY = e.clientY - state.panY;
    centerArea.style.cursor = 'grabbing';
  }
});

centerArea.addEventListener('mousemove', (e) => {
  if (state.isPanning) {
    state.panX = e.clientX - state.panStartX;
    state.panY = e.clientY - state.panStartY;
    updateCanvasTransform();
  }
});

centerArea.addEventListener('mouseup', (e) => {
  if (state.isPanning && (e.button === 1 || e.button === 0)) {
    state.isPanning = false;
    centerArea.style.cursor = spacebarPressed ? 'grab' : '';
    

    if (!spacebarPressed) {
      if (state.tool === 'brush' || state.tool === 'eraser') {
        editCanvas.style.cursor = 'none';
      } else if (state.tool === 'text') {
        editCanvas.style.cursor = 'crosshair';
      }
    }
  }
});


centerArea.addEventListener('auxclick', (e) => {
  if (e.button === 1) {
    e.preventDefault();
  }
});


const resetZoom = () => {
  state.zoom = 1;
  state.panX = 0;
  state.panY = 0;
  updateCanvasTransform();
  updateZoomDisplay();
};


const zoomToFit = () => {
  if (!state.imageLoaded) return;
  
  const container = centerArea;
  const containerWidth = container.clientWidth - 40;
  const containerHeight = container.clientHeight - 40;
  
  const scaleX = containerWidth / editCanvas.width;
  const scaleY = containerHeight / editCanvas.height;
  
  state.zoom = Math.min(scaleX, scaleY, 1);

  state.panX = 0;
  state.panY = 0;
  
  updateCanvasTransform();
  updateZoomDisplay();
};


const updateZoomDisplay = () => {
  const zoomPercent = Math.round(state.zoom * 100);
  const display = $('zoomDisplay');
  if (display) {
    display.textContent = `${zoomPercent}%`;
  }
};


$('zoomInBtn').addEventListener('click', () => {
  if (!state.imageLoaded) return;
  state.zoom = Math.min(5, state.zoom * 1.2);
  updateCanvasTransform();
  updateZoomDisplay();
});

$('zoomOutBtn').addEventListener('click', () => {
  if (!state.imageLoaded) return;
  state.zoom = Math.max(0.1, state.zoom / 1.2);
  updateCanvasTransform();
  updateZoomDisplay();
});

$('zoomResetBtn').addEventListener('click', resetZoom);
$('zoomFitBtn').addEventListener('click', zoomToFit);


document.addEventListener('keydown', (e) => {

  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable) {
    return;
  }
  
  if (!state.imageLoaded) return;
  

  if (e.key === '+' || e.key === '=') {
    e.preventDefault();
    state.zoom = Math.min(5, state.zoom * 1.2);
    updateCanvasTransform();
    updateZoomDisplay();
  }
  

  if (e.key === '-' || e.key === '_') {
    e.preventDefault();
    state.zoom = Math.max(0.1, state.zoom / 1.2);
    updateCanvasTransform();
    updateZoomDisplay();
  }
  

  if (e.key === '0') {
    e.preventDefault();
    resetZoom();
  }
});


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

$("uploadBtn").addEventListener('click', () => $("fileInput").click());

$("fileInput").addEventListener('change', e => {
  const file = e.target.files[0];
  if (!file) return;
  
  if (state.currentImageURL) {
    URL.revokeObjectURL(state.currentImageURL);
  }
  
  const img = new Image();
  img.onload = () => {

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
    canvasContainer.style.display = 'block';
    
    enableTools(true);
    updatePageControls();
    

    setTimeout(() => {
      zoomToFit();
    }, 50);
    
    URL.revokeObjectURL(state.currentImageURL);
    state.currentImageURL = null;
  };
  
  state.currentImageURL = URL.createObjectURL(file);
  img.src = state.currentImageURL;
});


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

  cursor.style.width = cursor.style.height = (size * state.zoom) + "px";
};

editCanvas.addEventListener('pointerdown', async e => {
  if (!state.imageLoaded || (state.tool !== "brush" && state.tool !== "eraser")) return;
  
  state.drawing = true;
  state.currentStrokePoints = [];
  
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

const endDrawing = async () => {
  if (state.drawing) {
    await saveState(state.tool === 'eraser' ? 'eraser' : 'brush');
  }
  state.drawing = false;
  state.currentStrokePoints = [];
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
    const cursor = $("brushCursor");
    

    cursor.style.left = e.clientX + "px";
    cursor.style.top = e.clientY + "px";
  }
});


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
    

    const align = box._textAlign || "left";
    state.textAlign = align;
    $$('.alignment-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.align === align);
    });
  }
};


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


const debouncedTextModify = debounce(() => saveState('text-modify'), CONFIG.TEXT_MODIFY_DEBOUNCE);

$("textInput").addEventListener('input', () => {
  if (!state.currentTextBox) return;
  const el = state.currentTextBox.querySelector('.textbox-content');
  if (el) el.innerText = $("textInput").value;
  state.currentTextBox.classList.add("selected");
  debouncedTextModify();
});


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


$("showTextLayer").addEventListener('change', () => {
  const visible = $("showTextLayer").checked;
  textBoxes.forEach(box => {
    box.style.display = visible ? "block" : "none";
  });
});

$("showEditLayer").addEventListener('change', () => {
  editCanvas.style.display = $("showEditLayer").checked ? "block" : "none";
});


$("exportFormatSelect").addEventListener('change', (e) => {
  CONFIG.EXPORT_FORMAT = e.target.value;
  console.log('Export format set to:', CONFIG.EXPORT_FORMAT);
});

$("exportQualitySlider").addEventListener('input', (e) => {
  const quality = parseInt(e.target.value);
  CONFIG.EXPORT_QUALITY = quality / 100;
  $("exportQualityValue").textContent = quality;
});


canvasWrapper.addEventListener('click', e => {
  if ([canvasWrapper, imageCanvas, editCanvas].includes(e.target)) {
    setCurrentTextBox(null);
  }
});


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


$("exportBtn").addEventListener('click', (e) => {
  e.stopPropagation();
  $('exportBtn').parentElement.classList.toggle('open');
});


document.addEventListener('click', (e) => {
  const dropdown = document.querySelector('.export-dropdown');
  if (dropdown && !dropdown.contains(e.target)) {
    dropdown.classList.remove('open');
  }
});

$("exportCurrentBtn").addEventListener('click', async () => {
  document.querySelector('.export-dropdown').classList.remove('open');
  saveCurrentPageState();
  
  await showLoading('Preparing export...');
  

  await ensureWebPDetection();
  
  await animateProgress(0, 20, 200, 'Preparing export...');
  
  const currentPage = state.pages[state.currentPageIndex];
  
  await animateProgress(20, 50, 300, 'Rendering image layers...');
  

  await new Promise(resolve => setTimeout(resolve, 100));
  
  await animateProgress(50, 80, 300, 'Processing text and effects...');
  

  exportSinglePage(currentPage, `scanlate-page-${state.currentPageIndex + 1}.png`);
  
  await animateProgress(80, 100, 200, 'Complete!');
  
  await new Promise(resolve => setTimeout(resolve, 400));
  hideLoading();
});

$("exportAllBtn").addEventListener('click', async () => {
  document.querySelector('.export-dropdown').classList.remove('open');
  saveCurrentPageState();
  
  const pageCount = state.pages.length;
  

  await ensureWebPDetection();
  
  if (pageCount === 1) {
    await showLoading('Preparing export...');
    await animateProgress(0, 20, 200, 'Preparing export...');
    
    await animateProgress(20, 50, 300, 'Rendering image layers...');
    await new Promise(resolve => setTimeout(resolve, 100));
    
    await animateProgress(50, 80, 300, 'Processing text and effects...');
    
    exportSinglePage(state.pages[0], 'scanlate-page.png');
    
    await animateProgress(80, 100, 200, 'Complete!');
    await new Promise(resolve => setTimeout(resolve, 400));
  } else {
    await showLoading(`Preparing to export ${pageCount} pages...`);
    await animateProgress(0, 10, 300, `Preparing to export ${pageCount} pages...`);
    
    await exportAllPagesAsZip();
    await new Promise(resolve => setTimeout(resolve, 400));
  }
  
  hideLoading();
});

const exportSinglePage = (page, filename) => {
  const tmp = document.createElement("canvas");
  tmp.width = page.width;
  tmp.height = page.height;
  const ctx = tmp.getContext("2d", { alpha: false }); // Disable
  

  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, page.width, page.height);
  
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
    

    const align = textAlign || "left";
    ctx.textAlign = align === "justify" ? "left" : align; // Justify uses left a
    ctx.textBaseline = "alphabetic";
    
    const lineHeightPx = lineHeight * fontSize;
    const maxWidth = width - 12;
    let y = -height/2 + 6 + fontSize * 0.8;
    

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

          if (align === "justify" && wIndex < words.length - 1) {

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
  

  const format = CONFIG.EXPORT_FORMAT === 'webp' ? 'image/webp' : 'image/png';
  const quality = CONFIG.EXPORT_QUALITY;
  
  console.log('Exporting with settings:', { format, quality, filename });
  

  const finalFilename = filename.replace(/\.(png|jpg|jpeg|webp)$/i, '') + 
                        (format === 'image/webp' ? '.webp' : '.png');
  
  console.log('Final filename:', finalFilename);
  
  tmp.toBlob(blob => {
    if (blob) {
      console.log('Blob created:', {
        size: (blob.size / 1024).toFixed(2) + 'KB',
        type: blob.type
      });
    }
    const link = document.createElement("a");
    link.download = finalFilename;
    link.href = URL.createObjectURL(blob);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(link.href);
  }, format, quality);
};

const exportAllPages = () => {

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
  const totalPages = state.pages.length;
  

  if (typeof JSZip === 'undefined') {
    await animateProgress(10, 15, 500, 'Loading export library...');
    const script = document.createElement('script');
    script.src = 'https://cdnjs.clo
    document.head.appendChild(script);
    
    await new Promise((resolve, reject) => {
      script.onload = resolve;
      script.onerror = reject;
    });
  } else {
    await animateProgress(10, 15, 300, 'Initializing...');
  }
  
  await animateProgress(15, 20, 200, 'Setting up export...');
  
  const zip = new JSZip();
  

  const progressStart = 20;
  const progressEnd = 80;
  const progressPerPage = (progressEnd - progressStart) / totalPages;
  
  for (let index = 0; index < state.pages.length; index++) {
    const page = state.pages[index];
    
    const pageProgressStart = progressStart + (index * progressPerPage);
    const pageProgressEnd = progressStart + ((index + 1) * progressPerPage);
    

    await animateProgress(
      pageProgressStart, 
      pageProgressStart + (progressPerPage * 0.3), 
      100, 
      `Processing page ${index + 1} of ${totalPages}...`
    );
    
    if (!page.editCanvas || !page.textBoxes) {
      console.warn(`Page ${index + 1} missing data, using empty defaults`);
      page.editCanvas = page.editCanvas || ctxEdit.createImageData(page.width, page.height);
      page.textBoxes = page.textBoxes || [];
    }
    
    const tmp = document.createElement("canvas");
    tmp.width = page.width;
    tmp.height = page.height;
    const ctx = tmp.getContext("2d", { alpha: false }); // Disable
    

    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, page.width, page.height);
    
    ctx.putImageData(page.imageData, 0, 0);
    
    const editTempCanvas = document.createElement("canvas");
    editTempCanvas.width = page.width;
    editTempCanvas.height = page.height;
    const editTempCtx = editTempCanvas.getContext("2d");
    editTempCtx.putImageData(page.editCanvas, 0, 0);
    ctx.drawImage(editTempCanvas, 0, 0);
    
    await animateProgress(
      pageProgressStart + (progressPerPage * 0.3), 
      pageProgressStart + (progressPerPage * 0.7), 
      150, 
      `Rendering page ${index + 1} of ${totalPages}...`
    );
    
    page.textBoxes.forEach(boxData => {
      ctx.save();
      
      const { left, top, width, height, fontSize, lineHeight, rotation, text,
              textColor, strokeColor, strokeWidth, bold, italic, fontFamily, textAlign } = boxData;
      
      ctx.translate(left + width/2, top + height/2);
      ctx.rotate(rotation * Math.PI / 180);
      
      const fontStyle = italic ? "italic " : "";
      const fontWeight = bold ? "bold " : "";
      ctx.font = `${fontStyle}${fontWeight}${fontSize}px ${fontFamily}`;
      
      const align = textAlign || "left";
      ctx.textAlign = align === "justify" ? "left" : align;
      ctx.textBaseline = "alphabetic";
      
      const lineHeightPx = lineHeight * fontSize;
      const maxWidth = width - 12;
      let y = -height/2 + 6 + fontSize * 0.8;
      
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
            if (align === "justify" && wIndex < words.length - 1) {
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
    

    const format = CONFIG.EXPORT_FORMAT === 'webp' ? 'image/webp' : 'image/png';
    const extension = format === 'image/webp' ? 'webp' : 'png';
    

    const imageBlob = await new Promise(resolve => {
      tmp.toBlob(resolve, format, CONFIG.EXPORT_QUALITY);
    });
    
    zip.file(`page-${String(index + 1).padStart(3, '0')}.${extension}`, imageBlob);
    
    await animateProgress(
      pageProgressStart + (progressPerPage * 0.7), 
      pageProgressEnd, 
      100, 
      `Saved page ${index + 1} of ${totalPages}`
    );
  }
  

  await animateProgress(80, 90, 300, 'Creating ZIP file...');
  
  const blob = await zip.generateAsync({
    type: 'blob',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 }
  }, (metadata) => {
    const zipProgress = 90 + (metadata.percent * 0.09);
    updateProgress(zipProgress, 100, `Compressing... ${Math.round(metadata.percent)}%`);
  });
  
  updateProgress(100, 100, 'Download starting...');
  
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = 'scanlate-pages.zip';
  link.click();
  URL.revokeObjectURL(link.href);
};


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
  

  setTimeout(() => {
    const container = $('centerArea');
    const wrapper = canvasWrapper;
    

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
  input.accept = 'image
$("collapseLeftBtn").addEventListener('click', () => {
  $("leftSidebar").classList.toggle('collapsed');

  if (state.imageLoaded) {
    setTimeout(() => updateCanvasTransform(), 350);
  }
});

$("collapseRightBtn").addEventListener('click', () => {
  $("rightSidebar").classList.toggle('collapsed');

  if (state.imageLoaded) {
    setTimeout(() => updateCanvasTransform(), 350);
  }
});


const customFonts = new Set();

$("importFontBtn").addEventListener('click', () => {
  $("fontFileInput").click();
});

$("fontFileInput").addEventListener('change', async (e) => {
  const files = e.target.files;
  if (!files || files.length === 0) return;
  
  const MAX_FILE_SIZE = 5 * 1024 * 1024;
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
    'application/octet-stream' // Fonts so
  ];
  
  let successCount = 0;
  let errorCount = 0;
  
  for (const file of files) {
    try {

      if (!ALLOWED_EXTENSIONS.test(file.name)) {
        console.error(`Invalid file extension: ${file.name}`);
        errorCount++;
        continue;
      }
      

      if (file.size > MAX_FILE_SIZE) {
        console.error(`File too large: ${file.name} (${(file.size / 1024 / 1024).toFixed(2)}MB)`);
        errorCount++;
        continue;
      }
      

      if (!ALLOWED_MIME_TYPES.includes(file.type) && file.type !== '') {
        console.error(`Invalid MIME type: ${file.name} (${file.type})`);
        errorCount++;
        continue;
      }
      

      const fontName = file.name.replace(/\.(ttf|otf|woff|woff2)$/i, '');
      const fontUrl = URL.createObjectURL(file);
      const fontFace = new FontFace(fontName, `url(${fontUrl})`);
      

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



$("helpBtn").addEventListener('click', () => {
  $("helpModal").classList.add('show');
});

$("closeHelpBtn").addEventListener('click', () => {
  $("helpModal").classList.remove('show');
});


$("helpModal").addEventListener('click', (e) => {
  if (e.target === $("helpModal")) {
    $("helpModal").classList.remove('show');
  }
});


document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && $("helpModal").classList.contains('show')) {
    $("helpModal").classList.remove('show');
  }
});


document.addEventListener('keydown', async (e) => {

  if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
    e.preventDefault();
    await undo();
  }

  else if (
    ((e.ctrlKey || e.metaKey) && e.key === 'y') ||
    ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'z')
  ) {
    e.preventDefault();
    await redo();
  }
});


const initializeExportSettings = () => {
  const formatSelect = $("exportFormatSelect");
  const qualitySlider = $("exportQualitySlider");
  const statusMessage = $("webpStatusMessage");
  
  if (formatSelect) {
    formatSelect.value = CONFIG.EXPORT_FORMAT;
    

    const hasWebPSupport = supportsWebP || webpBlobSupport;
    

    if (!hasWebPSupport && statusMessage) {
      statusMessage.style.display = 'block';
    }
    


  }
  
  if (qualitySlider) {
    qualitySlider.value = Math.round(CONFIG.EXPORT_QUALITY * 100);
    $("exportQualityValue").textContent = Math.round(CONFIG.EXPORT_QUALITY * 100);
  }
  
  console.log('Export settings initialized:', {
    format: CONFIG.EXPORT_FORMAT,
    quality: CONFIG.EXPORT_QUALITY,
    webpSupported: supportsWebP,
    webpBlobSupport: webpBlobSupport,
    userAgent: navigator.userAgent
  });
};

updateBrushCursor();
updateUndoRedoButtons();
updateHistoryLog();
$("brushBtn").classList.add('active');
initializeExportSettings();