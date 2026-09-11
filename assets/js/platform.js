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
        return supabaseRequest('posts?select=id,title,category,image,content,published_at,like_count&status=eq.published&archived_at=is.null&order=published_at.desc')
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

    // Only approved comments are ever readable by anon (enforced by RLS, not
    // just this select) — pending/rejected comments never reach this query.
    function getPostComments(postId) {
        if (!isSupabaseConfigured() || !postId) return Promise.resolve([]);
        return supabaseRequest('post_comments?select=id,author_name,content,created_at&post_id=eq.' + encodeURIComponent(postId) + '&status=eq.approved&order=created_at.desc')
            .catch(function (error) {
                console.warn('Comments could not be loaded from Supabase.', error);
                return [];
            });
    }

    // New comments are always inserted as 'pending' — enforced server-side by
    // a trigger regardless of what's sent here — so they won't appear via
    // getPostComments() until a staff member approves them in the admin panel.
    function submitComment(record) {
        var payload = {
            post_id: record.post_id,
            author_name: String(record.author_name || '').trim(),
            author_email: record.author_email ? String(record.author_email).trim() : null,
            content: String(record.content || '').trim()
        };
        if (!payload.post_id || !payload.author_name || !payload.content) {
            return Promise.reject(new Error('الاسم والتعليق مطلوبان.'));
        }
        if (!isSupabaseConfigured()) {
            return Promise.reject(new Error('التعليقات غير متاحة في وضع المعاينة المحلي.'));
        }
        return supabaseRequest('post_comments', {
            method: 'POST',
            headers: { Prefer: 'return=minimal' },
            body: JSON.stringify(payload)
        });
    }

    // Moves the shared like_count via a narrow security-definer RPC (see
    // migration 20260911000004) rather than a direct UPDATE — anon never
    // gets write access to public.posts itself. Returns the new count, or
    // null if the call failed (caller falls back to optimistic math).
    function setPostLike(postId, liked) {
        if (!isSupabaseConfigured() || !postId) return Promise.resolve(null);
        return supabaseRequest('rpc/' + (liked ? 'increment_post_like' : 'decrement_post_like'), {
            method: 'POST',
            body: JSON.stringify({ target_post_id: postId })
        }).catch(function (error) {
            console.warn('Like update failed.', error);
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
            bindLikes(post);
            bindComments(post);
        });
    }

    function likedPostIds() {
        try { return JSON.parse(localStorage.getItem('arabExpert.likedPosts') || '[]'); } catch (e) { return []; }
    }
    function saveLikedPostIds(ids) {
        try { localStorage.setItem('arabExpert.likedPosts', JSON.stringify(ids)); } catch (e) { /* storage unavailable */ }
    }

    // The like COUNT is server-authoritative (post.like_count, moved via the
    // RPC functions); "has this browser already liked this post" is a purely
    // local UI nicety with no security meaning, so it's fine to keep that one
    // bit in localStorage — nothing about the shared count depends on it.
    function bindLikes(post) {
        var btn = document.getElementById('like-btn');
        var countEl = document.getElementById('like-count');
        var iconEl = document.getElementById('like-icon');
        if (!btn || !countEl) return;
        var postId = post.id;

        function setVisual(isLiked) {
            if (!iconEl) return;
            iconEl.classList.toggle('text-red-500', isLiked);
            iconEl.classList.toggle('text-gray-600', !isLiked);
            iconEl.classList.toggle('dark:text-gray-400', !isLiked);
        }

        countEl.textContent = post.like_count || 0;
        setVisual(likedPostIds().indexOf(postId) !== -1);

        btn.addEventListener('click', function () {
            var ids = likedPostIds();
            var index = ids.indexOf(postId);
            var willLike = index === -1;
            btn.disabled = true;
            setPostLike(postId, willLike).then(function (newCount) {
                countEl.textContent = newCount != null ? newCount : Math.max(0, (Number(countEl.textContent) || 0) + (willLike ? 1 : -1));
                if (willLike) { ids.push(postId); } else { ids.splice(index, 1); }
                saveLikedPostIds(ids);
                setVisual(willLike);
            }).finally(function () { btn.disabled = false; });
        });
    }

    function commentItemHtml(comment) {
        var date = comment.created_at ? new Date(comment.created_at).toLocaleDateString('ar-EG') : '';
        return '<div class="bg-gray-50 dark:bg-gray-800 p-4 rounded-xl border border-gray-100 dark:border-gray-700">' +
            '<div class="flex items-center gap-2 mb-1">' +
            '<div class="w-6 h-6 rounded-full bg-primary-light/20 flex items-center justify-center text-primary-light text-xs"><i class="fas fa-user"></i></div>' +
            '<span class="text-xs font-bold text-gray-700 dark:text-gray-300">' + escapeHtml(comment.author_name) + '</span>' +
            '<span class="text-xs text-gray-400">•</span>' +
            '<span class="text-xs text-gray-400">' + escapeHtml(date) + '</span>' +
            '</div>' +
            '<p class="text-sm text-gray-700 dark:text-gray-300 whitespace-pre-wrap">' + escapeHtml(comment.content) + '</p></div>';
    }

    function renderComments(container, comments) {
        container.innerHTML = comments.length ? comments.map(commentItemHtml).join('') :
            '<p class="text-center text-gray-500 dark:text-gray-400 text-sm py-4">لا توجد تعليقات بعد. كن أول من يعلق!</p>';
    }

    function bindComments(post) {
        var list = document.getElementById('comments-list');
        var form = document.getElementById('comment-form');
        if (!list) return;

        function reload() {
            list.innerHTML = '<p class="text-center text-gray-500 dark:text-gray-400 text-sm py-4">جاري التحميل...</p>';
            getPostComments(post.id).then(function (comments) { renderComments(list, comments); });
        }
        reload();

        if (!form || form.dataset.bound) return;
        form.dataset.bound = 'true';
        form.addEventListener('submit', function (event) {
            event.preventDefault();
            var nameInput = document.getElementById('comment-name');
            var emailInput = document.getElementById('comment-email');
            var textInput = document.getElementById('comment-input');
            var statusEl = document.getElementById('comment-status');
            var submitBtn = document.getElementById('comment-submit');
            var name = nameInput.value.trim();
            var content = textInput.value.trim();
            if (!name || !content) {
                statusEl.textContent = 'يرجى إدخال الاسم ونص التعليق.';
                statusEl.classList.remove('hidden');
                return;
            }
            submitBtn.disabled = true;
            statusEl.classList.add('hidden');
            submitComment({ post_id: post.id, author_name: name, author_email: emailInput.value.trim(), content: content })
                .then(function () {
                    form.reset();
                    statusEl.textContent = 'شكراً لتعليقك! سيظهر بعد مراجعته من فريقنا.';
                    statusEl.classList.remove('hidden');
                }).catch(function (error) {
                    statusEl.textContent = error.message || 'تعذر إرسال التعليق. حاول مرة أخرى.';
                    statusEl.classList.remove('hidden');
                }).finally(function () {
                    submitBtn.disabled = false;
                });
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
        getPostComments: getPostComments,
        submitComment: submitComment,
        setPostLike: setPostLike,
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
