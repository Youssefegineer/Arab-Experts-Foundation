(function () {
    'use strict';
    var platform = window.ArabExpertPlatform;
    var config = platform && platform.config;
    var sessionToken = sessionStorage.getItem('arabExpert.adminToken');
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

    // ===== Core REST helper (covers both rest/v1 and auth/v1) =====
    function request(path, options) {
        var opts = options || {};
        var normalizedPath = path.replace(/^\/+/, '');
        var basePath = normalizedPath.indexOf('rest/v1/') === 0 || normalizedPath.indexOf('auth/v1/') === 0 ? '' : 'rest/v1/';
        opts.headers = Object.assign({
            apikey: config.anonKey,
            Authorization: 'Bearer ' + (sessionToken || config.anonKey),
            'Content-Type': 'application/json',
            Accept: 'application/json'
        }, opts.headers || {});
        return fetch(config.url.replace(/\/$/, '') + '/' + basePath + normalizedPath, opts).then(function (response) {
            if (response.status === 401 && sessionToken) {
                sessionStorage.removeItem('arabExpert.adminToken');
                sessionToken = null;
                renderAuth();
                throw new Error('انتهت جلسة الإدارة. يرجى تسجيل الدخول مرة أخرى.');
            }
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
        return fetch(config.url.replace(/\/$/, '') + '/rest/v1/' + table + '?select=id' + (query ? '&' + query : ''), {
            method: 'HEAD',
            headers: {
                apikey: config.anonKey,
                Authorization: 'Bearer ' + (sessionToken || config.anonKey),
                Prefer: 'count=exact'
            }
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

    function statusBadge(text, cls) { return '<span class="badge ' + cls + '">' + escapeHtml(text) + '</span>'; }

    function populateSelect(selectEl, items, valueKey, labelKey, placeholder) {
        if (!selectEl) return;
        var current = selectEl.value;
        selectEl.innerHTML = '<option value="">' + placeholder + '</option>' +
            items.map(function (item) { return '<option value="' + item[valueKey] + '">' + escapeHtml(item[labelKey]) + '</option>'; }).join('');
        if (current) selectEl.value = current;
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

        function archiveItem(id) {
            var record = findById(id);
            if (!record || !confirm(opts.archiveConfirm)) return;
            patchRecord(opts.table, record.id, opts.archivePatch(record))
                .then(function () { setStatus('تم الحفظ بنجاح.', 'success'); load(); })
                .catch(function (error) { setStatus('تعذر التنفيذ: ' + error.message, 'error'); });
        }

        opts.formEl.addEventListener('submit', function (event) {
            event.preventDefault();
            var record = opts.getFormRecord();
            if (!record) return;
            var editingId = opts.formEl.dataset.editingId;
            var submitBtn = opts.formEl.querySelector('button[type="submit"]');
            var originalLabel = submitBtn.textContent;
            submitBtn.disabled = true;
            submitBtn.textContent = 'جاري الحفظ...';
            var task = editingId ? patchRecord(opts.table, editingId, record) : postRecord(opts.table, record);
            task.then(function () {
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

        var resetBtn = document.querySelector('[data-reset="' + opts.formEl.id + '"]');
        if (resetBtn) resetBtn.addEventListener('click', resetForm);

        return manager;
    }

    // ===== Practice areas =====
    var practiceAreasManager = entityManager({
        table: 'practice_areas',
        order: 'order=display_order.asc',
        listEl: document.getElementById('practice-areas-admin-list'),
        formEl: document.getElementById('practiceAreaForm'),
        emptyMessage: 'لا توجد مجالات ممارسة بعد.',
        archiveConfirm: 'سيتم تغيير حالة تفعيل مجال الممارسة هذا. هل تريد المتابعة؟',
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
                '<div class="flex gap-3 shrink-0">' +
                '<button type="button" data-edit-id="' + item.id + '" class="text-blue-500 hover:text-blue-700" aria-label="تعديل"><i class="fas fa-edit"></i></button>' +
                '<button type="button" data-archive-id="' + item.id + '" class="text-red-500 hover:text-red-700" aria-label="تبديل التفعيل"><i class="fas fa-toggle-' + (item.is_active ? 'on' : 'off') + '"></i></button>' +
                '</div></div>';
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
        archiveConfirm: 'سيتم أرشفة هذا المحامي وسيختفي من الموقع العام. هل تريد المتابعة؟',
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
                '</p></div>' +
                '<div class="flex gap-3 shrink-0">' +
                '<button type="button" data-edit-id="' + item.id + '" class="text-blue-500 hover:text-blue-700" aria-label="تعديل"><i class="fas fa-edit"></i></button>' +
                (archived ? '' : '<button type="button" data-archive-id="' + item.id + '" class="text-red-500 hover:text-red-700" aria-label="أرشفة"><i class="fas fa-box-archive"></i></button>') +
                '</div></div>';
        },
        archivePatch: function () { return { archived_at: nowIso() }; }
    });

    // ===== Services =====
    var servicesManager = entityManager({
        table: 'services',
        order: 'order=display_order.asc',
        listEl: document.getElementById('services-admin-list'),
        formEl: document.getElementById('serviceForm'),
        emptyMessage: 'لا توجد خدمات بعد.',
        archiveConfirm: 'سيتم أرشفة هذه الخدمة. هل تريد المتابعة؟',
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
                '<div class="flex gap-3 shrink-0">' +
                '<button type="button" data-edit-id="' + item.id + '" class="text-blue-500 hover:text-blue-700" aria-label="تعديل"><i class="fas fa-edit"></i></button>' +
                (archived ? '' : '<button type="button" data-archive-id="' + item.id + '" class="text-red-500 hover:text-red-700" aria-label="أرشفة"><i class="fas fa-box-archive"></i></button>') +
                '</div></div>';
        },
        archivePatch: function () { return { archived_at: nowIso(), status: 'draft' }; }
    });

    // ===== Posts =====
    var postsManager = entityManager({
        table: 'posts',
        order: 'order=created_at.desc',
        listEl: document.getElementById('posts-admin-list'),
        formEl: document.getElementById('postForm'),
        emptyMessage: 'لا توجد مقالات بعد.',
        archiveConfirm: 'سيتم أرشفة المقال بدلاً من حذفه نهائياً. هل تريد المتابعة؟',
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
                '</div>' +
                '<div class="flex gap-3 shrink-0">' +
                '<button type="button" data-edit-id="' + item.id + '" class="text-blue-500 hover:text-blue-700" aria-label="تعديل"><i class="fas fa-edit"></i></button>' +
                (archived ? '' : '<button type="button" data-archive-id="' + item.id + '" class="text-red-500 hover:text-red-700" aria-label="أرشفة"><i class="fas fa-box-archive"></i></button>') +
                '</div></div>';
        },
        archivePatch: function () { return { archived_at: nowIso(), status: 'draft' }; }
    });

    // ===== Cases =====
    var casesManager = entityManager({
        table: 'cases',
        order: 'order=created_at.desc',
        listEl: document.getElementById('cases-admin-list'),
        formEl: document.getElementById('caseForm'),
        emptyMessage: 'لا توجد قضايا مسجلة بعد.',
        archiveConfirm: 'سيتم أرشفة هذه القضية. هل تريد المتابعة؟',
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

            // Extra confirmation only when a case is actually transitioning from
            // not-published to published — editing an already-published case (e.g.
            // fixing internal notes) should not re-prompt every time.
            var wasPublished = existing && existing.public_status === 'published';
            if (publicStatus === 'published' && !wasPublished) {
                var confirmed = confirm('سيتم نشر هذه القضية للعامة الآن. لن يظهر سوى الحقول الذهبية (العنوان العام، الملخص، الوصف، النتيجة، السنة، الصورة). هل تريد المتابعة؟');
                if (!confirmed) { setStatus('تم إلغاء النشر. لم يتم حفظ أي تغييرات.', 'error'); return null; }
            }

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
                public_status: document.getElementById('casePublicStatus').value,
                public_slug: publicTitle ? (existing && existing.public_slug ? existing.public_slug : slugify(publicTitle)) : null
            };
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
            document.getElementById('casePublicStatus').value = record.public_status || 'draft';
        },
        renderRow: function (item) {
            var archived = Boolean(item.archived_at);
            return '<div class="entity-row flex justify-between items-start gap-3">' +
                '<div><h4 class="font-bold">' + escapeHtml(item.title) + ' <span class="text-xs text-gray-400">(' + escapeHtml(item.internal_reference) + ')</span></h4>' +
                '<p class="text-xs text-gray-500 mt-1">' + (archived ? statusBadge('مؤرشف', 'badge-archived') : (item.public_status === 'published' ? statusBadge('منشورة للعامة', 'badge-published') : statusBadge('غير منشورة', 'badge-draft'))) + '</p></div>' +
                '<div class="flex gap-3 shrink-0">' +
                '<button type="button" data-edit-id="' + item.id + '" class="text-blue-500 hover:text-blue-700" aria-label="تعديل"><i class="fas fa-edit"></i></button>' +
                (archived ? '' : '<button type="button" data-archive-id="' + item.id + '" class="text-red-500 hover:text-red-700" aria-label="أرشفة"><i class="fas fa-box-archive"></i></button>') +
                '</div></div>';
        },
        archivePatch: function () { return { archived_at: nowIso(), public_status: 'draft' }; }
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
            sessionStorage.removeItem('arabExpert.adminToken');
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
                sessionToken = result.access_token;
                sessionStorage.setItem('arabExpert.adminToken', sessionToken);
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
        if (platform.isSupabaseConfigured()) {
            if (!sessionToken) {
                renderAuth();
            } else {
                root.classList.remove('opacity-50');
                addLogoutButton();
                boot();
            }
        } else {
            root.classList.remove('opacity-50');
            setStatus('لوحة التحكم تتطلب إعداد Supabase في config.js. لا يوجد وضع محلي لإدارة المحتوى.', 'error');
        }
    });
}());
