(function () {
    'use strict';
    var platform = window.ArabExpertPlatform;
    var config = platform && platform.config;
    var root = document.getElementById('admin-root');
    if (!root || !platform) return;

    var escapeHtml = platform.escapeHtml;

    function nowIso() { return new Date().toISOString(); }

    function slugify(value) {
        var slug = String(value || '').trim().toLowerCase()
            .replace(/[^\w؀-ۿ]+/g, '-')
            .replace(/^-+|-+$/g, '');
        return slug || ('item-' + Date.now());
    }

    function setStatus(message, type) {
        var status = document.getElementById('admin-status');
        status.textContent = message;
        status.className = 'mb-5 rounded-lg p-3 text-sm ' + (type === 'error' ? 'bg-red-100 text-red-800' : 'bg-green-100 text-green-800');
        status.classList.remove('hidden');
    }

    // ===== Persistent session (access token + rotating refresh token) =====
    // Stored in localStorage (not sessionStorage) so the admin stays signed in
    // across browser restarts, same as any normal app. Supabase refresh tokens
    // are long-lived and rotate on every use; we always persist the newest one.
    var SESSION_KEY = 'arabExpert.adminSession';

    function loadStoredSession() {
        try {
            var raw = localStorage.getItem(SESSION_KEY);
            return raw ? JSON.parse(raw) : null;
        } catch (e) { return null; }
    }

    var storedSession = loadStoredSession();
    var sessionToken = storedSession ? storedSession.access_token : null;
    var refreshToken = storedSession ? storedSession.refresh_token : null;
    var tokenExpiresAt = storedSession ? storedSession.expires_at : null;
    var refreshTimer = null;
    var refreshPromise = null;

    function saveSession(tokenResponse) {
        sessionToken = tokenResponse.access_token;
        refreshToken = tokenResponse.refresh_token;
        tokenExpiresAt = tokenResponse.expires_at || (Math.floor(Date.now() / 1000) + (tokenResponse.expires_in || 3600));
        localStorage.setItem(SESSION_KEY, JSON.stringify({
            access_token: sessionToken,
            refresh_token: refreshToken,
            expires_at: tokenExpiresAt
        }));
        scheduleProactiveRefresh();
    }

    function clearSession() {
        sessionToken = null;
        refreshToken = null;
        tokenExpiresAt = null;
        localStorage.removeItem(SESSION_KEY);
        if (refreshTimer) { clearTimeout(refreshTimer); refreshTimer = null; }
    }

    // Refresh a couple of minutes before the access token actually expires so
    // normal use never hits a 401 in the first place.
    function scheduleProactiveRefresh() {
        if (refreshTimer) clearTimeout(refreshTimer);
        if (!tokenExpiresAt) return;
        var delayMs = Math.max((tokenExpiresAt - Math.floor(Date.now() / 1000) - 120) * 1000, 5000);
        refreshTimer = setTimeout(function () {
            ensureRefreshed().catch(function () { /* surfaced to the user on their next action */ });
        }, delayMs);
    }

    // A single in-flight refresh shared by every caller — boot() fires several
    // requests in parallel, and Supabase rotates the refresh token on each use,
    // so letting them each refresh independently would make all but the first
    // one fail with an already-used refresh token.
    function ensureRefreshed() {
        if (refreshPromise) return refreshPromise;
        if (!refreshToken) return Promise.reject(new Error('no refresh token'));
        refreshPromise = fetch(config.url.replace(/\/$/, '') + '/auth/v1/token?grant_type=refresh_token', {
            method: 'POST',
            headers: { apikey: config.anonKey, 'Content-Type': 'application/json' },
            body: JSON.stringify({ refresh_token: refreshToken })
        }).then(function (response) {
            if (!response.ok) throw new Error('refresh failed');
            return response.json();
        }).then(function (result) {
            saveSession(result);
            return sessionToken;
        }).finally(function () { refreshPromise = null; });
        return refreshPromise;
    }

    // Keep tabs in sync: if another tab refreshes (rotating the refresh token)
    // or logs out, pick that up here instead of racing it with a stale token.
    window.addEventListener('storage', function (event) {
        if (event.key !== SESSION_KEY) return;
        if (!event.newValue) { sessionToken = null; refreshToken = null; tokenExpiresAt = null; return; }
        try {
            var s = JSON.parse(event.newValue);
            sessionToken = s.access_token; refreshToken = s.refresh_token; tokenExpiresAt = s.expires_at;
        } catch (e) { /* ignore malformed value from another tab */ }
    });

    // ===== Core REST helper (covers both rest/v1 and auth/v1) =====
    // Builds fresh headers on every call instead of mutating the caller's
    // options object, so a 401-triggered retry with a refreshed token never
    // accidentally reuses the stale Authorization header from the first try.
    function performFetch(normalizedPath, basePath, callerOpts, token) {
        var opts = {};
        for (var key in callerOpts) { if (key !== 'headers') opts[key] = callerOpts[key]; }
        opts.headers = Object.assign({
            apikey: config.anonKey,
            Authorization: 'Bearer ' + (token || config.anonKey),
            'Content-Type': 'application/json',
            Accept: 'application/json'
        }, callerOpts.headers || {});
        return fetch(config.url.replace(/\/$/, '') + '/' + basePath + normalizedPath, opts);
    }

    function authFetch(path, options) {
        var callerOpts = options || {};
        var normalizedPath = path.replace(/^\/+/, '');
        var isFullPath = normalizedPath.indexOf('rest/v1/') === 0 || normalizedPath.indexOf('auth/v1/') === 0 || normalizedPath.indexOf('storage/v1/') === 0;
        var basePath = isFullPath ? '' : 'rest/v1/';
        return performFetch(normalizedPath, basePath, callerOpts, sessionToken).then(function (response) {
            if (response.status === 401 && sessionToken) {
                return ensureRefreshed().then(function (newToken) {
                    return performFetch(normalizedPath, basePath, callerOpts, newToken);
                }).catch(function () {
                    clearSession();
                    renderAuth();
                    throw new Error('انتهت جلسة الإدارة. يرجى تسجيل الدخول مرة أخرى.');
                });
            }
            return response;
        });
    }

    function request(path, options) {
        return authFetch(path, options).then(function (response) {
            if (!response.ok) {
                return response.text().then(function (text) {
                    var message = text;
                    try { message = JSON.parse(text).message || text; } catch (e) { /* not JSON */ }
                    throw new Error(message || 'تعذر تنفيذ الطلب.');
                });
            }
            // PostgREST returns 201 (not 204) with an EMPTY body for POST with
            // Prefer: return=minimal — response.json() throws on an empty body,
            // so status alone cannot decide whether to parse. Read as text first.
            return response.text().then(function (text) {
                if (!text) return null;
                try { return JSON.parse(text); } catch (error) { return null; }
            });
        });
    }

    function countTable(table, query) {
        return authFetch(table + '?select=id' + (query ? '&' + query : ''), {
            method: 'HEAD',
            headers: { Prefer: 'count=exact' }
        }).then(function (response) {
            var range = response.headers.get('content-range') || '';
            var match = range.match(/\/(\d+)$/);
            return match ? Number(match[1]) : 0;
        });
    }

    function postRecord(table, record) {
        return request(table, { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(record) });
    }

    function patchRecord(table, id, patch) {
        return request(table + '?id=eq.' + encodeURIComponent(id), { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(patch) });
    }

    function deleteRecord(table, id) {
        return request(table + '?id=eq.' + encodeURIComponent(id), { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
    }

    function statusBadge(text, cls) { return '<span class="badge ' + cls + '">' + escapeHtml(text) + '</span>'; }

    // ===== Image uploads (Supabase Storage, "media" bucket) =====
    // Storage RLS mirrors every other table: public read, staff-only write —
    // see supabase/migrations/20260911000003_media_storage.sql. A successful
    // upload just returns a public URL, which callers drop straight into the
    // same text field the manual URL input already writes to — one field,
    // one source of truth, whichever way it got filled in.
    var MEDIA_BUCKET = 'media';
    var MAX_IMAGE_BYTES = 5 * 1024 * 1024;
    var ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

    function uploadImage(file, folder) {
        if (!file) return Promise.reject(new Error('لم يتم اختيار ملف.'));
        if (ALLOWED_IMAGE_TYPES.indexOf(file.type) === -1) {
            return Promise.reject(new Error('نوع الملف غير مدعوم. الأنواع المسموحة: JPEG, PNG, WEBP, GIF.'));
        }
        if (file.size > MAX_IMAGE_BYTES) {
            return Promise.reject(new Error('حجم الصورة كبير جداً. الحد الأقصى 5 ميجابايت.'));
        }
        var ext = (ALLOWED_IMAGE_TYPES.indexOf(file.type) !== -1 ? file.type.split('/')[1] : 'jpg').replace('jpeg', 'jpg');
        var path = folder + '/' + Date.now() + '-' + Math.random().toString(36).slice(2, 10) + '.' + ext;
        return authFetch('storage/v1/object/' + MEDIA_BUCKET + '/' + path, {
            method: 'POST',
            headers: { 'Content-Type': file.type, 'x-upsert': 'false' },
            body: file
        }).then(function (response) {
            if (!response.ok) {
                return response.text().then(function (text) {
                    var message = text;
                    try { message = JSON.parse(text).message || text; } catch (e) { /* not JSON */ }
                    throw new Error(message || 'تعذر رفع الصورة.');
                });
            }
            return config.url.replace(/\/$/, '') + '/storage/v1/object/public/' + MEDIA_BUCKET + '/' + path;
        });
    }

    // Wires a "URL text field" + "upload from device" pair that share one
    // value and one live preview. Used identically by posts, lawyers, and
    // cases so the upload behavior is the same everywhere in the panel.
    function wireImageField(opts) {
        var urlInput = document.getElementById(opts.urlInputId);
        var fileInput = document.getElementById(opts.fileInputId);
        var preview = document.getElementById(opts.previewId);
        var statusEl = document.getElementById(opts.statusId);
        var clearBtn = document.getElementById(opts.clearButtonId);

        function updatePreview() {
            var url = urlInput.value.trim();
            if (url) {
                preview.src = url;
                preview.classList.remove('hidden');
            } else {
                preview.classList.add('hidden');
                preview.removeAttribute('src');
            }
        }

        urlInput.addEventListener('input', updatePreview);

        fileInput.addEventListener('change', function () {
            var file = fileInput.files && fileInput.files[0];
            fileInput.value = '';
            if (!file) return;
            statusEl.textContent = 'جاري رفع الصورة...';
            statusEl.classList.remove('hidden', 'text-red-600');
            statusEl.classList.add('text-gray-500');
            uploadImage(file, opts.folder).then(function (publicUrl) {
                urlInput.value = publicUrl;
                updatePreview();
                statusEl.textContent = 'تم رفع الصورة بنجاح.';
                statusEl.classList.remove('text-gray-500');
                statusEl.classList.add('text-emerald-600');
            }).catch(function (error) {
                statusEl.textContent = error.message;
                statusEl.classList.remove('text-gray-500');
                statusEl.classList.add('text-red-600');
            });
        });

        if (clearBtn) {
            clearBtn.addEventListener('click', function () {
                urlInput.value = '';
                updatePreview();
                if (statusEl) statusEl.classList.add('hidden');
            });
        }

        return { refreshPreview: updatePreview };
    }

    function populateSelect(selectEl, items, valueKey, labelKey, placeholder) {
        if (!selectEl) return;
        var current = selectEl.value;
        selectEl.innerHTML = '<option value="">' + placeholder + '</option>' +
            items.map(function (item) { return '<option value="' + item[valueKey] + '">' + escapeHtml(item[labelKey]) + '</option>'; }).join('');
        if (current) selectEl.value = current;
    }

    // ===== Row action buttons (shared markup so every entity list is consistent) =====
    function editButtonHtml(id) {
        return '<button type="button" data-edit-id="' + id + '" class="text-blue-500 hover:text-blue-700" aria-label="تعديل"><i class="fas fa-edit"></i></button>';
    }
    function archiveButtonHtml(id) {
        return '<button type="button" data-archive-id="' + id + '" class="text-amber-600 hover:text-amber-800" aria-label="أرشفة"><i class="fas fa-box-archive"></i></button>';
    }
    function restoreButtonHtml(id) {
        return '<button type="button" data-restore-id="' + id + '" class="text-emerald-600 hover:text-emerald-800" aria-label="استعادة من الأرشيف"><i class="fas fa-rotate-left"></i></button>';
    }
    function deleteButtonHtml(id) {
        return '<button type="button" data-delete-id="' + id + '" class="text-red-600 hover:text-red-800" aria-label="حذف نهائي"><i class="fas fa-trash-can"></i></button>';
    }
    function toggleButtonHtml(id, isActive) {
        return '<button type="button" data-archive-id="' + id + '" class="text-amber-600 hover:text-amber-800" aria-label="تبديل التفعيل"><i class="fas fa-toggle-' + (isActive ? 'on' : 'off') + '"></i></button>';
    }
    // Standard action set for archived_at-based entities: edit, archive/restore, delete.
    function standardActionsHtml(item) {
        var archived = Boolean(item.archived_at);
        return '<div class="flex gap-3 shrink-0">' + editButtonHtml(item.id) +
            (archived ? restoreButtonHtml(item.id) : archiveButtonHtml(item.id)) +
            deleteButtonHtml(item.id) + '</div>';
    }

    // ===== Styled confirmation modal (replaces native confirm() everywhere) =====
    // Native confirm() blocks the whole browser, can't be styled to match the
    // app, and offers no way to require typed confirmation for the riskiest
    // actions (permanently deleting a case). This is the one dialog used for
    // every archive / restore / delete / publish confirmation in the panel.
    function showConfirmModal(options) {
        return new Promise(function (resolve) {
            var opts = options || {};
            var overlay = document.createElement('div');
            overlay.className = 'fixed inset-0 z-[70] flex items-center justify-center bg-slate-950/70 p-4';
            var requireTextHtml = opts.requireText
                ? '<p class="text-xs text-gray-500 dark:text-gray-400 mb-2">للتأكيد، اكتب <strong>' + escapeHtml(opts.requireText) + '</strong> في الحقل أدناه:</p>' +
                  '<input type="text" id="confirm-modal-input" class="field-input mb-4" autocomplete="off" autocapitalize="off" spellcheck="false">'
                : '';
            overlay.innerHTML =
                '<div class="w-full max-w-sm rounded-2xl bg-white dark:bg-gray-800 p-6 shadow-2xl" dir="rtl" role="alertdialog" aria-modal="true" aria-labelledby="confirm-modal-title">' +
                '<h3 id="confirm-modal-title" class="text-lg font-bold mb-2 ' + (opts.danger ? 'text-red-600' : '') + '">' + escapeHtml(opts.title || '') + '</h3>' +
                '<p class="text-sm text-gray-600 dark:text-gray-300 mb-4 whitespace-pre-line">' + escapeHtml(opts.message || '') + '</p>' +
                requireTextHtml +
                '<div class="flex gap-2 justify-end">' +
                '<button type="button" id="confirm-modal-cancel" class="px-4 py-2 rounded-lg bg-gray-200 dark:bg-gray-700 text-sm font-semibold">' + escapeHtml(opts.cancelLabel || 'إلغاء') + '</button>' +
                '<button type="button" id="confirm-modal-ok" class="px-4 py-2 rounded-lg text-sm font-bold text-white ' + (opts.danger ? 'bg-red-600 hover:bg-red-700' : 'bg-amber-600 hover:bg-amber-700') + '"' + (opts.requireText ? ' disabled' : '') + '>' + escapeHtml(opts.confirmLabel || 'تأكيد') + '</button>' +
                '</div></div>';
            document.body.appendChild(overlay);
            var okBtn = document.getElementById('confirm-modal-ok');
            var cancelBtn = document.getElementById('confirm-modal-cancel');
            var input = document.getElementById('confirm-modal-input');
            if (input) {
                input.focus();
                input.addEventListener('input', function () {
                    okBtn.disabled = input.value.trim() !== opts.requireText;
                });
            } else {
                okBtn.focus();
            }
            function close(result) {
                overlay.remove();
                document.removeEventListener('keydown', onKeydown);
                resolve(result);
            }
            function onKeydown(event) {
                if (event.key === 'Escape') close(false);
                if (event.key === 'Enter' && document.activeElement !== input) close(!okBtn.disabled);
            }
            document.addEventListener('keydown', onKeydown);
            okBtn.addEventListener('click', function () { close(true); });
            cancelBtn.addEventListener('click', function () { close(false); });
            overlay.addEventListener('click', function (event) { if (event.target === overlay) close(false); });
        });
    }

    // ===== Generic list + create/edit/archive controller =====
    function entityManager(opts) {
        var items = [];
        var manager = {
            load: load,
            find: findById,
            resetForm: resetForm
        };

        function load() {
            opts.listEl.innerHTML = '<p class="text-sm text-gray-500">جاري التحميل...</p>';
            return request(opts.table + '?select=*' + (opts.order ? '&' + opts.order : '')).then(function (data) {
                items = data || [];
                render();
                return items;
            }).catch(function (error) {
                opts.listEl.innerHTML = '<p class="text-sm text-red-600">تعذر تحميل البيانات: ' + escapeHtml(error.message) + '</p>';
                return items;
            });
        }

        function render() {
            if (!items.length) {
                opts.listEl.innerHTML = '<p class="text-sm text-gray-500 py-4">' + opts.emptyMessage + '</p>';
                return;
            }
            opts.listEl.innerHTML = items.map(opts.renderRow).join('');
            opts.listEl.querySelectorAll('[data-edit-id]').forEach(function (btn) {
                btn.addEventListener('click', function () { startEdit(btn.getAttribute('data-edit-id')); });
            });
            opts.listEl.querySelectorAll('[data-archive-id]').forEach(function (btn) {
                btn.addEventListener('click', function () { archiveItem(btn.getAttribute('data-archive-id')); });
            });
            opts.listEl.querySelectorAll('[data-restore-id]').forEach(function (btn) {
                btn.addEventListener('click', function () { restoreItem(btn.getAttribute('data-restore-id')); });
            });
            opts.listEl.querySelectorAll('[data-delete-id]').forEach(function (btn) {
                btn.addEventListener('click', function () { deleteItem(btn.getAttribute('data-delete-id')); });
            });
        }

        function findById(id) {
            return items.filter(function (item) { return String(item.id) === String(id); })[0];
        }

        function startEdit(id) {
            var record = findById(id);
            if (!record) return;
            opts.formEl.dataset.editingId = id;
            opts.fillForm(record);
            opts.formEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }

        function resetForm() {
            opts.formEl.reset();
            delete opts.formEl.dataset.editingId;
        }

        // Disables every action button on one row while a request for it is
        // in flight, so a slow connection can't turn one click into two.
        function setRowBusy(id, busy) {
            var selector = '[data-edit-id="' + id + '"], [data-archive-id="' + id + '"], [data-restore-id="' + id + '"], [data-delete-id="' + id + '"]';
            opts.listEl.querySelectorAll(selector).forEach(function (btn) {
                btn.disabled = busy;
                btn.classList.toggle('opacity-40', busy);
                btn.classList.toggle('pointer-events-none', busy);
            });
        }

        function archiveItem(id) {
            var record = findById(id);
            if (!record) return;
            showConfirmModal({
                title: 'أرشفة',
                message: opts.archiveConfirm,
                confirmLabel: 'أرشفة'
            }).then(function (confirmed) {
                if (!confirmed) return;
                setRowBusy(id, true);
                return patchRecord(opts.table, record.id, opts.archivePatch(record))
                    .then(function () { setStatus('تمت الأرشفة بنجاح.', 'success'); load(); })
                    .catch(function (error) { setStatus('تعذر التنفيذ: ' + error.message, 'error'); setRowBusy(id, false); });
            });
        }

        // Restoring only un-hides the item from the archive — it never
        // auto-republishes it — so it's safe to run without a confirmation.
        function restoreItem(id) {
            var record = findById(id);
            if (!record) return;
            setRowBusy(id, true);
            var patch = opts.restorePatch ? opts.restorePatch(record) : { archived_at: null };
            patchRecord(opts.table, record.id, patch)
                .then(function () { setStatus('تمت الاستعادة بنجاح.', 'success'); load(); })
                .catch(function (error) { setStatus('تعذر الاستعادة: ' + error.message, 'error'); setRowBusy(id, false); });
        }

        function deleteItem(id) {
            var record = findById(id);
            if (!record) return;
            showConfirmModal({
                title: 'حذف نهائي',
                message: opts.deleteConfirm || 'سيتم حذف هذا العنصر نهائياً ولا يمكن التراجع عن هذا الإجراء. هل أنت متأكد؟',
                confirmLabel: 'حذف نهائي',
                danger: true,
                requireText: opts.deleteRequireText
            }).then(function (confirmed) {
                if (!confirmed) return;
                setRowBusy(id, true);
                return deleteRecord(opts.table, record.id)
                    .then(function () { setStatus('تم الحذف نهائياً.', 'success'); load(); })
                    .catch(function (error) { setStatus('تعذر الحذف: ' + error.message, 'error'); setRowBusy(id, false); });
            });
        }

        opts.formEl.addEventListener('submit', function (event) {
            event.preventDefault();
            var submitBtn = opts.formEl.querySelector('button[type="submit"]');
            if (submitBtn.disabled) return;
            // Wrapped in Promise.resolve so getFormRecord may return either a
            // plain record (most entities) or a Promise (cases, which needs an
            // async confirmation before publishing) with no special-casing here.
            Promise.resolve(opts.getFormRecord()).then(function (record) {
                if (!record) return;
                var editingId = opts.formEl.dataset.editingId;
                var originalLabel = submitBtn.textContent;
                submitBtn.disabled = true;
                submitBtn.textContent = 'جاري الحفظ...';
                var task = editingId ? patchRecord(opts.table, editingId, record) : postRecord(opts.table, record);
                return task.then(function () {
                    setStatus('تم الحفظ بنجاح.', 'success');
                    resetForm();
                    load();
                }).catch(function (error) {
                    setStatus('تعذر الحفظ: ' + error.message, 'error');
                }).finally(function () {
                    submitBtn.disabled = false;
                    submitBtn.textContent = originalLabel;
                });
            });
        });

        var resetBtn = document.querySelector('[data-reset="' + opts.formEl.id + '"]');
        if (resetBtn) resetBtn.addEventListener('click', resetForm);

        return manager;
    }

    // ===== Image upload wiring (one per form that has an image field) =====
    var postImageField = wireImageField({
        urlInputId: 'postImage', fileInputId: 'postImageFile', previewId: 'postImagePreview',
        statusId: 'postImageStatus', clearButtonId: 'postImageClear', folder: 'posts'
    });
    var lawyerPhotoField = wireImageField({
        urlInputId: 'lawyerPhoto', fileInputId: 'lawyerPhotoFile', previewId: 'lawyerPhotoPreview',
        statusId: 'lawyerPhotoStatus', clearButtonId: 'lawyerPhotoClear', folder: 'lawyers'
    });
    var caseFeaturedImageField = wireImageField({
        urlInputId: 'caseFeaturedImage', fileInputId: 'caseFeaturedImageFile', previewId: 'caseFeaturedImagePreview',
        statusId: 'caseFeaturedImageStatus', clearButtonId: 'caseFeaturedImageClear', folder: 'cases'
    });
    // form.reset() clears field values but does NOT fire 'input'/'change' on
    // them (only a 'reset' event on the form itself), so the image preview
    // would otherwise still show the old image after a save or cancel.
    document.getElementById('postForm').addEventListener('reset', function () { postImageField.refreshPreview(); });
    document.getElementById('lawyerForm').addEventListener('reset', function () { lawyerPhotoField.refreshPreview(); });
    document.getElementById('caseForm').addEventListener('reset', function () { caseFeaturedImageField.refreshPreview(); });

    // ===== Practice areas =====
    var practiceAreasManager = entityManager({
        table: 'practice_areas',
        order: 'order=display_order.asc',
        listEl: document.getElementById('practice-areas-admin-list'),
        formEl: document.getElementById('practiceAreaForm'),
        emptyMessage: 'لا توجد مجالات ممارسة بعد.',
        archiveConfirm: 'سيتم تغيير حالة تفعيل مجال الممارسة هذا. هل تريد المتابعة؟',
        deleteConfirm: 'سيتم حذف مجال الممارسة هذا نهائياً. الخدمات والقضايا المرتبطة به لن تُحذف، لكن سيُفصل ارتباطها به تلقائياً. هل أنت متأكد؟',
        getFormRecord: function () {
            var name = document.getElementById('practiceAreaName').value.trim();
            if (!name) { setStatus('يرجى إدخال اسم مجال الممارسة.', 'error'); return null; }
            var editingId = document.getElementById('practiceAreaForm').dataset.editingId;
            var existing = editingId ? practiceAreasManager.find(editingId) : null;
            return {
                name: name,
                slug: existing ? existing.slug : slugify(name),
                description: document.getElementById('practiceAreaDescription').value.trim() || null,
                display_order: Number(document.getElementById('practiceAreaOrder').value) || 0,
                is_active: document.getElementById('practiceAreaActive').checked
            };
        },
        fillForm: function (record) {
            document.getElementById('practiceAreaName').value = record.name || '';
            document.getElementById('practiceAreaDescription').value = record.description || '';
            document.getElementById('practiceAreaOrder').value = record.display_order || 0;
            document.getElementById('practiceAreaActive').checked = Boolean(record.is_active);
        },
        renderRow: function (item) {
            return '<div class="entity-row flex justify-between items-start gap-3">' +
                '<div><h4 class="font-bold">' + escapeHtml(item.name) + '</h4>' +
                '<p class="text-xs text-gray-500 mt-1">' + (item.is_active ? statusBadge('نشط', 'badge-published') : statusBadge('غير نشط', 'badge-archived')) + '</p></div>' +
                '<div class="flex gap-3 shrink-0">' + editButtonHtml(item.id) + toggleButtonHtml(item.id, item.is_active) + deleteButtonHtml(item.id) + '</div></div>';
        },
        archivePatch: function (record) { return { is_active: !record.is_active }; }
    });

    // ===== Lawyers =====
    var lawyersManager = entityManager({
        table: 'lawyers',
        order: 'order=created_at.desc',
        listEl: document.getElementById('lawyers-admin-list'),
        formEl: document.getElementById('lawyerForm'),
        emptyMessage: 'لا يوجد محامون مسجلون بعد.',
        archiveConfirm: 'سيتم أرشفة هذا المحامي وإخفاؤه من الموقع العام. يمكن استعادته لاحقاً في أي وقت. هل تريد المتابعة؟',
        deleteConfirm: 'سيتم حذف بيانات هذا المحامي نهائياً، بما في ذلك النبذة وبيانات التواصل. هذا الإجراء لا يمكن التراجع عنه. هل أنت متأكد؟',
        getFormRecord: function () {
            var fullName = document.getElementById('lawyerFullName').value.trim();
            if (!fullName) { setStatus('يرجى إدخال الاسم الكامل.', 'error'); return null; }
            return {
                full_name: fullName,
                title: document.getElementById('lawyerTitle').value.trim() || null,
                bio: document.getElementById('lawyerBio').value.trim() || null,
                photo_url: document.getElementById('lawyerPhoto').value.trim() || null,
                email: document.getElementById('lawyerEmail').value.trim() || null,
                phone: document.getElementById('lawyerPhone').value.trim() || null,
                is_public: document.getElementById('lawyerIsPublic').checked
            };
        },
        fillForm: function (record) {
            document.getElementById('lawyerFullName').value = record.full_name || '';
            document.getElementById('lawyerTitle').value = record.title || '';
            document.getElementById('lawyerBio').value = record.bio || '';
            document.getElementById('lawyerPhoto').value = record.photo_url || '';
            lawyerPhotoField.refreshPreview();
            document.getElementById('lawyerEmail').value = record.email || '';
            document.getElementById('lawyerPhone').value = record.phone || '';
            document.getElementById('lawyerIsPublic').checked = Boolean(record.is_public);
        },
        renderRow: function (item) {
            var archived = Boolean(item.archived_at);
            return '<div class="entity-row flex justify-between items-start gap-3">' +
                '<div><h4 class="font-bold">' + escapeHtml(item.full_name) + '</h4>' +
                '<p class="text-xs text-gray-500 mt-1">' + escapeHtml(item.title || '') + ' ' +
                (archived ? statusBadge('مؤرشف', 'badge-archived') : (item.is_public ? statusBadge('ظاهر للعامة', 'badge-published') : statusBadge('غير ظاهر', 'badge-draft'))) +
                '</p></div>' + standardActionsHtml(item) + '</div>';
        },
        archivePatch: function () { return { archived_at: nowIso() }; },
        restorePatch: function () { return { archived_at: null }; }
    });

    // ===== Services =====
    var servicesManager = entityManager({
        table: 'services',
        order: 'order=display_order.asc',
        listEl: document.getElementById('services-admin-list'),
        formEl: document.getElementById('serviceForm'),
        emptyMessage: 'لا توجد خدمات بعد.',
        archiveConfirm: 'سيتم أرشفة هذه الخدمة وإخفاؤها من الموقع العام. يمكن استعادتها لاحقاً في أي وقت. هل تريد المتابعة؟',
        deleteConfirm: 'سيتم حذف هذه الخدمة نهائياً. هذا الإجراء لا يمكن التراجع عنه. هل أنت متأكد؟',
        getFormRecord: function () {
            var name = document.getElementById('serviceName').value.trim();
            if (!name) { setStatus('يرجى إدخال اسم الخدمة.', 'error'); return null; }
            var editingId = document.getElementById('serviceForm').dataset.editingId;
            var existing = editingId ? servicesManager.find(editingId) : null;
            return {
                name: name,
                slug: existing ? existing.slug : slugify(name),
                description: document.getElementById('serviceDescription').value.trim() || null,
                practice_area_id: document.getElementById('servicePracticeArea').value || null,
                display_order: Number(document.getElementById('serviceOrder').value) || 0,
                status: document.getElementById('serviceStatus').value
            };
        },
        fillForm: function (record) {
            document.getElementById('serviceName').value = record.name || '';
            document.getElementById('serviceDescription').value = record.description || '';
            document.getElementById('servicePracticeArea').value = record.practice_area_id || '';
            document.getElementById('serviceOrder').value = record.display_order || 0;
            document.getElementById('serviceStatus').value = record.status || 'draft';
        },
        renderRow: function (item) {
            var archived = Boolean(item.archived_at);
            return '<div class="entity-row flex justify-between items-start gap-3">' +
                '<div><h4 class="font-bold">' + escapeHtml(item.name) + '</h4>' +
                '<p class="text-xs text-gray-500 mt-1">' + (archived ? statusBadge('مؤرشف', 'badge-archived') : (item.status === 'published' ? statusBadge('منشورة', 'badge-published') : statusBadge('مسودة', 'badge-draft'))) + '</p></div>' +
                standardActionsHtml(item) + '</div>';
        },
        archivePatch: function () { return { archived_at: nowIso(), status: 'draft' }; },
        restorePatch: function () { return { archived_at: null }; }
    });

    // ===== Posts =====
    var postsManager = entityManager({
        table: 'posts',
        order: 'order=created_at.desc',
        listEl: document.getElementById('posts-admin-list'),
        formEl: document.getElementById('postForm'),
        emptyMessage: 'لا توجد مقالات بعد.',
        archiveConfirm: 'سيتم أرشفة المقال وإخفاؤه من الموقع العام. يمكن استعادته لاحقاً في أي وقت. هل تريد المتابعة؟',
        deleteConfirm: 'سيتم حذف هذا المقال نهائياً بكامل محتواه. هذا الإجراء لا يمكن التراجع عنه ولا يمكن استرجاع المقال بعده. هل أنت متأكد؟',
        getFormRecord: function () {
            var title = document.getElementById('postTitle').value.trim();
            var category = document.getElementById('postCategory').value.trim();
            var content = document.getElementById('postContent').value.trim();
            if (!title || !category || !content) { setStatus('يرجى استكمال العنوان والتصنيف ونص المقال.', 'error'); return null; }
            var editingId = document.getElementById('postForm').dataset.editingId;
            var existing = editingId ? postsManager.find(editingId) : null;
            var status = document.getElementById('postStatus').value;
            return {
                title: title,
                slug: existing ? existing.slug : slugify(title),
                category: category,
                image: document.getElementById('postImage').value.trim() || null,
                content: content,
                seo_title: document.getElementById('postSeoTitle').value.trim() || null,
                seo_description: document.getElementById('postSeoDescription').value.trim() || null,
                status: status,
                published_at: status === 'published' ? (existing && existing.published_at ? existing.published_at : nowIso()) : null
            };
        },
        fillForm: function (record) {
            document.getElementById('postTitle').value = record.title || '';
            document.getElementById('postCategory').value = record.category || '';
            document.getElementById('postImage').value = record.image || '';
            postImageField.refreshPreview();
            document.getElementById('postContent').value = record.content || '';
            document.getElementById('postSeoTitle').value = record.seo_title || '';
            document.getElementById('postSeoDescription').value = record.seo_description || '';
            document.getElementById('postStatus').value = record.status || 'draft';
        },
        renderRow: function (item) {
            var archived = Boolean(item.archived_at);
            return '<div class="entity-row flex justify-between items-start gap-3">' +
                '<div><h4 class="font-bold">' + escapeHtml(item.title) + '</h4>' +
                '<p class="text-xs text-gray-500 my-1">' + escapeHtml((item.content || '').slice(0, 80)) + '...</p>' +
                (archived ? statusBadge('مؤرشف', 'badge-archived') : (item.status === 'published' ? statusBadge('منشور', 'badge-published') : statusBadge('مسودة', 'badge-draft'))) +
                '</div>' + standardActionsHtml(item) + '</div>';
        },
        archivePatch: function () { return { archived_at: nowIso(), status: 'draft' }; },
        restorePatch: function () { return { archived_at: null }; }
    });

    // ===== Cases =====
    var casesManager = entityManager({
        table: 'cases',
        order: 'order=created_at.desc',
        listEl: document.getElementById('cases-admin-list'),
        formEl: document.getElementById('caseForm'),
        emptyMessage: 'لا توجد قضايا مسجلة بعد.',
        archiveConfirm: 'سيتم أرشفة هذه القضية وإخفاؤها من الموقع العام إن كانت منشورة. البيانات الداخلية تبقى محفوظة ويمكن استعادتها لاحقاً. هل تريد المتابعة؟',
        deleteConfirm: 'سيتم حذف هذه القضية نهائياً بجميع بياناتها الداخلية والعامة (الملاحظات، مرجع العميل، تفاصيل الخصم، كل شيء). هذا الإجراء لا يمكن التراجع عنه إطلاقاً ولا توجد نسخة احتياطية تلقائية.',
        deleteRequireText: 'حذف',
        getFormRecord: function () {
            var internalReference = document.getElementById('caseInternalReference').value.trim();
            var title = document.getElementById('caseTitle').value.trim();
            if (!internalReference || !title) { setStatus('يرجى إدخال الرقم المرجعي الداخلي وعنوان القضية.', 'error'); return null; }
            var editingId = document.getElementById('caseForm').dataset.editingId;
            var existing = editingId ? casesManager.find(editingId) : null;
            var publicTitle = document.getElementById('casePublicTitle').value.trim();
            var publicSummary = document.getElementById('casePublicSummary').value.trim();
            var publicStatus = document.getElementById('casePublicStatus').value;

            // A case can only go public with a real public-facing title and summary —
            // this blocks accidentally publishing a case with the public side left blank.
            if (publicStatus === 'published' && (!publicTitle || !publicSummary)) {
                setStatus('لا يمكن نشر القضية للعامة بدون عنوان عام وملخص عام. أكمل الحقول الذهبية أولاً أو أعد حالة النشر إلى "مسودة".', 'error');
                return null;
            }

            function buildRecord() {
                return {
                    internal_reference: internalReference,
                    title: title,
                    case_type: document.getElementById('caseType').value.trim() || null,
                    practice_area_id: document.getElementById('casePracticeArea').value || null,
                    client_reference: document.getElementById('caseClientReference').value.trim() || null,
                    opposing_party: document.getElementById('caseOpposingParty').value.trim() || null,
                    court: document.getElementById('caseCourt').value.trim() || null,
                    jurisdiction: document.getElementById('caseJurisdiction').value.trim() || null,
                    case_number: document.getElementById('caseNumber').value.trim() || null,
                    filing_date: document.getElementById('caseFilingDate').value || null,
                    hearing_date: document.getElementById('caseHearingDate').value || null,
                    status: document.getElementById('caseStatus').value,
                    outcome: document.getElementById('caseOutcome').value.trim() || null,
                    outcome_date: document.getElementById('caseOutcomeDate').value || null,
                    assigned_lawyer_id: document.getElementById('caseAssignedLawyer').value || null,
                    internal_notes: document.getElementById('caseInternalNotes').value.trim() || null,
                    public_title: publicTitle || null,
                    public_summary: document.getElementById('casePublicSummary').value.trim() || null,
                    public_description: document.getElementById('casePublicDescription').value.trim() || null,
                    public_outcome: document.getElementById('casePublicOutcome').value.trim() || null,
                    public_year: document.getElementById('casePublicYear').value ? Number(document.getElementById('casePublicYear').value) : null,
                    featured_image: document.getElementById('caseFeaturedImage').value.trim() || null,
                    public_status: publicStatus,
                    public_slug: publicTitle ? (existing && existing.public_slug ? existing.public_slug : slugify(publicTitle)) : null
                };
            }

            // Extra confirmation only when a case is actually transitioning from
            // not-published to published — editing an already-published case (e.g.
            // fixing internal notes) should not re-prompt every time. Returning a
            // Promise here (instead of the plain object every other branch
            // returns) is fine — the submit handler awaits getFormRecord() either way.
            var wasPublished = existing && existing.public_status === 'published';
            if (publicStatus === 'published' && !wasPublished) {
                return showConfirmModal({
                    title: 'نشر القضية للعامة',
                    message: 'سيتم نشر هذه القضية للعامة الآن. لن يظهر سوى الحقول الذهبية (العنوان العام، الملخص، الوصف، النتيجة، السنة، الصورة) — لن تظهر أي بيانات داخلية.',
                    confirmLabel: 'نشر'
                }).then(function (confirmed) {
                    if (!confirmed) { setStatus('تم إلغاء النشر. لم يتم حفظ أي تغييرات.', 'error'); return null; }
                    return buildRecord();
                });
            }

            return buildRecord();
        },
        fillForm: function (record) {
            document.getElementById('caseInternalReference').value = record.internal_reference || '';
            document.getElementById('caseTitle').value = record.title || '';
            document.getElementById('caseType').value = record.case_type || '';
            document.getElementById('casePracticeArea').value = record.practice_area_id || '';
            document.getElementById('caseClientReference').value = record.client_reference || '';
            document.getElementById('caseOpposingParty').value = record.opposing_party || '';
            document.getElementById('caseCourt').value = record.court || '';
            document.getElementById('caseJurisdiction').value = record.jurisdiction || '';
            document.getElementById('caseNumber').value = record.case_number || '';
            document.getElementById('caseAssignedLawyer').value = record.assigned_lawyer_id || '';
            document.getElementById('caseFilingDate').value = record.filing_date || '';
            document.getElementById('caseHearingDate').value = record.hearing_date || '';
            document.getElementById('caseStatus').value = record.status || 'open';
            document.getElementById('caseOutcomeDate').value = record.outcome_date || '';
            document.getElementById('caseOutcome').value = record.outcome || '';
            document.getElementById('caseInternalNotes').value = record.internal_notes || '';
            document.getElementById('casePublicTitle').value = record.public_title || '';
            document.getElementById('casePublicYear').value = record.public_year || '';
            document.getElementById('casePublicSummary').value = record.public_summary || '';
            document.getElementById('casePublicDescription').value = record.public_description || '';
            document.getElementById('casePublicOutcome').value = record.public_outcome || '';
            document.getElementById('caseFeaturedImage').value = record.featured_image || '';
            caseFeaturedImageField.refreshPreview();
            document.getElementById('casePublicStatus').value = record.public_status || 'draft';
        },
        renderRow: function (item) {
            var archived = Boolean(item.archived_at);
            return '<div class="entity-row flex justify-between items-start gap-3">' +
                '<div><h4 class="font-bold">' + escapeHtml(item.title) + ' <span class="text-xs text-gray-400">(' + escapeHtml(item.internal_reference) + ')</span></h4>' +
                '<p class="text-xs text-gray-500 mt-1">' + (archived ? statusBadge('مؤرشف', 'badge-archived') : (item.public_status === 'published' ? statusBadge('منشورة للعامة', 'badge-published') : statusBadge('غير منشورة', 'badge-draft'))) + '</p></div>' +
                standardActionsHtml(item) + '</div>';
        },
        archivePatch: function () { return { archived_at: nowIso(), public_status: 'draft' }; },
        restorePatch: function () { return { archived_at: null }; }
    });

    // ===== Contact requests (inbox: read + status update, no create/delete) =====
    var contactState = { statusFilter: '' };
    var contactStatusLabels = { new: 'جديد', in_progress: 'قيد المتابعة', resolved: 'تم الحل', archived: 'مؤرشف' };

    function loadContacts() {
        var listEl = document.getElementById('contact-admin-list');
        listEl.innerHTML = '<p class="text-sm text-gray-500">جاري التحميل...</p>';
        var query = 'select=*&order=created_at.desc' + (contactState.statusFilter ? '&status=eq.' + contactState.statusFilter : '');
        return request('contact_requests?' + query).then(function (data) {
            renderContacts(data || []);
        }).catch(function (error) {
            listEl.innerHTML = '<p class="text-sm text-red-600">تعذر تحميل طلبات التواصل: ' + escapeHtml(error.message) + '</p>';
        });
    }

    function renderContacts(items) {
        var listEl = document.getElementById('contact-admin-list');
        if (!items.length) { listEl.innerHTML = '<p class="text-sm text-gray-500 py-4">لا توجد طلبات تواصل.</p>'; return; }
        listEl.innerHTML = items.map(function (item) {
            var services = Array.isArray(item.services) && item.services.length ? escapeHtml(item.services.join('، ')) : '';
            var optionsHtml = Object.keys(contactStatusLabels).map(function (key) {
                return '<option value="' + key + '"' + (item.status === key ? ' selected' : '') + '>' + contactStatusLabels[key] + '</option>';
            }).join('');
            return '<div class="entity-row">' +
                '<div class="flex flex-wrap justify-between items-start gap-2 mb-2">' +
                '<div><h4 class="font-bold">' + escapeHtml(item.name) + '</h4>' +
                '<p class="text-xs text-gray-500">' + escapeHtml(item.phone) + (item.email ? ' · ' + escapeHtml(item.email) : '') + ' · ' + escapeHtml(new Date(item.created_at).toLocaleString('ar-EG')) + '</p></div>' +
                '<select class="field-input w-auto text-xs" data-contact-status="' + item.id + '" aria-label="حالة الطلب">' + optionsHtml + '</select>' +
                '</div>' +
                '<p class="text-sm text-gray-700 dark:text-gray-300 whitespace-pre-wrap">' + escapeHtml(item.message) + '</p>' +
                (services ? '<p class="text-xs text-gray-500 mt-1">الخدمات المطلوبة: ' + services + '</p>' : '') +
                '</div>';
        }).join('');
        listEl.querySelectorAll('[data-contact-status]').forEach(function (select) {
            select.addEventListener('change', function () {
                var id = select.getAttribute('data-contact-status');
                patchRecord('contact_requests', id, { status: select.value })
                    .then(function () { setStatus('تم تحديث حالة الطلب.', 'success'); })
                    .catch(function (error) { setStatus('تعذر التحديث: ' + error.message, 'error'); loadContacts(); });
            });
        });
    }

    function initContactFilters() {
        document.querySelectorAll('#contact-filter .admin-tab').forEach(function (btn) {
            btn.addEventListener('click', function () {
                document.querySelectorAll('#contact-filter .admin-tab').forEach(function (b) { b.setAttribute('aria-selected', 'false'); });
                btn.setAttribute('aria-selected', 'true');
                contactState.statusFilter = btn.getAttribute('data-status');
                loadContacts();
            });
        });
    }

    // ===== Dashboard =====
    function loadDashboard() {
        var loading = document.getElementById('dashboard-loading');
        var statsEl = document.getElementById('dashboard-stats');
        Promise.all([
            countTable('posts', 'status=eq.published&archived_at=is.null'),
            countTable('posts', 'status=eq.draft&archived_at=is.null'),
            countTable('cases', 'public_status=eq.published&archived_at=is.null'),
            countTable('cases', 'archived_at=is.null'),
            countTable('lawyers', 'is_public=eq.true&archived_at=is.null'),
            countTable('services', 'status=eq.published&archived_at=is.null'),
            countTable('practice_areas', 'is_active=eq.true'),
            countTable('contact_requests', 'status=eq.new')
        ]).then(function (counts) {
            var cards = [
                { label: 'مقالات منشورة', value: counts[0], icon: 'fa-newspaper' },
                { label: 'مقالات كمسودة', value: counts[1], icon: 'fa-pen' },
                { label: 'قضايا منشورة للعامة', value: counts[2], icon: 'fa-scale-balanced' },
                { label: 'إجمالي القضايا النشطة', value: counts[3], icon: 'fa-folder-open' },
                { label: 'محامون ظاهرون للعامة', value: counts[4], icon: 'fa-user-tie' },
                { label: 'خدمات منشورة', value: counts[5], icon: 'fa-briefcase' },
                { label: 'مجالات ممارسة نشطة', value: counts[6], icon: 'fa-layer-group' },
                { label: 'طلبات تواصل جديدة', value: counts[7], icon: 'fa-envelope', highlight: counts[7] > 0 }
            ];
            statsEl.innerHTML = cards.map(function (card) {
                return '<div class="p-4 rounded-xl border ' + (card.highlight ? 'border-amber-400 bg-amber-50 dark:bg-amber-900/20' : 'border-gray-200 dark:border-gray-700') + '">' +
                    '<i class="fas ' + card.icon + ' icon-gold mb-2 text-lg"></i>' +
                    '<p class="text-2xl font-bold">' + card.value + '</p>' +
                    '<p class="text-xs text-gray-500">' + card.label + '</p></div>';
            }).join('');
            loading.classList.add('hidden');
            statsEl.classList.remove('hidden');
        }).catch(function (error) {
            loading.textContent = 'تعذر تحميل الإحصائيات: ' + error.message;
        });
    }

    // ===== Tabs =====
    function initTabs() {
        var tabs = document.querySelectorAll('#admin-tabs .admin-tab');
        tabs.forEach(function (tab) {
            tab.addEventListener('click', function () {
                tabs.forEach(function (t) { t.setAttribute('aria-selected', 'false'); });
                tab.setAttribute('aria-selected', 'true');
                document.querySelectorAll('.admin-panel').forEach(function (p) { p.classList.remove('active'); });
                document.getElementById(tab.dataset.panel).classList.add('active');
            });
        });
    }

    // ===== Auth =====
    function addLogoutButton() {
        var actions = document.getElementById('admin-header-actions');
        if (document.getElementById('admin-logout')) return;
        var button = document.createElement('button');
        button.id = 'admin-logout';
        button.type = 'button';
        button.className = 'rounded-lg bg-slate-700 px-4 py-2 text-sm font-bold text-white hover:bg-slate-800';
        button.textContent = 'تسجيل الخروج';
        button.addEventListener('click', function () {
            var token = sessionToken;
            clearSession();
            if (token) {
                // Best-effort server-side invalidation; the local session is
                // already cleared either way, so a network failure here is fine.
                fetch(config.url.replace(/\/$/, '') + '/auth/v1/logout', {
                    method: 'POST',
                    headers: { apikey: config.anonKey, Authorization: 'Bearer ' + token }
                }).catch(function () {});
            }
            window.location.reload();
        });
        actions.appendChild(button);
    }

    function renderAuth() {
        if (document.getElementById('admin-auth')) return;
        var auth = document.createElement('div');
        auth.id = 'admin-auth';
        auth.className = 'fixed inset-0 z-50 flex items-center justify-center bg-slate-950/90 p-4';
        auth.innerHTML = '<form class="w-full max-w-md rounded-2xl bg-white p-8 shadow-2xl" dir="rtl">' +
            '<h1 class="mb-2 text-2xl font-bold">دخول لوحة الإدارة</h1>' +
            '<p class="mb-6 text-sm text-slate-500">يتطلب هذا الوضع حساباً مصادقاً عليه في Supabase.</p>' +
            '<label class="mb-2 block font-semibold">البريد الإلكتروني</label><input id="admin-email" type="email" required class="mb-4 w-full rounded-lg border p-3" autocomplete="username">' +
            '<label class="mb-2 block font-semibold">كلمة المرور</label><input id="admin-password" type="password" required class="mb-5 w-full rounded-lg border p-3" autocomplete="current-password">' +
            '<button type="submit" class="w-full rounded-lg bg-amber-600 p-3 font-bold text-white">تسجيل الدخول</button>' +
            '<p id="admin-auth-error" role="alert" class="mt-4 text-sm text-red-600"></p></form>';
        document.body.appendChild(auth);
        document.getElementById('admin-email').focus();
        auth.querySelector('form').addEventListener('submit', function (event) {
            event.preventDefault();
            var submit = auth.querySelector('button[type="submit"]');
            submit.disabled = true;
            submit.textContent = 'جاري تسجيل الدخول...';
            request('auth/v1/token?grant_type=password', {
                method: 'POST',
                body: JSON.stringify({ email: document.getElementById('admin-email').value, password: document.getElementById('admin-password').value })
            }).then(function (result) {
                saveSession(result);
                auth.remove();
                root.classList.remove('opacity-50');
                addLogoutButton();
                boot();
            }).catch(function () {
                submit.disabled = false;
                submit.textContent = 'تسجيل الدخول';
                document.getElementById('admin-auth-error').textContent = 'بيانات الدخول غير صحيحة أو لم يتم إعداد مستخدم إداري.';
            });
        });
    }

    function boot() {
        loadDashboard();
        practiceAreasManager.load().then(function (items) {
            populateSelect(document.getElementById('servicePracticeArea'), items, 'id', 'name', '— بدون —');
            populateSelect(document.getElementById('casePracticeArea'), items, 'id', 'name', '— بدون —');
        });
        lawyersManager.load().then(function (items) {
            populateSelect(document.getElementById('caseAssignedLawyer'), items, 'id', 'full_name', '— بدون —');
        });
        servicesManager.load();
        postsManager.load();
        casesManager.load();
        loadContacts();
    }

    document.addEventListener('DOMContentLoaded', function () {
        initTabs();
        initContactFilters();
        if (!platform.isSupabaseConfigured()) {
            root.classList.remove('opacity-50');
            setStatus('لوحة التحكم تتطلب إعداد Supabase في config.js. لا يوجد وضع محلي لإدارة المحتوى.', 'error');
            return;
        }
        if (!sessionToken) {
            renderAuth();
            return;
        }
        root.classList.remove('opacity-50');
        addLogoutButton();
        var now = Math.floor(Date.now() / 1000);
        if (tokenExpiresAt && now > tokenExpiresAt - 60) {
            // The stored access token is expired or about to be — refresh once
            // up front instead of letting boot()'s parallel requests all hit
            // 401 at the same time.
            ensureRefreshed().then(boot).catch(function () {
                clearSession();
                renderAuth();
            });
        } else {
            scheduleProactiveRefresh();
            boot();
        }
    });
}());
