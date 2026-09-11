(function () {
    'use strict';

    var config = window.ARAB_EXPERT_CONFIG || {};
    var storageKey = 'arabExpert.content.v1';
    var legacyPostsKey = 'legalBlogPosts';

    var seed = {
        posts: [
            {
                id: 'welcome',
                title: 'كيف تحمي حقوقك قبل توقيع أي عقد؟',
                category: 'نصائح قانونية',
                image: '',
                content: 'مراجعة العقد قبل التوقيع خطوة أساسية لتجنب الالتزامات غير المتوقعة. استعن بمستشار قانوني لفهم الحقوق والالتزامات والجزاءات بوضوح.',
                status: 'published',
                published_at: '2026-01-15T00:00:00.000Z',
                archived_at: null
            }
        ],
        inquiries: []
    };

    function clone(value) {
        return JSON.parse(JSON.stringify(value));
    }

    function readLocal() {
        try {
            var value = JSON.parse(localStorage.getItem(storageKey) || 'null');
            if (value && Array.isArray(value.posts) && Array.isArray(value.inquiries)) return value;
            var legacy = JSON.parse(localStorage.getItem(legacyPostsKey) || '[]');
            var migrated = clone(seed);
            if (Array.isArray(legacy) && legacy.length) {
                migrated.posts = legacy.map(function (post, index) {
                    return Object.assign({}, post, {
                        id: post.id || 'legacy-' + index,
                        status: post.status || 'published',
                        published_at: post.published_at || new Date().toISOString(),
                        archived_at: post.archived_at || null
                    });
                });
            }
            writeLocal(migrated);
            return migrated;
        } catch (error) {
            console.error('Arab Expert local storage is unavailable.', error);
            return clone(seed);
        }
    }

    function writeLocal(value) {
        localStorage.setItem(storageKey, JSON.stringify(value));
    }

    function isSupabaseConfigured() {
        return Boolean(config.url && config.anonKey && window.fetch);
    }

    // PostgREST returns 201 (not 204) with an EMPTY body for POST with
    // Prefer: return=minimal — response.json() throws SyntaxError on an empty
    // body, so status alone cannot decide whether to parse. Read as text first.
    function parseResponseBody(response) {
        return response.text().then(function (text) {
            if (!text) return null;
            try { return JSON.parse(text); } catch (error) { return null; }
        });
    }

    function supabaseRequest(path, options) {
        var request = options || {};
        request.headers = Object.assign({
            apikey: config.anonKey,
            Authorization: 'Bearer ' + config.anonKey,
            'Content-Type': 'application/json',
            Accept: 'application/json'
        }, request.headers || {});
        return fetch(config.url.replace(/\/$/, '') + '/rest/v1/' + path, request).then(function (response) {
            if (!response.ok) throw new Error('Supabase request failed: ' + response.status);
            return parseResponseBody(response);
        });
    }

    function getPublishedPosts() {
        if (!isSupabaseConfigured()) {
            return Promise.resolve(readLocal().posts.filter(function (post) {
                return post.status === 'published' && !post.archived_at;
            }));
        }
        return supabaseRequest('posts?select=id,title,category,image,content,published_at&status=eq.published&archived_at=is.null&order=published_at.desc')
            .catch(function (error) {
                console.warn('Published content could not be loaded from Supabase.', error);
                return [];
            });
    }

    // Reads the cases_public view (not the cases table directly), which exposes only
    // the intentionally public columns. See supabase/migrations/20260911000002_case_confidentiality_view.sql.
    // Never change this to query the "cases" table directly for anonymous/public pages.
    function getPublishedCases() {
        if (!isSupabaseConfigured()) return Promise.resolve([]);
        return supabaseRequest('cases_public?select=*&order=public_year.desc')
            .catch(function (error) {
                console.warn('Published case studies could not be loaded from Supabase.', error);
                return [];
            });
    }

    function getPublishedCaseBySlug(slug) {
        if (!isSupabaseConfigured() || !slug) return Promise.resolve(null);
        return supabaseRequest('cases_public?select=*&public_slug=eq.' + encodeURIComponent(slug) + '&limit=1')
            .then(function (rows) { return (rows && rows[0]) || null; })
            .catch(function (error) {
                console.warn('Published case could not be loaded from Supabase.', error);
                return null;
            });
    }

    // practice_areas is a fully public table (own RLS policy), safe to read directly.
    function getActivePracticeAreas() {
        if (!isSupabaseConfigured()) return Promise.resolve([]);
        return supabaseRequest('practice_areas?select=id,name,slug&is_active=eq.true&order=display_order.asc')
            .catch(function (error) {
                console.warn('Practice areas could not be loaded from Supabase.', error);
                return [];
            });
    }

    function escapeHtml(value) {
        return String(value == null ? '' : value).replace(/[&<>"']/g, function (character) {
            return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' })[character];
        });
    }

    function safeMediaUrl(value) {
        var url = String(value || '').trim();
        if (!url || /^(javascript|data|vbscript):/i.test(url)) return '';
        return url;
    }

    function postCard(post, index) {
        var imageUrl = safeMediaUrl(post.image);
        var image = imageUrl ? '<img src="' + escapeHtml(imageUrl) + '" alt="" class="w-full h-48 object-cover" loading="lazy">' : '';
        return '<article class="creative-card overflow-hidden hover-lift">' + image +
            '<div class="p-5"><span class="text-xs text-primary-light font-bold">' + escapeHtml(post.category || 'مقال قانوني') + '</span>' +
            '<h3 class="font-bold text-lg mt-2 mb-3">' + escapeHtml(post.title) + '</h3>' +
            '<p class="text-sm text-gray-600 dark:text-gray-300 line-clamp-3">' + escapeHtml(post.content) + '</p>' +
            '<a class="inline-flex mt-4 text-primary-light font-semibold" href="post-detail.html?id=' + encodeURIComponent(post.id || index) + '">قراءة المزيد <span class="mr-2">←</span></a></div></article>';
    }

    function renderPosts(container, posts, limit) {
        if (!container) return;
        var visible = posts.slice(0, limit || posts.length);
        container.innerHTML = visible.length ? visible.map(postCard).join('') :
            '<p class="col-span-full text-center text-gray-500 py-8">لا توجد منشورات منشورة حالياً.</p>';
    }

    function bindPublicContent() {
        getPublishedPosts().then(function (posts) {
            renderPosts(document.getElementById('posts-container'), posts);
            renderPosts(document.getElementById('recent-posts-container'), posts, 3);
        });
    }

    function bindPostDetail() {
        var title = document.getElementById('post-title');
        if (!title) return;
        var requestedId = new URLSearchParams(window.location.search).get('id');
        if (!requestedId) return;
        getPublishedPosts().then(function (posts) {
            var post = posts.find(function (item, index) {
                return String(item.id) === requestedId || String(index) === requestedId;
            });
            if (!post) return;
            document.getElementById('post-category').textContent = post.category || 'مقال قانوني';
            title.textContent = post.title;
            document.getElementById('post-date').textContent = post.published_at ? new Date(post.published_at).toLocaleDateString('ar-EG') : '';
            document.getElementById('post-content').textContent = post.content;
            var image = document.getElementById('post-image');
            var imageUrl = safeMediaUrl(post.image);
            if (image && imageUrl) {
                image.src = imageUrl;
                image.classList.remove('hidden');
            }
            document.title = post.title + ' - مؤسسة الخبراء العرب';
            updateMeta(post.title + ' - مؤسسة الخبراء العرب', post.content, 'post-detail.html?id=' + encodeURIComponent(post.id || requestedId));
        });
    }

    function updateMeta(title, description, canonicalPath) {
        if (title) document.title = title;
        var descriptionTag = document.getElementById('meta-description');
        if (descriptionTag && description) {
            var trimmed = String(description).trim().replace(/\s+/g, ' ');
            descriptionTag.setAttribute('content', trimmed.length > 160 ? trimmed.slice(0, 157) + '...' : trimmed);
        }
        var canonicalTag = document.getElementById('meta-canonical');
        if (canonicalTag && canonicalPath) canonicalTag.setAttribute('href', canonicalPath);
    }

    function caseCard(item, practiceAreaNamesById) {
        var imageUrl = safeMediaUrl(item.featured_image);
        var image = imageUrl ? '<img src="' + escapeHtml(imageUrl) + '" alt="" class="w-full h-48 object-cover" loading="lazy">' : '';
        var badges = '';
        if (item.public_year) badges += '<span class="text-xs text-primary-light font-bold">' + escapeHtml(String(item.public_year)) + '</span>';
        var areaName = practiceAreaNamesById && item.practice_area_id ? practiceAreaNamesById[item.practice_area_id] : null;
        if (areaName) badges += '<span class="text-xs bg-primary-light/10 dark:bg-primary-dark/10 text-primary-light dark:text-primary-dark px-3 py-1 rounded-full font-bold mr-2">' + escapeHtml(areaName) + '</span>';
        return '<article class="creative-card overflow-hidden hover-lift">' + image +
            '<div class="p-5">' + badges +
            '<h3 class="font-bold text-lg mt-2 mb-3">' + escapeHtml(item.public_title || '') + '</h3>' +
            '<p class="text-sm text-gray-600 dark:text-gray-300 line-clamp-3">' + escapeHtml(item.public_summary || '') + '</p>' +
            '<a class="inline-flex mt-4 text-primary-light font-semibold" href="case-study.html?slug=' + encodeURIComponent(item.public_slug || item.id) + '">التفاصيل <span class="mr-2">←</span></a></div></article>';
    }

    function renderCases(container, cases, practiceAreaNamesById) {
        if (!container) return;
        container.innerHTML = cases.length ? cases.map(function (item) { return caseCard(item, practiceAreaNamesById); }).join('') :
            '<p class="col-span-full text-center text-gray-500 py-8">لا توجد قضايا منشورة حالياً.</p>';
    }

    function practiceAreaMap(areas) {
        var map = {};
        areas.forEach(function (area) { map[area.id] = area.name; });
        return map;
    }

    function bindCaseStudies() {
        var container = document.getElementById('cases-container');
        if (!container) return;
        Promise.all([getPublishedCases(), getActivePracticeAreas()]).then(function (results) {
            renderCases(container, results[0], practiceAreaMap(results[1]));
        });
    }

    function bindCaseStudyDetail() {
        var title = document.getElementById('case-title');
        if (!title) return;
        var loading = document.getElementById('case-loading');
        var article = document.getElementById('case-article');
        var notFound = document.getElementById('case-not-found');
        var slug = new URLSearchParams(window.location.search).get('slug');
        if (!slug) {
            if (loading) loading.classList.add('hidden');
            if (notFound) notFound.classList.remove('hidden');
            return;
        }
        Promise.all([getPublishedCaseBySlug(slug), getActivePracticeAreas()]).then(function (results) {
            var item = results[0];
            var areas = practiceAreaMap(results[1]);
            if (loading) loading.classList.add('hidden');
            if (!item) {
                if (notFound) notFound.classList.remove('hidden');
                return;
            }
            if (article) article.classList.remove('hidden');
            title.textContent = item.public_title || '';
            var yearEl = document.getElementById('case-year');
            if (yearEl) yearEl.textContent = item.public_year ? String(item.public_year) : '';
            var areaEl = document.getElementById('case-practice-area');
            if (areaEl) areaEl.textContent = item.practice_area_id ? (areas[item.practice_area_id] || '') : '';
            var setSection = function (sectionId, textId, value) {
                var section = document.getElementById(sectionId);
                var text = document.getElementById(textId);
                if (!section || !text) return;
                if (value) { text.textContent = value; section.hidden = false; } else { section.hidden = true; }
            };
            setSection('case-summary-section', 'case-summary', item.public_summary);
            setSection('case-description-section', 'case-description', item.public_description);
            setSection('case-outcome-section', 'case-outcome', item.public_outcome);
            var image = document.getElementById('case-image');
            var imageUrl = safeMediaUrl(item.featured_image);
            if (image && imageUrl) {
                image.src = imageUrl;
                image.classList.remove('hidden');
            }
            updateMeta(
                (item.public_title || 'قضية') + ' - مؤسسة الخبراء العرب',
                item.public_summary || item.public_description || '',
                'case-study.html?slug=' + encodeURIComponent(item.public_slug || item.id)
            );
        }).catch(function () {
            if (loading) loading.classList.add('hidden');
            if (notFound) notFound.classList.remove('hidden');
        });
    }

    // Single source of truth for persisting a contact request. contact.html's own
    // sendMessage()/openWhatsApp() flow owns validation and UX; this only persists
    // the already-validated record (Supabase when configured, local fallback otherwise).
    // Do not also bind a competing submit handler here — a page must call this itself
    // once it has validated input, to avoid two handlers firing on the same click.
    function submitContactRequest(record) {
        var payload = {
            name: String(record.name || '').trim(),
            email: String(record.email || '').trim(),
            phone: String(record.phone || '').trim(),
            message: String(record.message || '').trim(),
            services: Array.isArray(record.services) ? record.services : []
        };
        if (!payload.name || !payload.phone || !payload.message) {
            return Promise.reject(new Error('الاسم والهاتف والرسالة مطلوبة.'));
        }
        if (isSupabaseConfigured()) {
            return supabaseRequest('contact_requests', {
                method: 'POST',
                headers: { Prefer: 'return=minimal' },
                body: JSON.stringify(payload)
            });
        }
        var data = readLocal();
        data.inquiries.push(Object.assign({ status: 'new', created_at: new Date().toISOString() }, payload));
        writeLocal(data);
        return Promise.resolve(null);
    }

    window.ArabExpertPlatform = {
        config: config,
        isSupabaseConfigured: isSupabaseConfigured,
        getPublishedPosts: getPublishedPosts,
        getPublishedCases: getPublishedCases,
        getPublishedCaseBySlug: getPublishedCaseBySlug,
        getActivePracticeAreas: getActivePracticeAreas,
        submitContactRequest: submitContactRequest,
        readLocal: readLocal,
        writeLocal: writeLocal,
        escapeHtml: escapeHtml,
        safeMediaUrl: safeMediaUrl
    };

    document.addEventListener('DOMContentLoaded', function () {
        bindPublicContent();
        bindPostDetail();
        bindCaseStudies();
        bindCaseStudyDetail();
    });
}());
