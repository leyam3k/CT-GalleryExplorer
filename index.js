
import { extension_settings, getContext } from "../../../extensions.js";
import { saveSettingsDebounced, eventSource, event_types, characters, this_chid } from "../../../../script.js";

const extensionName = "CT-GalleryExplorer";
const extensionFolderPath = `scripts/extensions/third-party/${extensionName}`;

// Default Settings
const defaultSettings = {
    sortOrder: 'newest', // newest, oldest, nameAsc, nameDesc
    lastFolder: '',
    enableSidebar: true,
    enableCharHeader: true,
};

// State
let galleryState = {
    isOpen: false,
    currentFolder: '',
    images: [], // Array of filenames
    selectedIndex: -1,
    selectionMode: false,
    selectedImages: new Set(),
    galleryRect: { top: 50, left: 50, width: 800, height: 600 },
    viewerRect: { top: 50, left: 50, width: 600, height: 700 }, // Legacy, viewer is now usually fixed/modal
    zoom: 1,
    pan: { x: 0, y: 0 }
};

// Load Settings
function loadSettings() {
    extension_settings[extensionName] = extension_settings[extensionName] || {};
    for (const key in defaultSettings) {
        if (!Object.hasOwn(extension_settings[extensionName], key)) {
            extension_settings[extensionName][key] = defaultSettings[key];
        }
    }
    
    // Load UI state persistence
    try {
        const savedState = localStorage.getItem('CT-GalleryExplorer-State');
        if (savedState) {
            const parsed = JSON.parse(savedState);
            if (parsed.galleryRect) galleryState.galleryRect = parsed.galleryRect;
            // Validate rects
            galleryState.galleryRect = ensureOnScreen(galleryState.galleryRect, 800, 600);
        }
    } catch (e) {
        console.warn('Failed to load gallery state', e);
    }
}

function saveUiState() {
    const state = {
        galleryRect: galleryState.galleryRect
    };
    localStorage.setItem('CT-GalleryExplorer-State', JSON.stringify(state));
}

function ensureOnScreen(rect, defaultWidth, defaultHeight) {
    if (!rect) return { top: 50, left: 50, width: defaultWidth, height: defaultHeight };
    
    let { top, left, width, height } = rect;
    const padding = 20;

    // Minimums
    if (width < 200) width = defaultWidth;
    if (height < 200) height = defaultHeight;

    // Viewport bounds
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    if (left + width < padding) left = padding - width + 50;
    if (left > vw - padding) left = vw - 50;
    if (top + height < padding) top = padding - height + 50;
    if (top > vh - padding) top = vh - 50;

    return { top, left, width, height };
}

// API Utilities
async function apiPost(url, data) {
    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            ...(getContext().getRequestHeaders ? getContext().getRequestHeaders() : {})
        },
        body: JSON.stringify(data)
    });
    if (!response.ok) throw new Error(response.statusText);
    return response.json();
}

async function fetchFolders() {
    try {
        return await apiPost('/api/images/folders', {});
    } catch (err) {
        console.error('Gallery Fetch Folders Error:', err);
        toastr.error('Failed to load folders');
        return [];
    }
}

async function fetchImages(folder) {
    try {
        const images = await apiPost('/api/images/list', { folder });
        if (!Array.isArray(images)) throw new Error("Invalid API response");
        return images;
    } catch (err) {
        console.error(`Gallery: Failed to load folder '${folder}'`, err);
        toastr.error(`Failed to load images for ${folder}`);
        return [];
    }
}

async function deleteImageAPI(path) {
    try {
        await apiPost('/api/images/delete', { path });
        return true;
    } catch (err) {
        console.error('Delete Error:', err);
        toastr.error('Failed to delete image');
        return false;
    }
}

// Sorting
function sortImages(images, order) {
    return [...images].sort((a, b) => {
        // Try to parse dates from filenames usually YYYY-MM-DD
        const dateRegex = /(\d{4})[-]?(\d{2})[-]?(\d{2})/;
        const matchA = a.match(dateRegex);
        const matchB = b.match(dateRegex);

        const timeA = matchA ? new Date(`${matchA[1]}-${matchA[2]}-${matchA[3]}`).getTime() : 0;
        const timeB = matchB ? new Date(`${matchB[1]}-${matchB[2]}-${matchB[3]}`).getTime() : 0;

        if (order === 'newest') return timeB - timeA || b.localeCompare(a, undefined, { numeric: true, sensitivity: 'base' });
        if (order === 'oldest') return timeA - timeB || a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
        if (order === 'nameAsc') return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
        if (order === 'nameDesc') return b.localeCompare(a, undefined, { numeric: true, sensitivity: 'base' });
        return 0;
    });
}

// --- Logic ---

function syncToCurrentCharacter() {
    const context = getContext();
    if (context && context.characterId !== undefined && context.characters[context.characterId]) {
        const charName = context.characters[context.characterId].name;
        if (charName) {
            loadFolder(charName);
            toastr.success(`Synced to ${charName}`);
        }
    } else {
        toastr.info("No character selected.");
    }
}

// --- UI Rendering ---

function buildGalleryWindow() {
    if ($('#ct-gallery-explorer').length) return;

    const html = `
        <div id="ct-gallery-explorer" class="ct-gallery-window" style="display:none;">
            <div class="gallery-header">
                <div class="gallery-title">
                    <i class="fa-solid fa-images"></i> Gallery Explorer
                </div>
                <div class="gallery-controls">
                    <div class="gallery-control-group">
                        <button id="gallery-refresh" class="icon-btn" title="Refresh"><i class="fa-solid fa-sync-alt"></i></button>
                        <button id="gallery-go-char" class="icon-btn" title="Go to Current Character"><i class="fa-solid fa-user-circle"></i></button>
                        <button id="gallery-upload" class="icon-btn" title="Upload Image"><i class="fa-solid fa-upload"></i></button>
                        <input type="file" id="gallery-file-input" multiple accept="image/*,video/*" style="display:none;">
                    </div>
                    <div class="gallery-control-group">
                        <button id="gallery-select-mode" class="icon-btn" title="Selection Mode"><i class="fa-solid fa-check-square"></i></button>
                    </div>
                    <div class="gallery-control-group selection-only" style="display:none;">
                        <span id="gallery-selection-count">0 selected</span>
                        <button id="gallery-select-all" class="icon-btn" title="Select All"><i class="fa-solid fa-check-double"></i></button>
                        <button id="gallery-delete-selected" class="icon-btn warning" title="Delete Selected"><i class="fa-solid fa-trash"></i></button>
                        <button id="gallery-cancel-selection" class="icon-btn" title="Cancel Selection"><i class="fa-solid fa-times"></i></button>
                    </div>
                    <div class="gallery-control-group">
                        <button id="gallery-sort-toggle" class="icon-btn" title="Sort"><i class="fa-solid fa-sort"></i></button>
                        <button id="gallery-close" class="icon-btn close-btn" title="Close"><i class="fa-solid fa-times"></i></button>
                    </div>
                </div>
            </div>
            <div class="gallery-body">
                <div class="gallery-sidebar">
                    <div class="gallery-sidebar-header">Folders</div>
                    <div id="gallery-folder-list" class="gallery-folder-list"></div>
                </div>
                <div class="gallery-main">
                     <select id="gallery-mobile-folder-select" class="mobile-only"></select>
                    <div id="gallery-grid" class="gallery-grid"></div>
                    <div id="gallery-loader" class="gallery-loader"><i class="fa-solid fa-spinner fa-spin"></i></div>
                    <div id="gallery-empty" class="gallery-empty" style="display:none;">No images found in this folder.</div>
                </div>
            </div>
             <!-- Handle removed from HTML, added via jQuery UI automatically, but keeping div if you used custom CSS for it -->
             <div class="gallery-resize-handle"></div>
        </div>
    `;

    $('body').append(html);
    
    // Position
    const $win = $('#ct-gallery-explorer');
    const rect = galleryState.galleryRect;
    
    // Z-Index Handling
    const wins = Array.from(document.querySelectorAll('div')).map(e => Number(getComputedStyle(e).zIndex) || 0);
    const highest = Math.max(2000, ...wins);
    const newIndex = Math.min(99900, highest + 1);
    $win.css('z-index', newIndex);
    
    // Only apply absolute positioning on non-mobile
    if (!isMobile()) {
        $win.css({
            top: rect.top,
            left: rect.left,
            width: rect.width,
            height: rect.height,
            position: 'fixed'
        });
        
        // Draggable
        $win.draggable({
            handle: '.gallery-header',
            containment: 'window',
            start: () => {
                // Disable blur during drag to prevent lag
                $win.addClass('resizing');
            },
            stop: (e, ui) => {
                $win.removeClass('resizing');
                galleryState.galleryRect.top = ui.position.top;
                galleryState.galleryRect.left = ui.position.left;
                saveUiState();
            }
        });

        // Resizable
        $win.resizable({
            handles: 'n, e, s, w, ne, se, sw, nw',
            minHeight: 400,
            minWidth: 500,
            // PERFORMANCE FIX: Disable heavy CSS effects during resize interaction
            start: (e, ui) => {
                $win.addClass('resizing');
            },
            stop: (e, ui) => {
                $win.removeClass('resizing');
                galleryState.galleryRect.width = ui.size.width;
                galleryState.galleryRect.height = ui.size.height;
                saveUiState();
            }
        });
        
        // Bring to front on click
         $win.on('mousedown', () => {
             const wins = Array.from(document.querySelectorAll('.ct-gallery-window, .ui-dialog, .drawer-content')).map(e => Number(getComputedStyle(e).zIndex) || 0);
             const highest = Math.max(2000, ...wins);
             const newIndex = Math.min(99900, highest + 1);
             $win.css('z-index', newIndex);
         });
    }

    // Event Listeners
    $('#gallery-close').on('click', closeGallery);
    $('#gallery-refresh').on('click', () => loadFolder(galleryState.currentFolder));
    $('#gallery-go-char').on('click', syncToCurrentCharacter);
    $('#gallery-sort-toggle').on('click', toggleSort);
    
    $('#gallery-mobile-folder-select').on('change', function() {
        loadFolder($(this).val());
    });
    
    // Upload
    $('#gallery-upload').on('click', () => $('#gallery-file-input').click());
    $('#gallery-file-input').on('change', handleUpload);
    
    // Selection Mode
    $('#gallery-select-mode').on('click', toggleSelectionMode);
    $('#gallery-cancel-selection').on('click', toggleSelectionMode);
    $('#gallery-select-all').on('click', selectAll);
    $('#gallery-delete-selected').on('click', deleteSelected);

    // Handle Resize / Breakpoint changes
    $(window).on('resize.ctgallery', () => {
        const $win = $('#ct-gallery-explorer');
        if (!$win.is(':visible')) return;

        // BUG FIX: Don't forcefully reset dimensions if the user is currently resizing the gallery
        if ($win.hasClass('ui-resizable-resizing') || $win.hasClass('ui-draggable-dragging')) return;

        if (isMobile()) {
            $win.css({ width: '', height: '', top: '', left: '' });
        } else {
            // Only restore saved position if we are switching from mobile to desktop
            // or if the window resized drastically.
            const rect = galleryState.galleryRect;
            const safeRect = ensureOnScreen(rect, 800, 600);
            
            // Apply only position, let width/height stay relative if possible, or enforce safe rect
            $win.css({
                top: safeRect.top,
                left: safeRect.left,
                width: safeRect.width,
                height: safeRect.height,
                position: 'fixed'
            });
            
            // Re-enable if needed
            if ($win.data('ui-draggable')) $win.draggable('enable');
            if ($win.data('ui-resizable')) $win.resizable('enable');
        }
    });
}

function isMobile() {
    return window.matchMedia("(max-width: 768px)").matches;
}

async function openGallery(targetFolder = null) {
    if (!$('#ct-gallery-explorer').length) buildGalleryWindow();
    
    const $win = $('#ct-gallery-explorer');
    $win.show();
    
    // Initialize
    await refreshFolderList();
    
    // Determine folder
    let folder = targetFolder || galleryState.currentFolder;
    if (!folder) {
        // Try to sync with current character
        const context = getContext();
        if (context.characterId !== undefined && context.characters[context.characterId]) {
            folder = context.characters[context.characterId].name;
            // Also try to find avatar specific folder if needed, but usually Name is good
        }
    }
    
    if (folder) {
        loadFolder(folder);
    } else {
        // Default to first folder if available
        const first = $('#gallery-folder-list .folder-item').first().data('folder');
        if (first) loadFolder(first);
    }
}

function closeGallery() {
    $('#ct-gallery-explorer').hide();
    exitSelectionMode();
}

async function refreshFolderList() {
    const folders = await fetchFolders();
    const $list = $('#gallery-folder-list');
    const $mobile = $('#gallery-mobile-folder-select');
    
    $list.empty();
    $mobile.empty();
    
    folders.forEach(f => {
        const sortedF = f; 
        $list.append(`<div class="folder-item interactable" data-folder="${f}"><i class="fa-solid fa-folder"></i> ${f}</div>`);
        $mobile.append(`<option value="${f}">${f}</option>`);
    });
    
    // Click handlers
    $list.find('.folder-item').on('click', function() {
        loadFolder($(this).data('folder'));
    });
}

async function loadFolder(folder) {
    if (!folder) return;
    galleryState.currentFolder = folder;
    
    // Update UI
    $('#gallery-folder-list .folder-item').removeClass('active');
    $(`#gallery-folder-list .folder-item[data-folder="${folder}"]`).addClass('active');
    $('#gallery-mobile-folder-select').val(folder);
    
    $('#gallery-loader').show();
    $('#gallery-grid').empty();
    $('#gallery-empty').hide();
    
    const settings = extension_settings[extensionName];
    let images = await fetchImages(folder);
    images = sortImages(images, settings.sortOrder);
    galleryState.images = images;
    
    $('#gallery-loader').hide();
    
    if (images.length === 0) {
        $('#gallery-empty').show();
        return;
    }
    
    renderGrid(images);
}

function renderGrid(images) {
    const $grid = $('#gallery-grid');
    const folder = galleryState.currentFolder;
    
    const fragment = document.createDocumentFragment();
    
    images.forEach((filename, index) => {
        const item = document.createElement('div');
        item.className = 'gallery-item';
        item.dataset.index = index;
        item.dataset.filename = filename;
        
        const isVideo = /\.(mp4|webm|ogg|mov)$/i.test(filename);
        const url = `user/images/${encodeURIComponent(folder)}/${encodeURIComponent(filename)}`;
        
        item.innerHTML = `
            <div class="gallery-thumb-container">
                ${isVideo ? `<div class="video-badges"><i class="fa-solid fa-video"></i></div>` : ''}
                <img src="${url}" loading="lazy" class="gallery-thumb">
                <div class="gallery-selection-checkbox"><i class="fa-solid fa-check"></i></div>
            </div>
            <div class="gallery-item-name">${filename}</div>
        `;
        
        // Events
        item.addEventListener('click', (e) => onGalleryItemClick(e, index, filename));
        
        fragment.appendChild(item);
    });
    
    $grid.append(fragment);
    updateSelectionUI();
}

function toggleSort() {
    const settings = extension_settings[extensionName];
    const orders = ['newest', 'oldest', 'nameAsc', 'nameDesc'];
    let idx = orders.indexOf(settings.sortOrder);
    idx = (idx + 1) % orders.length;
    settings.sortOrder = orders[idx];
    settings.sortOrder = orders[idx]; // Persist?
    
    const icon = {
        'newest': 'fa-sort-numeric-down',
        'oldest': 'fa-sort-numeric-up',
        'nameAsc': 'fa-sort-alpha-down',
        'nameDesc': 'fa-sort-alpha-up'
    }[settings.sortOrder];
    
    $('#gallery-sort-toggle i').attr('class', `fa-solid ${icon}`);
    toastr.info(`Sorting: ${settings.sortOrder}`);
    
    loadFolder(galleryState.currentFolder); // Reload and sort
    saveSettingsDebounced();
}

// --- Selection Mode ---

function toggleSelectionMode() {
    galleryState.selectionMode = !galleryState.selectionMode;
    const $win = $('#ct-gallery-explorer');
    
    if (galleryState.selectionMode) {
        $win.addClass('selection-active');
        $win.find('.selection-only').show();
        $win.find('#gallery-select-mode').addClass('active');
    } else {
        exitSelectionMode();
    }
}

function exitSelectionMode() {
    galleryState.selectionMode = false;
    galleryState.selectedImages.clear();
    const $win = $('#ct-gallery-explorer');
    $win.removeClass('selection-active');
    $win.find('.selection-only').hide();
    $win.find('#gallery-select-mode').removeClass('active');
    $('.gallery-item').removeClass('selected');
    updateSelectionUI();
}

function selectAll() {
    const all = galleryState.images;
    if (galleryState.selectedImages.size === all.length) {
        galleryState.selectedImages.clear();
        $('.gallery-item').removeClass('selected');
    } else {
        all.forEach(img => galleryState.selectedImages.add(img));
        $('.gallery-item').addClass('selected');
    }
    updateSelectionUI();
}

function onGalleryItemClick(e, index, filename) {
    if (galleryState.selectionMode) {
        if (galleryState.selectedImages.has(filename)) {
            galleryState.selectedImages.delete(filename);
            $(e.currentTarget).removeClass('selected');
        } else {
            galleryState.selectedImages.add(filename);
            $(e.currentTarget).addClass('selected');
        }
        updateSelectionUI();
    } else {
        openLightbox(index);
    }
}

function updateSelectionUI() {
    $('#gallery-selection-count').text(`${galleryState.selectedImages.size} selected`);
}

async function deleteSelected() {
    const count = galleryState.selectedImages.size;
    if (count === 0) return;
    
    if (!confirm(`Are you sure you want to delete ${count} item(s)?`)) return;
    
    const context = getContext();
    const folder = galleryState.currentFolder;
    
    let deleted = 0;
    for (const filename of galleryState.selectedImages) {
        const path = `user/images/${folder}/${filename}`;
        const result = await deleteImageAPI(path);
        if (result) deleted++;
    }
    
    toastr.success(`Deleted ${deleted} images.`);
    exitSelectionMode();
    loadFolder(folder);
}

// --- Lightbox ---

function openLightbox(index) {
    if (index < 0 || index >= galleryState.images.length) return;
    
    galleryState.selectedIndex = index;
    
    if ($('#ct-gallery-lightbox').length === 0) {
        buildLightbox();
    }
    
    const $lb = $('#ct-gallery-lightbox');
    $lb.show();
    updateLightboxContent();
}

function buildLightbox() {
    // ST-Native-like structure using SmartTheme classes
    const html = `
        <div id="ct-gallery-lightbox" class="ct-gallery-lightbox">
            <div class="lb-backdrop"></div>
            <div class="lb-window">
                <div class="lb-header">
                    <div class="lb-title">
                        <span class="lb-counter"></span>
                        <span class="lb-filename"></span>
                    </div>
                    <div class="lb-controls">
                        <div class="lb-control-item lb-download" title="Download"><i class="fa-solid fa-download"></i></div>
                        <div class="lb-control-item lb-delete warning" title="Delete"><i class="fa-solid fa-trash"></i></div>
                        <div class="lb-control-item lb-close" title="Close"><i class="fa-solid fa-times"></i></div>
                    </div>
                </div>
                <div class="lb-content">
                    <div class="lb-nav lb-prev"><i class="fa-solid fa-chevron-left"></i></div>
                    <div class="lb-media-container"></div>
                    <div class="lb-nav lb-next"><i class="fa-solid fa-chevron-right"></i></div>
                </div>
            </div>
        </div>
    `;
    $('body').append(html);
    
    // Explicit high Z-Index
    $('#ct-gallery-lightbox').css('z-index', 2147483647);
    
    $('.lb-close, .lb-backdrop').on('click', () => $('#ct-gallery-lightbox').hide());
    $('.lb-prev').on('click', (e) => { e.stopPropagation(); navigateLightbox(-1); });
    $('.lb-next').on('click', (e) => { e.stopPropagation(); navigateLightbox(1); });
    // Prevent double-click selection on rapid navigation
    $('.lb-nav, .lb-control-item').on('mousedown', (e) => e.preventDefault());
    
    $('.lb-delete').on('click', (e) => { e.stopPropagation(); deleteCurrentLightboxImage(); });
    $('.lb-download').on('click', (e) => { e.stopPropagation(); downloadCurrentLightboxImage(); });
    
    // Keyboard navigation
    $(document).on('keydown.ctgallery', (e) => {
        if (!$('#ct-gallery-lightbox').is(':visible')) return;
        if (e.key === 'ArrowLeft') navigateLightbox(-1);
        if (e.key === 'ArrowRight') navigateLightbox(1);
        if (e.key === 'Escape') $('#ct-gallery-lightbox').hide();
        if (e.key === 'Delete') deleteCurrentLightboxImage();
    });
    
    // Gestures (Basic touch)
    let touchStartX = 0;
    $('.lb-content').on('touchstart', (e) => {
        touchStartX = e.touches[0].clientX;
    }).on('touchend', (e) => {
        const touchEndX = e.changedTouches[0].clientX;
        if (touchStartX - touchEndX > 50) navigateLightbox(1);
        if (touchEndX - touchStartX > 50) navigateLightbox(-1);
    });
}

function updateLightboxContent() {
    const index = galleryState.selectedIndex;
    const filename = galleryState.images[index];
    const folder = galleryState.currentFolder;
    const url = `user/images/${encodeURIComponent(folder)}/${encodeURIComponent(filename)}`;
    const isVideo = /\.(mp4|webm|ogg|mov)$/i.test(filename);
    
    const $container = $('.lb-media-container');
    $container.empty();
    
    if (isVideo) {
        const $video = $(`<video src="${url}" controls autoplay class="lb-media"></video>`);
        $container.append($video);
    } else {
        const $img = $(`<img src="${url}" class="lb-media">`);
        $container.append($img);
        
        // Reset Zoom
        // Implement zoom/pan logic if needed, for now standard css fit
    }
    
    $('.lb-counter').text(`${index + 1} / ${galleryState.images.length}`);
    $('.lb-filename').text(filename);
}

function navigateLightbox(dir) {
    let newIndex = galleryState.selectedIndex + dir;
    if (newIndex < 0) newIndex = galleryState.images.length - 1;
    if (newIndex >= galleryState.images.length) newIndex = 0;
    
    galleryState.selectedIndex = newIndex;
    updateLightboxContent();
}

async function deleteCurrentLightboxImage() {
    if (!confirm('Delete current image?')) return;
    
    const index = galleryState.selectedIndex;
    const filename = galleryState.images[index];
    const path = `user/images/${galleryState.currentFolder}/${filename}`;
    
    if (await deleteImageAPI(path)) {
        galleryState.images.splice(index, 1);
        toastr.success('Image deleted');
        
        if (galleryState.images.length === 0) {
            $('#ct-gallery-lightbox').hide();
            loadFolder(galleryState.currentFolder);
        } else {
            navigateLightbox(0); // Determine correct next index
            loadFolder(galleryState.currentFolder); // Refresh grid backing
        }
    }
}

function downloadCurrentLightboxImage() {
    const filename = galleryState.images[galleryState.selectedIndex];
    const url = `user/images/${encodeURIComponent(galleryState.currentFolder)}/${encodeURIComponent(filename)}`;
    
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
}

// --- Upload ---
async function handleUpload(e) {
    const files = e.target.files;
    if (!files.length) return;
    
    const folder = galleryState.currentFolder;
    if (!folder) return toastr.error("No folder selected");
    
    const context = getContext();
    const getRequestHeaders = context?.getRequestHeaders || (() => ({}));
    
    let success = 0;
    
    for (let i = 0; i < files.length; i++) {
        const file = files[i];
         try {
            const reader = new FileReader();
            await new Promise((resolve, reject) => {
                reader.onload = async () => {
                   try {
                     const base64Data = reader.result.split(',')[1];
                     const extension = file.name.split('.').pop();
                     const fileName = file.name.replace(/\./g, '_').replace(/\.[^.]+$/, '');
                     
                     const response = await fetch('/api/images/upload', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            ...getRequestHeaders(),
                        },
                        body: JSON.stringify({
                            image: base64Data,
                            format: extension,
                            ch_name: folder,
                            filename: fileName,
                        }),
                     });
                     
                     if (response.ok) {
                         success++;
                         resolve();
                     } else {
                         reject('Upload failed');
                     }
                   } catch (err) { reject(err); }
                };
                reader.onerror = reject;
                reader.readAsDataURL(file);
            });
         } catch (err) {
             console.error('Upload Error', err);
         }
    }
    
    if (success > 0) {
        toastr.success(`Uploaded ${success} files details.`);
        loadFolder(folder);
    } else {
        toastr.error("Failed to upload files.");
    }
    
    // Clear input
    e.target.value = '';
}


// --- Integrations ---

// Robust Sidebar Injection
function injectSidebarButton() {
    // Check if CTSidebarButtons API is available
    if (typeof window.CTSidebarButtons === "undefined") {
        console.warn('CT-GalleryExplorer: CTSidebarButtons not found. Retrying in 500ms...');
        setTimeout(injectSidebarButton, 500);
        return;
    }

    window.CTSidebarButtons.registerButton({
        id: 'ct-gallery',
        icon: 'fa-solid fa-images',
        title: 'Gallery Explorer',
        onClick: () => openGallery(),
        order: 40
    });
    console.log('CT-GalleryExplorer: Sidebar button registered.');
}

function injectCharacterHeaderButton() {
    // Character Top Bar Icons (Context dependent)
    const injectHeader = () => {
        // Match reference implementation using #rm_buttons_container
        const container = $('#rm_buttons_container');
        
        if (container.length && !$('#char-gallery-btn').length) {
            const buttonHtml = `
                <div id="char-gallery-btn" class="menu_button fa-solid fa-images interactable" title="Gallery Explorer" onclick="window.CTGallery.open()"></div>
            `;
            
            // Try to place after lorebook button like reference
            const lorebookButton = $('.chat_lorebook_button');
            if (lorebookButton.length) {
                lorebookButton.after(buttonHtml);
            } else {
                container.append(buttonHtml);
            }
        }
    };

    const interval = setInterval(() => {
        injectHeader();
    }, 2000);
}


// --- Initialization ---

jQuery(async () => {
    loadSettings();
    
    // Expose API
    window.CTGallery = {
        open: openGallery,
        close: closeGallery,
        loadFolder: loadFolder
    };
    
    // Event listeners for global events
    if (eventSource) {
        eventSource.on(event_types.CHARACTER_LOADED, () => {
            // Auto switch folder if gallery is open
             if ($('#ct-gallery-explorer').is(':visible')) {
                 const context = getContext();
                 if (context.characters[context.characterId]) {
                     loadFolder(context.characters[context.characterId].name);
                 }
             }
        });
    }
    
    // Register sidebar button immediately (like reference implementation)
    injectSidebarButton();
    
    // Also try to register on APP_READY in case CTSidebarButtons loads later
    if (eventSource && event_types.APP_READY) {
        eventSource.on(event_types.APP_READY, () => {
            injectSidebarButton();
        });
    }
    
    injectCharacterHeaderButton();
    
    console.log(`${extensionName} Loaded`);
});
