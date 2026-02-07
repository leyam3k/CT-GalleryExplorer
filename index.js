const extensionName = "SillyTavern-ImageGallery";

let currentFolder = '';
let currentImages = [];
let currentImageIndex = -1;

// Selection Mode State
let isSelectionMode = false;
let selectedImages = new Set();

let galleryRect = null;
let viewerRect = null;

try {
    const saved = localStorage.getItem('ST-ImageGallery-State');
    if (saved) {
        const parsed = JSON.parse(saved);
        if (parsed.galleryRect) galleryRect = parsed.galleryRect;
        if (parsed.viewerRect) viewerRect = parsed.viewerRect;
    }
} catch (e) {
    console.error('Failed to load gallery state', e);
}

function saveState() {
    const state = {
        galleryRect,
        viewerRect
    };
    localStorage.setItem('ST-ImageGallery-State', JSON.stringify(state));
}

let zoomLevel = 1;
let panX = 0;
let panY = 0;
let isDragging = false;
let startX = 0;
let startY = 0;

function ensureOnScreen(rect, defaultWidth, defaultHeight) {
    if (!rect) {
        return {
            top: (window.innerHeight - defaultHeight) / 2,
            left: (window.innerWidth - defaultWidth) / 2,
            width: defaultWidth,
            height: defaultHeight
        };
    }

    let { top, left, width, height } = rect;

    if (!width || width < 100) width = defaultWidth;
    if (!height || height < 100) height = defaultHeight;

    if (width > window.innerWidth) width = window.innerWidth;
    if (height > window.innerHeight) height = window.innerHeight;

    if (left < 0) left = 0;
    if (top < 0) top = 0;

    if (left + width > window.innerWidth) left = window.innerWidth - width;
    if (top + height > window.innerHeight) top = window.innerHeight - height;

    if (left < 0) left = 0;
    if (top < 0) top = 0;

    return { top, left, width, height };
}

async function apiPost(url, data) {
    return new Promise((resolve, reject) => {
        $.ajax({
            type: 'POST',
            url: url,
            data: JSON.stringify(data),
            contentType: 'application/json',
            success: function (response) {
                resolve(response);
            },
            error: function (xhr, status, error) {
                const msg = xhr.responseText || error || status;
                console.error('API Error:', msg);
                reject(new Error(msg));
            }
        });
    });
}

let maxZIndex = 100000;
function bringToFront($element) {
    maxZIndex++;
    $element.css('z-index', maxZIndex);
}


let renderReqId = null;
let latestRequestedFolder = null;
let activeXhr = null;

async function loadFolders() {
    try {
        const folders = await apiPost('/api/images/folders', {});
        renderFolders(folders);
    } catch (err) {
        console.error('Gallery Fetch Folders Error:', err);
        if (window.toastr) toastr.error('Failed to load folders');
    }
}

let sortOrder = 'newest';

function sortImages(images) {
    return images.sort((a, b) => {
        const dateRegex = /(\d{4})[-]?(\d{2})[-]?(\d{2})/;
        const matchA = a.match(dateRegex);
        const matchB = b.match(dateRegex);

        let dateA = matchA ? new Date(`${matchA[1]}-${matchA[2]}-${matchA[3]}`).getTime() : 0;
        let dateB = matchB ? new Date(`${matchB[1]}-${matchB[2]}-${matchB[3]}`).getTime() : 0;

        let diff = 0;
        if (sortOrder === 'newest') {
            diff = dateB - dateA;
        } else {
            diff = dateA - dateB;
        }

        if (diff !== 0) return diff;

        if (sortOrder === 'newest') {
            return b.localeCompare(a, undefined, { numeric: true, sensitivity: 'base' });
        } else {
            return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
        }
    });
}

async function loadImages(folder) {
    if (!folder) return;
    latestRequestedFolder = folder;

    $('#gallery-loading-indicator').show();
    $('#gallery-image-grid').css('opacity', '0.5');

    if (activeXhr) {
        activeXhr.abort();
        activeXhr = null;
    }

    let localXhr = null;

    try {
        const images = await new Promise((resolve, reject) => {
            localXhr = $.ajax({
                type: 'POST',
                url: '/api/images/list',
                data: JSON.stringify({ folder: folder }),
                contentType: 'application/json',
                success: resolve,
                error: (xhr, textStatus, errorThrown) => reject({ xhr, textStatus, errorThrown })
            });
            activeXhr = localXhr;
        });

        if (activeXhr === localXhr) activeXhr = null;

        if (latestRequestedFolder !== folder) return;

        if (!Array.isArray(images)) throw new Error("Invalid API response");

        const sorted = sortImages(images);
        renderImages(sorted, folder);
    } catch (err) {
        if (activeXhr === localXhr) activeXhr = null;

        if (err.textStatus === 'abort' || err.status === 'abort' || (err.xhr && err.xhr.statusText === 'abort')) {
            return;
        }

        if (latestRequestedFolder !== folder) return;

        console.warn(`Gallery: Failed to load folder '${folder}'`, err);
        if (window.toastr) toastr.error(`Failed to load images.`);
        $('#gallery-image-grid').html('<div style="padding:20px;">Error loading images.</div>');
    } finally {
        if (latestRequestedFolder === folder) {
            $('#gallery-loading-indicator').hide();
            $('#gallery-image-grid').css('opacity', '1');
        }
    }
}

async function deleteImage(path) {
    if (!confirm('Are you sure you want to delete this image?')) return;

    try {
        await apiPost('/api/images/delete', { path: path });

        if (window.toastr) toastr.success('Image deleted');

        $('#st-viewer-window').remove();

        if (currentFolder) loadImages(currentFolder);
    } catch (err) {
        console.error('Delete Error:', err);
    }
}

function renderFolders(folders) {
    const container = $('#gallery-folder-list');
    const mobileSelect = $('#gallery-mobile-folder-select');

    container.empty();
    mobileSelect.empty();

    mobileSelect.append('<option value="" disabled selected>Select Folder...</option>');

    currentFolder = '';

    if (folders.length === 0) {
        container.html('<div style="padding:20px; text-align:center; color:#888;">No folders found.</div>');
        mobileSelect.append('<option disabled>No folders</option>');
        return;
    }

    folders.forEach(folder => {
        const item = $(`
            <div class="list-group-item interactable folder-item" title="${folder}">
                <div class="list-group-item-action">
                    <i class="fa-solid fa-folder"></i>
                </div>
                <div class="list-group-item-label">${folder}</div>
            </div>
        `);
        item.on('click', () => {
            loadImages(folder);
            $('#gallery-folder-list .folder-item').removeClass('active');
            item.addClass('active');
            mobileSelect.val(folder);
        });
        container.append(item);

        mobileSelect.append(`<option value="${folder}">${folder}</option>`);
    });
}

function renderImages(images, folder) {
    if (renderReqId) {
        cancelAnimationFrame(renderReqId);
        renderReqId = null;
    }

    currentImages = images;
    currentFolder = folder;
    const container = $('#gallery-image-grid');
    container.empty();

    $('#gallery-folder-list .folder-item').removeClass('active');
    $(`#gallery-folder-list .folder-item:contains("${folder}")`).filter((i, e) => $(e).text().trim() === folder).addClass('active');
    $('#gallery-mobile-folder-select').val(folder);

    if (images.length === 0) {
        container.html('<div style="padding:20px; text-align:center; color:#888;">No images found.</div>');
        return;
    }

    const pageSize = 24;
    let renderIndex = 0;

    $('#gallery-load-more').remove();

    function renderNextPage() {
        const chunk = images.slice(renderIndex, renderIndex + pageSize);
        if (chunk.length === 0) return;

        const fragment = document.createDocumentFragment();

        chunk.forEach((img, i) => {
            const globalIndex = renderIndex + i;
            const safeFolder = encodeURIComponent(folder);
            const safeFilename = encodeURIComponent(img);
            const url = `user/images/${safeFolder}/${safeFilename}`;

            const card = document.createElement('div');
            card.className = 'gallery-image-card interactable';
            card.dataset.filename = img;
            card.title = img;

            // Selection checkbox
            const checkbox = document.createElement('div');
            checkbox.className = 'selection-checkbox';
            card.appendChild(checkbox);

            card.onclick = () => {
                if (isSelectionMode) {
                    toggleImageSelection(img, card);
                } else {
                    openImageModal(globalIndex);
                }
            };

            const thumb = document.createElement('img');
            thumb.src = url;
            thumb.loading = 'lazy';

            const label = document.createElement('div');
            label.className = 'image-label';
            label.innerText = img;

            card.appendChild(thumb);
            card.appendChild(label);
            fragment.appendChild(card);
        });

        container.append(fragment);
        renderIndex += pageSize;

        $('#gallery-load-more').remove();

        if (renderIndex < images.length) {
            const remaining = images.length - renderIndex;
            const loadMoreBtn = $(`
                <button id="gallery-load-more" class="gallery-load-more-btn">
                    <i class="fa-solid fa-plus-circle"></i> Load More (${remaining})
                </button>
            `);
            loadMoreBtn.on('click', renderNextPage);
            container.append(loadMoreBtn);
        }
    }

    renderNextPage();
}

// ==================== Selection Mode Functions ====================

function enterSelectionMode() {
    isSelectionMode = true;
    selectedImages.clear();
    $('#st-image-gallery').addClass('selection-mode');
    $('#gallery-normal-controls').hide();
    $('#gallery-selection-controls').show();
    updateSelectionCounter();
}

function exitSelectionMode() {
    isSelectionMode = false;
    selectedImages.clear();
    $('#st-image-gallery').removeClass('selection-mode');
    $('#gallery-normal-controls').show();
    $('#gallery-selection-controls').hide();
    $('#gallery-image-grid .gallery-image-card').removeClass('selected');
}

function toggleImageSelection(filename, cardElement) {
    if (selectedImages.has(filename)) {
        selectedImages.delete(filename);
        $(cardElement).removeClass('selected');
    } else {
        selectedImages.add(filename);
        $(cardElement).addClass('selected');
    }
    updateSelectionCounter();
}

function updateSelectionCounter() {
    const count = selectedImages.size;
    $('#selection-counter').text(`${count}개 선택`);

    // Disable/enable delete and download buttons based on selection
    if (count === 0) {
        $('#gallery-delete-selected, #gallery-download-selected').addClass('disabled').css('opacity', '0.3');
    } else {
        $('#gallery-delete-selected, #gallery-download-selected').removeClass('disabled').css('opacity', '1');
    }
}

function showDeleteConfirmModal(count, onConfirm) {
    const modalHtml = `
        <div id="delete-confirm-modal" class="delete-confirm-modal">
            <div class="delete-confirm-content">
                <h3>이미지 삭제</h3>
                <p>${count}개의 이미지를 삭제하시겠습니까?</p>
                <p style="color: #ff6666; font-size: 0.9em;">이 작업은 되돌릴 수 없습니다.</p>
                <div class="delete-confirm-buttons">
                    <button class="delete-confirm-btn cancel">취소</button>
                    <button class="delete-confirm-btn confirm">삭제</button>
                </div>
            </div>
        </div>
    `;

    $('body').append(modalHtml);

    $('#delete-confirm-modal .cancel').on('click', () => {
        $('#delete-confirm-modal').remove();
    });

    $('#delete-confirm-modal .confirm').on('click', () => {
        $('#delete-confirm-modal').remove();
        onConfirm();
    });
}

async function deleteSelectedImages() {
    if (selectedImages.size === 0) return;

    showDeleteConfirmModal(selectedImages.size, async () => {
        const toDelete = Array.from(selectedImages);
        let successCount = 0;
        let failCount = 0;

        for (const filename of toDelete) {
            try {
                const relativePath = `user/images/${currentFolder}/${filename}`;
                await apiPost('/api/images/delete', { path: relativePath });
                successCount++;
            } catch (e) {
                console.error(`Failed to delete ${filename}:`, e);
                failCount++;
            }
        }

        if (window.toastr) {
            if (failCount === 0) {
                toastr.success(`${successCount}개의 이미지가 삭제되었습니다.`);
            } else {
                toastr.warning(`${successCount}개 삭제됨, ${failCount}개 실패`);
            }
        }

        exitSelectionMode();
        loadImages(currentFolder);
    });
}

async function downloadSelectedImages() {
    if (selectedImages.size === 0) return;

    const toDownload = Array.from(selectedImages);

    for (const filename of toDownload) {
        try {
            const safeFolder = encodeURIComponent(currentFolder);
            const safeFilename = encodeURIComponent(filename);
            const imageUrl = `user/images/${safeFolder}/${safeFilename}`;

            const response = await fetch(imageUrl);
            const blob = await response.blob();
            const url = window.URL.createObjectURL(blob);

            const a = document.createElement('a');
            a.style.display = 'none';
            a.href = url;
            a.download = filename;
            document.body.appendChild(a);
            a.click();

            setTimeout(() => {
                window.URL.revokeObjectURL(url);
                document.body.removeChild(a);
            }, 100);

            // Small delay between downloads to prevent browser blocking
            await new Promise(resolve => setTimeout(resolve, 200));
        } catch (e) {
            console.error(`Failed to download ${filename}:`, e);
        }
    }

    if (window.toastr) {
        toastr.success(`${toDownload.length}개의 이미지 다운로드 완료`);
    }

    exitSelectionMode();
}

// ==================== End Selection Mode Functions ====================

function createGalleryWindow() {
    if ($('#st-image-gallery').length) {
        const $gallery = $('#st-image-gallery');
        $gallery.show().css('display', 'flex');
        bringToFront($gallery);
        return;
    }

    const galleryHtml = `
        <div id="st-image-gallery" class="st-gallery-window" style="display:none;">
            <div class="gallery-header">
                <span class="gallery-title">이미지 갤러리</span>
                <div class="gallery-controls" id="gallery-normal-controls">
                    <i id="gallery-select" class="fa-solid fa-check-square" title="Selection Mode"></i>
                    <i id="gallery-go-char" class="fa-solid fa-user-circle" title="Go to Current Character"></i>
                    <i id="gallery-sort" class="fa-solid fa-sort-amount-down" title="Sort Order: Newest First"></i>
                    <i id="gallery-refresh" class="fa-solid fa-sync-alt" title="Refresh"></i>
                    <i id="gallery-close" class="fa-solid fa-times" title="Close"></i>
                </div>
                <div class="gallery-controls selection-controls" id="gallery-selection-controls" style="display:none;">
                    <span class="selection-counter" id="selection-counter">0개 선택</span>
                    <i id="gallery-select-all" class="fa-solid fa-check-double" title="Select All"></i>
                    <i id="gallery-download-selected" class="fa-solid fa-download" title="Download Selected"></i>
                    <i id="gallery-delete-selected" class="fa-solid fa-trash warning" title="Delete Selected"></i>
                    <i id="gallery-cancel-select" class="fa-solid fa-times" title="Cancel Selection"></i>
                </div>
            </div>
            <div class="gallery-content">
            <div class="gallery-content">
                <select id="gallery-mobile-folder-select" style="display:none;"></select>
                <div id="gallery-folder-list" class="gallery-sidebar"></div>
                <div id="gallery-sidebar-resizer" class="gallery-sidebar-resizer"></div>
                <div id="gallery-image-grid" class="gallery-grid"></div>
                <div id="gallery-loading-indicator" class="gallery-loading" style="display:none;">
                    <i class="fa-solid fa-spinner fa-spin"></i>
                </div>
            </div>
            </div>
            </div>
        </div>
    `;

    $('body').append(galleryHtml);
    const $gallery = $('#st-image-gallery');

    if (window.ResizeObserver) {
        const resizeObserver = new ResizeObserver(entries => {
            for (let entry of entries) {
                if (entry.contentRect.width < 600) {
                    $gallery.addClass('st-gallery-compact');
                } else {
                    $gallery.removeClass('st-gallery-compact');
                }
            }
        });
        resizeObserver.observe($gallery[0]);

        $gallery.on('remove', () => {
            resizeObserver.disconnect();
        });
    }

    const rect = ensureOnScreen(galleryRect, 800, 600);

    const isMobile = window.matchMedia("(max-width: 768px)").matches;

    if (!isMobile) {
        $gallery.css({
            width: rect.width + 'px',
            height: rect.height + 'px',
            left: rect.left + 'px',
            top: rect.top + 'px',
            display: 'flex'
        });
    } else {
        $gallery.css({ display: 'flex' });
    }

    if (!isMobile) {
        $gallery.draggable({
            handle: '.gallery-header',
            containment: 'window',
            start: function () { bringToFront($(this)); },
            stop: function (event, ui) {
                galleryRect = {
                    top: ui.position.top,
                    left: ui.position.left,
                    width: $gallery.width(),
                    height: $gallery.height()
                };
                saveState();
            }
        }).resizable({
            handles: 'n, e, s, w, ne, se, sw, nw',
            minHeight: 300,
            minWidth: 400,
            stop: function (event, ui) {
                galleryRect = {
                    top: ui.position.top,
                    left: ui.position.left,
                    width: ui.size.width,
                    height: ui.size.height
                };
                saveState();
            }
        });

        $gallery.on('mousedown', function () {
            bringToFront($(this));
        });
        bringToFront($gallery);
    }

    const $resizer = $('#gallery-sidebar-resizer');
    const $sidebar = $('#gallery-folder-list');

    $resizer.on('mousedown', function (e) {
        e.preventDefault();
        const startX = e.clientX;
        const startWidth = $sidebar.width();

        $(document).on('mousemove.sidebar-resize', function (e) {
            const newWidth = startWidth + (e.clientX - startX);
            if (newWidth > 100 && newWidth < 400) {
                $sidebar.width(newWidth);
            }
        });

        $(document).on('mouseup.sidebar-resize', function () {
            $(document).off('mousemove.sidebar-resize');
            $(document).off('mouseup.sidebar-resize');
        });
    });

    function shutdownGallery() {
        if (activeXhr) {
            activeXhr.abort();
            activeXhr = null;
        }
        if (renderReqId) {
            cancelAnimationFrame(renderReqId);
            renderReqId = null;
        }
        // Reset selection mode state
        isSelectionMode = false;
        selectedImages.clear();
        $('#st-image-gallery').remove();
    }

    $('#gallery-close').off('click').on('click', shutdownGallery);
    $('#gallery-refresh').on('click', () => {
        if (currentFolder) loadImages(currentFolder);
        else loadFolders();
    });

    $('#gallery-sort').on('click', function () {
        sortOrder = sortOrder === 'newest' ? 'oldest' : 'newest';
        const isNewest = sortOrder === 'newest';

        $(this).attr('title', `Sort Order: ${isNewest ? 'Newest First' : 'Oldest First'}`);

        $(this).removeClass('fa-sort-amount-down fa-sort-amount-up');
        $(this).addClass(isNewest ? 'fa-sort-amount-down' : 'fa-sort-amount-up');

        if (currentImages.length > 0) {
            const sorted = sortImages(currentImages);
            renderImages(sorted, currentFolder);
        }
    });

    $('#gallery-go-char').on('click', () => {
        syncToCurrentCharacter();
    });

    $('#gallery-mobile-folder-select').on('change', function () {
        const selected = $(this).val();
        if (selected) loadImages(selected);
    });

    // Selection Mode Event Handlers
    $('#gallery-select').on('click', () => enterSelectionMode());
    $('#gallery-cancel-select').on('click', () => exitSelectionMode());

    $('#gallery-select-all').on('click', () => {
        const allCards = $('#gallery-image-grid .gallery-image-card');
        if (selectedImages.size === currentImages.length) {
            // Deselect all
            selectedImages.clear();
            allCards.removeClass('selected');
        } else {
            // Select all
            currentImages.forEach(img => selectedImages.add(img));
            allCards.addClass('selected');
        }
        updateSelectionCounter();
    });

    $('#gallery-delete-selected').on('click', () => deleteSelectedImages());
    $('#gallery-download-selected').on('click', () => downloadSelectedImages());

    loadFolders();

    if (currentFolder) {
        loadImages(currentFolder);
    } else {
        syncToCurrentCharacter();
    }
}

function syncToCurrentCharacter() {
    const context = SillyTavern.getContext();
    console.log('Gallery Sync: Context', context);

    if (context && context.characterId !== undefined) {
        let charName = context.name2;

        if (!charName && context.characters && context.characters[context.characterId]) {
            charName = context.characters[context.characterId].name;
        }

        if (charName) {
            console.log('Gallery Sync: Target:', charName);
            loadImages(charName);
        } else {
            console.warn('Gallery Sync: Character ID present but Name resolved to null');
            if (currentFolder === '') loadFolders();
        }
    } else {
        console.log('Gallery Sync: No character selected');
        if (currentFolder === '') loadFolders();
    }
}

function openGallery() {
    createGalleryWindow();
}

function openImageModal(index) {
    if (index < 0 || index >= currentImages.length) return;
    currentImageIndex = index;
    const filename = currentImages[index];
    const safeFolder = encodeURIComponent(currentFolder);
    const safeFilename = encodeURIComponent(filename);
    const imageUrl = `user/images/${safeFolder}/${safeFilename}`;

    const modalId = 'st-image-viewer';

    let $modal = $('#' + modalId);
    if ($modal.length === 0) {
        let modalHtml = `
            <div id="${modalId}" class="st-gallery-window image-viewer-window" style="display:none;">
                <div class="gallery-header">
                    <div class="gallery-title" id="viewer-title">${filename}</div>
                    <div class="gallery-controls">
                        <!-- Controls -->
                        <i class="fa-solid fa-expand interactable" id="viewer-toggle-fit" title="Toggle Size (Fit/Original)"></i>
                        <span class="separator" style="margin: 0 5px; opacity: 0.3;">|</span>
                        <i class="fa-solid fa-download interactable" id="viewer-download" title="Download"></i>
                        <i class="fa-solid fa-trash interactable warning" id="viewer-delete" title="Delete"></i>
                        <i class="fa-solid fa-times interactable" id="viewer-close" title="Close"></i>
                    </div>
                </div>
                <div class="viewer-content">
                    <div class="viewer-nav-btn prev" id="viewer-prev"><i class="fa-solid fa-chevron-left"></i></div>
                    <div class="viewer-msg" id="viewer-msg"></div>
                    <img src="${imageUrl}" id="viewer-image" draggable="false">
                    <div class="viewer-nav-btn next" id="viewer-next"><i class="fa-solid fa-chevron-right"></i></div>
                </div>
            </div>
        `;

        if (window.matchMedia("(max-width: 768px)").matches) {
            modalHtml = modalHtml.replace(/<div class="viewer-nav-btn.*?<\/div>/g, '');
        }

        $('body').append(modalHtml);
        $modal = $('#' + modalId);


        const rect = ensureOnScreen(viewerRect, 600, 700);

        $modal.css({
            width: rect.width + 'px',
            height: rect.height + 'px',
            left: rect.left + 'px',
            top: rect.top + 'px',
            display: 'flex'
        });

        $modal.draggable({
            handle: '.gallery-header',
            containment: 'window',
            stop: function (event, ui) {
                viewerRect = {
                    top: ui.position.top,
                    left: ui.position.left,
                    width: $modal.width(),
                    height: $modal.height()
                };
                saveState();
            }
        }).resizable({
            minHeight: 300,
            minWidth: 300,
            stop: function (event, ui) {
                viewerRect = {
                    top: ui.position.top,
                    left: ui.position.left,
                    width: ui.size.width,
                    height: ui.size.height
                };
                saveState();
            }
        });

        $('#viewer-close').on('click', () => $modal.remove());

        if (window.matchMedia("(max-width: 768px)").matches) {
            $modal.find('.viewer-nav-btn').hide();
        }

        $(document).on('keydown.viewer', function (e) {
            if ($('#' + modalId).length === 0) {
                $(document).off('keydown.viewer');
                return;
            }
            if (e.key === 'ArrowLeft') $('#viewer-prev').click();
            if (e.key === 'ArrowRight') $('#viewer-next').click();
            if (e.key === 'Escape') $modal.remove();
        });

    } else {
        $modal.find('#viewer-image').attr('src', imageUrl);
        $modal.find('#viewer-title').text(filename);
    }

    const navigateImage = (offset) => {
        let newIndex = currentImageIndex + offset;
        if (newIndex < 0) newIndex = currentImages.length - 1;
        if (newIndex >= currentImages.length) newIndex = 0;
        openImageModal(newIndex);
    };

    $('#viewer-prev').off('click').on('click', () => navigateImage(-1));
    $('#viewer-next').off('click').on('click', () => navigateImage(1));

    setupImageInteractions($modal, imageUrl, filename, navigateImage);
}

function setupImageInteractions($modal, imageUrl, filename, navigateImage) {
    const img = $modal.find('#viewer-image');
    const content = $modal.find('.viewer-content');

    let state = {
        scale: 1,
        translateX: 0,
        translateY: 0,
        isDragging: false,
        startX: 0,
        startY: 0,
        lastX: 0,
        lastY: 0,
        initialPinchDistance: 0,
        initialScale: 1
    };

    let isRenderPending = false;
    const render = () => {
        if (!isRenderPending) {
            requestAnimationFrame(() => {
                img.css('transform', `translate(${state.translateX}px, ${state.translateY}px) scale(${state.scale})`);
                if (state.isDragging || state.scale !== 1) {
                    img.css('will-change', 'transform');
                } else {
                    img.css('will-change', 'auto');
                }
                isRenderPending = false;
            });
            isRenderPending = true;
        }
    };

    render();

    content.off('mousedown.viewer').on('mousedown.viewer', function (e) {
        if ($(e.target).closest('.viewer-nav-btn').length) return;
        e.preventDefault();

        state.isDragging = true;
        state.startX = e.clientX - state.translateX;
        state.startY = e.clientY - state.translateY;
        content.css('cursor', 'grabbing');
    });

    $(document).off('mousemove.viewer').on('mousemove.viewer', function (e) {
        if (state.isDragging) {
            state.translateX = e.clientX - state.startX;
            state.translateY = e.clientY - state.startY;
            render();
        }
    });

    $(document).off('mouseup.viewer').on('mouseup.viewer', function () {

        if (state.isDragging) {
            state.isDragging = false;
            content.css('cursor', 'default');
        }
    });

    // --- Double Click Zoom (PC) ---
    content.off('dblclick.viewer').on('dblclick.viewer', function (e) {
        if ($(e.target).closest('.viewer-nav-btn').length) return;
        e.preventDefault();

        if (Math.abs(state.scale - 1) < 0.1) {
            state.scale = 2; // Fixed 2x zoom
        } else {
            state.scale = 1;
            state.translateX = 0;
            state.translateY = 0;
        }
        render();
    });


    const doubleTapDelay = 300;

    let lastTapTime = 0;
    let touchStartX = 0;
    let touchStartY = 0;


    const swipeThreshold = 30;

    content.off('touchstart.viewer').on('touchstart.viewer', function (e) {
        if ($(e.target).closest('.viewer-nav-btn').length) return;

        const touches = e.touches;

        if (touches.length === 1) {
            const currentTime = new Date().getTime();
            const tapLength = currentTime - lastTapTime;

            if (tapLength < doubleTapDelay && tapLength > 0) {
                e.preventDefault();
                if (Math.abs(state.scale - 1) < 0.1) {
                    state.scale = 2;
                } else {
                    state.scale = 1;
                    state.translateX = 0;
                    state.translateY = 0;
                }
                render();
                return;
            }
            lastTapTime = currentTime;

            touchStartX = touches[0].clientX;
            touchStartY = touches[0].clientY;

            state.isDragging = true;
            state.dragStartOffsetX = touches[0].clientX - state.translateX;
            state.dragStartOffsetY = touches[0].clientY - state.translateY;

        } else if (touches.length === 2) {
            state.isDragging = false;
            state.initialPinchDistance = Math.hypot(
                touches[0].clientX - touches[1].clientX,
                touches[0].clientY - touches[1].clientY
            );
            state.initialScale = state.scale;
        }
    });

    content.off('touchmove.viewer').on('touchmove.viewer', function (e) {
        e.preventDefault();

        const touches = e.touches;

        if (touches.length === 1 && state.isDragging) {

            if (state.scale > 1.05) {
                state.translateX = touches[0].clientX - state.dragStartOffsetX;
                state.translateY = touches[0].clientY - state.dragStartOffsetY;
            } else {
                const computedX = touches[0].clientX - state.dragStartOffsetX;

                state.translateX = computedX;
                state.translateY = 0;
            }
            render();

        } else if (touches.length === 2) {
            const currentDistance = Math.hypot(
                touches[0].clientX - touches[1].clientX,
                touches[0].clientY - touches[1].clientY
            );

            if (state.initialPinchDistance > 0) {
                const newScale = state.initialScale * (currentDistance / state.initialPinchDistance);
                state.scale = Math.max(0.1, Math.min(newScale, 5));
                render();
            }
        }
    });

    content.off('touchend.viewer').on('touchend.viewer', function (e) {
        if (e.touches.length === 0) {
            state.isDragging = false;

            if (state.scale <= 1.05) {

                const diffX = state.translateX;

                if (Math.abs(diffX) > swipeThreshold) {
                    if (diffX > 0) {
                        if (navigateImage) navigateImage(-1);
                    } else {
                        if (navigateImage) navigateImage(1);
                    }
                    state.translateX = 0;
                } else {
                    state.translateX = 0;
                    render();
                }
            } else {
            }

        } else if (e.touches.length === 1) {
            state.dragStartOffsetX = e.touches[0].clientX - state.translateX;
            state.dragStartOffsetY = e.touches[0].clientY - state.translateY;
            state.isDragging = true;
        }
    });

    content.off('wheel.viewer').on('wheel.viewer', function (e) {
        e.preventDefault();
        const delta = e.originalEvent.deltaY > 0 ? -0.1 : 0.1;
        state.scale = Math.max(0.1, Math.min(state.scale + delta, 5));
        render();
    });

    $modal.on('mousedown', function () {
        bringToFront($modal);
    });

    bringToFront($modal);

    $modal.find('#viewer-toggle-fit').off('click').on('click', function () {
        const $icon = $(this);
        const domImg = img[0];

        const isCurrentlyFitted = Math.abs(state.scale - 1) < 0.05;

        if (isCurrentlyFitted) {
            if (domImg.naturalWidth && domImg.width) {
                const naturalRatio = domImg.naturalWidth / domImg.naturalHeight;
                const containerRatio = domImg.width / domImg.height;

                let paintedWidth;
                if (containerRatio > naturalRatio) {
                    paintedWidth = domImg.height * naturalRatio;
                } else {
                    paintedWidth = domImg.width;
                }

                state.scale = domImg.naturalWidth / paintedWidth;
                state.translateX = 0;
                state.translateY = 0;
                render();

                $icon.removeClass('fa-expand').addClass('fa-compress');
            }
        } else {
            state.scale = 1;
            state.translateX = 0;
            state.translateY = 0;
            render();

            $icon.removeClass('fa-compress').addClass('fa-expand');
        }
    });

    $modal.find('#viewer-download').off('click').on('click', async () => {
        try {
            const response = await fetch(imageUrl);
            const blob = await response.blob();
            const url = window.URL.createObjectURL(blob);

            const a = document.createElement('a');
            a.style.display = 'none';
            a.href = url;
            a.download = filename;
            document.body.appendChild(a);
            a.click();

            setTimeout(() => {
                window.URL.revokeObjectURL(url);
                document.body.removeChild(a);
            }, 100);
        } catch (e) {
            console.error('Download failed, falling back to direct link', e);
            const a = document.createElement('a');
            a.href = imageUrl;
            a.download = filename;
            a.target = '_blank';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
        }
    });

    $modal.find('#viewer-delete').off('click').on('click', async () => {
        if (confirm('Are you sure you want to delete this image?')) {
            try {

                const relativePath = `user/images/${currentFolder}/${filename}`;

                await apiPost('/api/images/delete', { path: relativePath });

                currentImages.splice(currentImageIndex, 1);
                if (currentImages.length === 0) {
                    $modal.remove();
                    loadImages(currentFolder);
                } else {
                    if (currentImageIndex >= currentImages.length) currentImageIndex = currentImages.length - 1;
                    openImageModal(currentImageIndex);
                    loadImages(currentFolder);
                }
                if (window.toastr) toastr.success('Image deleted');
            } catch (e) {
                console.error("Delete failed", e);
                alert('Failed to delete image: ' + (e.message || e));
            }
        }
    });

    const resizeObserver = new ResizeObserver(() => {
        render();
    });
    resizeObserver.observe($modal[0]);

    $modal.on('remove', () => resizeObserver.disconnect());
}

window.openGallery = openGallery;

jQuery(async () => {
    if (window.SlashCommandParser && window.SlashCommandParser.addCommandObject) {
        window.SlashCommandParser.addCommandObject(window.SlashCommandParser.commands.createCommandObject(
            'gallery',
            {},
            () => { openGallery(); return "Opening Gallery..."; },
            'Open Image Gallery'
        ));
    }

    const addGalleryButton = () => {
        const extensionsMenu = $('#extensionsMenu');
        if (extensionsMenu.length) {
            extensionsMenu.append(`
                <div class="list-group-item interactable" onclick="window.openGallery()">
                    <div class="list-group-item-action">
                        <i class="fa-solid fa-images"></i>
                    </div>
                    <div class="list-group-item-label">
                        이미지 갤러리
                    </div>
                </div>
            `);
            console.log('Image Gallery button added to Extensions Menu');
        } else {
            console.warn('Extensions Menu not found, retrying...');
            setTimeout(addGalleryButton, 500);
        }
    };
    addGalleryButton();

    function onCharacterLoaded(data) {
        if ($('#st-image-gallery').is(':visible')) {
            setTimeout(() => {
                syncToCurrentCharacter();
            }, 100);
        }
    }

    if (window.eventSource) {
        const evtName = (window.event_types && window.event_types.CHARACTER_LOADED) ? window.event_types.CHARACTER_LOADED : 'characterLoaded';
        eventSource.on(evtName, onCharacterLoaded);
        console.log('Gallery: Registered Sync Listener for', evtName);
    }

    window.openGallery = openGallery;
    console.log(`${extensionName} Loaded`);
});
