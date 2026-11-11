/**
 * TikTok Ultimate All-in-One Extractors
 * Supports dual-engine extraction:
 * 1. Ultra-fast SSR Rehydration JSON Data (__UNIVERSAL_DATA_FOR_REHYDRATION__ / SIGI_STATE)
 * 2. Playwright XHR API Interception + Rehydration + Resilient DOM Fallbacks
 * Covers:
 * - Profiles & B2B Leads
 * - Standard Videos & Feed Video Extraction
 * - Photo Slideshows (TikTok Photo Mode)
 * - Comments & Replies
 * - Sounds & Music
 * - Hashtags & Challenges
 * - Keyword Search, TikTok Shop Products & Live Metadata
 */

import { gotScraping } from 'got-scraping';

// ==================== TYPE & SCHEMA SANITIZATION HELPERS ====================

/**
 * Parses compact TikTok counter strings ("1.2M", "45.3K", "2B", "1,234") or numbers into a safe integer.
 * Returns undefined when the value is not numeric or cannot be parsed.
 * @param {unknown} raw
 * @returns {number|undefined}
 */
export function parseCompactNumber(raw) {
    if (typeof raw === 'number') {
        return Number.isFinite(raw) ? Math.trunc(raw) : undefined;
    }
    if (typeof raw !== 'string') return undefined;

    const cleaned = raw.trim().replace(/,/g, '');
    if (!cleaned) return undefined;

    const match = cleaned.match(/^(-?\d+(?:\.\d+)?)\s*([KMB])?$/i);
    if (!match) return undefined;

    const base = Number(match[1]);
    if (!Number.isFinite(base)) return undefined;

    const suffix = (match[2] || '').toUpperCase();
    const multiplier = suffix === 'K' ? 1_000 : suffix === 'M' ? 1_000_000 : suffix === 'B' ? 1_000_000_000 : 1;
    const value = Math.trunc(base * multiplier);
    return Number.isFinite(value) ? value : undefined;
}

/**
 * Coerces a numeric or compact string into a safe integer, returning undefined otherwise.
 * @param {unknown} raw
 * @returns {number|undefined}
 */
export function toSafeInt(raw) {
    return parseCompactNumber(raw);
}

/**
 * Coerces a value into a string (converting numeric IDs safely). Returns undefined if empty/null/object.
 * @param {unknown} raw
 * @param {{ allowEmpty?: boolean }} [options]
 * @returns {string|undefined}
 */
export function toSafeString(raw, { allowEmpty = false } = {}) {
    if (typeof raw === 'string') {
        const trimmed = raw.trim();
        if (!trimmed && !allowEmpty) return undefined;
        return trimmed;
    }
    if (typeof raw === 'number' && Number.isFinite(raw)) {
        return String(raw);
    }
    return undefined;
}

/**
 * Converts a Unix timestamp (seconds or milliseconds) or date string into an ISO 8601 string.
 * @param {unknown} raw
 * @returns {string|undefined}
 */
export function toIsoTimestamp(raw) {
    if (raw === null || raw === undefined || raw === '') return undefined;
    let ms;
    if (typeof raw === 'number' && Number.isFinite(raw)) {
        ms = raw < 1_000_000_000_000 ? raw * 1000 : raw;
    } else if (typeof raw === 'string') {
        const num = Number(raw.trim());
        if (Number.isFinite(num) && raw.trim() !== '') {
            ms = num < 1_000_000_000_000 ? num * 1000 : num;
        } else {
            ms = Date.parse(raw);
        }
    } else {
        return undefined;
    }
    if (!Number.isFinite(ms)) return undefined;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

/**
 * Recursively strips null, undefined, and NaN/non-finite numbers so emitted dataset records
 * comply strictly with .actor/dataset_schema.json Draft-07 validation.
 * @template T
 * @param {T} value
 * @returns {T}
 */
export function sanitizeRecord(value) {
    if (value === null || value === undefined) return undefined;
    if (typeof value === 'number') {
        return Number.isFinite(value) ? value : undefined;
    }
    if (Array.isArray(value)) {
        return value
            .map((item) => sanitizeRecord(item))
            .filter((item) => item !== undefined);
    }
    if (typeof value === 'object') {
        const out = {};
        for (const [k, v] of Object.entries(value)) {
            const cleaned = sanitizeRecord(v);
            if (cleaned !== undefined) {
                out[k] = cleaned;
            }
        }
        return out;
    }
    return value;
}

// ==================== URL & INPUT HELPERS ====================

/**
 * Normalizes TikTok URLs, hashtags, and handles (e.g. @tiktok -> https://www.tiktok.com/@tiktok).
 * Preserves the literal '@' symbol in profile paths instead of encoding it to '%40'.
 * @param {string} input
 * @returns {string}
 */
export function normalizeTikTokUrl(input) {
    if (!input || typeof input !== 'string') return '';
    let url = input.trim();
    if (!url) return '';

    if (/^https?:\/\//i.test(url)) {
        return url;
    }
    if (/^(?:www\.|m\.|vm\.|vt\.|shop\.|live\.)?tiktok\.com\//i.test(url)) {
        return `https://${url}`;
    }
    if (url.startsWith('#')) {
        const tag = url.slice(1).trim().replace(/\s+/g, '');
        return tag ? `https://www.tiktok.com/tag/${encodeURIComponent(tag)}` : '';
    }
    const cleanHandle = url.replace(/^@+/, '').trim();
    if (!cleanHandle) return '';
    return `https://www.tiktok.com/@${encodeURIComponent(cleanHandle)}`;
}

/**
 * Builds a TikTok search or hashtag URL from a keyword according to the requested scrapeMode.
 * @param {string} keyword
 * @param {string} [scrapeMode='AUTO_DETECT']
 * @returns {string}
 */
export function buildSearchUrl(keyword, scrapeMode = 'AUTO_DETECT') {
    if (!keyword || typeof keyword !== 'string') return '';
    const trimmed = keyword.trim();
    if (!trimmed) return '';

    if (trimmed.startsWith('#') || scrapeMode === 'HASHTAGS') {
        const cleanTag = trimmed.replace(/^#+/, '').replace(/\s+/g, '');
        return cleanTag ? `https://www.tiktok.com/tag/${encodeURIComponent(cleanTag)}` : '';
    }
    if (scrapeMode === 'PROFILES') {
        return `https://www.tiktok.com/search/user?q=${encodeURIComponent(trimmed)}`;
    }
    return `https://www.tiktok.com/search?q=${encodeURIComponent(trimmed)}`;
}

/**
 * Automatically detects TikTok URL type.
 * @param {string} url
 * @returns {string}
 */
export function detectTikTokUrlType(url) {
    if (!url) return 'PROFILES';
    const lower = url.toLowerCase();

    if (lower.includes('/video/')) return 'VIDEOS';
    if (lower.includes('/photo/')) return 'PHOTO_SLIDES';
    if (lower.includes('/tag/')) return 'HASHTAGS';
    if (lower.includes('/music/')) return 'MUSIC_SOUNDS';
    if (lower.includes('/search')) return 'KEYWORD_SEARCH';
    if (lower.includes('shop.tiktok.com') || lower.includes('/shop')) return 'TIKTOK_SHOP';
    if (lower.includes('live.tiktok.com') || /\/live(?:[/?#]|$)/.test(lower)) return 'LIVE_METADATA';

    return 'PROFILES';
}

/**
 * Returns true if the URL is a collection/feed page rather than an individual video/photo detail page.
 * @param {string} url
 * @returns {boolean}
 */
export function isTikTokFeedUrl(url) {
    const urlType = detectTikTokUrlType(url);
    return urlType === 'PROFILES' || urlType === 'HASHTAGS' || urlType === 'KEYWORD_SEARCH' || urlType === 'MUSIC_SOUNDS';
}

/**
 * Extracts username from profile or video URL.
 * @param {string} url
 * @returns {string}
 */
export function extractTikTokUsername(url) {
    if (!url || typeof url !== 'string') return '';
    const decoded = decodeURIComponentSafe(url);
    const match = decoded.match(/tiktok\.com\/@([a-zA-Z0-9_.-]+)/);
    return match ? match[1] : '';
}

function decodeURIComponentSafe(value) {
    try {
        return decodeURIComponent(value);
    } catch {
        return value;
    }
}

/**
 * Parses custom cookie strings (JSON array or 'k=v; k2=v2') into Playwright cookies & HTTP Cookie header.
 * @param {string} customCookies
 * @returns {{ playwrightCookies: Array<object>, cookieHeader: string }}
 */
export function parseCustomCookies(customCookies) {
    if (!customCookies || typeof customCookies !== 'string') {
        return { playwrightCookies: [], cookieHeader: '' };
    }
    const trimmed = customCookies.trim();
    if (!trimmed) return { playwrightCookies: [], cookieHeader: '' };

    let parsed = [];
    if (trimmed.startsWith('[')) {
        try {
            const arr = JSON.parse(trimmed);
            if (Array.isArray(arr)) {
                parsed = arr
                    .filter((c) => c && typeof c.name === 'string' && c.value !== undefined)
                    .map((c) => ({
                        name: c.name.trim(),
                        value: String(c.value),
                        domain: c.domain || '.tiktok.com',
                        path: c.path || '/',
                        ...(typeof c.httpOnly === 'boolean' ? { httpOnly: c.httpOnly } : {}),
                        ...(typeof c.secure === 'boolean' ? { secure: c.secure } : {}),
                    }))
                    .filter((c) => c.name.length > 0);
            }
        } catch {
            return { playwrightCookies: [], cookieHeader: '' };
        }
    } else {
        parsed = trimmed
            .split(';')
            .map((pair) => {
                const idx = pair.indexOf('=');
                if (idx <= 0) return null;
                const name = pair.slice(0, idx).trim();
                const value = pair.slice(idx + 1).trim();
                if (!name || !value) return null;
                return {
                    name,
                    value,
                    domain: '.tiktok.com',
                    path: '/',
                };
            })
            .filter(Boolean);
    }

    const cookieHeader = parsed.map((c) => `${c.name}=${c.value}`).join('; ');
    return { playwrightCookies: parsed, cookieHeader };
}

/**
 * Extracts email and phone leads from text (skipping TikTok/ByteDance system domains and ISO dates).
 * @param {string} text
 * @returns {{ email: string|undefined, phone: string|undefined }}
 */
export function extractLeadsFromText(text) {
    if (!text || typeof text !== 'string') return { email: undefined, phone: undefined };

    let email;
    const emailMatch = text.match(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,7}\b/);
    if (
        emailMatch &&
        !emailMatch[0].toLowerCase().includes('tiktok.com') &&
        !emailMatch[0].toLowerCase().includes('bytedance.com')
    ) {
        email = emailMatch[0];
    }

    let phone;
    const phoneMatch = text.match(/(?:\+\d{1,4}[\s.-]?|\(\d{2,4}\)[\s.-]?)\d{2,4}[\s.-]?\d{3,4}(?:[\s.-]?\d{2,4})?|\b\d{3}[\s.-]\d{3}[\s.-]\d{4}\b/);
    if (phoneMatch) {
        const candidate = phoneMatch[0].trim();
        const digits = candidate.replace(/\D/g, '');
        const looksLikeIsoDate = /^\d{4}[-/]\d{1,2}[-/]\d{1,2}$/.test(candidate);
        if (!looksLikeIsoDate && digits.length >= 8 && digits.length <= 15) {
            phone = candidate;
        }
    }

    return { email, phone };
}

// ==================== WAF / CAPTCHA & SSR REHYDRATION PARSING ====================

/**
 * Extracts __UNIVERSAL_DATA_FOR_REHYDRATION__ or SIGI_STATE JSON from raw HTML string.
 * @param {string} html
 * @returns {Record<string, any>|null}
 */
export function extractRehydrationFromHtml(html) {
    if (!html || typeof html !== 'string') return null;

    const uniMatch = html.match(/<script[^>]*id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/i);
    if (uniMatch && uniMatch[1]) {
        try {
            const parsed = JSON.parse(uniMatch[1]);
            return parsed?.__DEFAULT_SCOPE__ || parsed || null;
        } catch {
            // Try fallback
        }
    }

    const sigiMatch = html.match(/<script[^>]*id="SIGI_STATE"[^>]*>([\s\S]*?)<\/script>/i);
    if (sigiMatch && sigiMatch[1]) {
        try {
            return JSON.parse(sigiMatch[1]);
        } catch {
            return null;
        }
    }

    return null;
}

/**
 * Checks whether an HTML response is a ByteDance SlardarWAF challenge or CAPTCHA verification page
 * rather than usable TikTok content.
 * @param {string} html
 * @returns {string|null} Reason if blocked, else null
 */
export function detectWafOrCaptchaFromHtml(html) {
    if (!html || typeof html !== 'string') return 'Empty HTML response from TikTok';

    const scope = extractRehydrationFromHtml(html);
    if (
        scope &&
        (scope['webapp.user-detail']?.userInfo?.user ||
            scope['webapp.video-detail']?.itemInfo?.itemStruct ||
            scope['webapp.challenge-detail']?.challengeInfo ||
            (Array.isArray(scope['webapp.challenge-detail']?.itemList) && scope['webapp.challenge-detail'].itemList.length > 0))
    ) {
        return null;
    }

    if (/slardarClient["']?\s*:\s*["']?SlardarWAF|slardar_us_waf|waf-jschallenge/i.test(html) && html.length < 20_000) {
        return 'TikTok returned a SlardarWAF challenge shell';
    }
    if (/id=["']captcha-verify-image["']|class=["'][^"']*captcha-verify|verify\.tiktok\.com/i.test(html) && html.length < 50_000) {
        return 'TikTok returned a CAPTCHA verification page';
    }
    return null;
}

/**
 * Checks in Playwright whether a CAPTCHA / WAF verification screen is actively blocking the page.
 * @param {import('playwright').Page} page
 * @returns {Promise<string|null>}
 */
export async function detectWafOrCaptchaOnPage(page) {
    try {
        return await page.evaluate(() => {
            const url = window.location.href || '';
            const title = (document.title || '').toLowerCase();
            const textLen = (document.body?.innerText || '').trim().length;

            if (/captcha|verify\.tiktok\.com/i.test(url)) {
                return 'Redirected to TikTok verification/CAPTCHA page';
            }
            if (document.getElementById('slardar-config') && textLen < 200 && !document.getElementById('__UNIVERSAL_DATA_FOR_REHYDRATION__')) {
                return 'Blocked by TikTok SlardarWAF JS challenge';
            }
            if (
                document.querySelector('#captcha-verify-image, #captcha_container, [id*="captcha-verify"], iframe[src*="captcha"]') ||
                title.includes('verify')
            ) {
                return 'TikTok CAPTCHA challenge overlay detected';
            }
            const bodySnippet = (document.body?.innerText || '').slice(0, 500);
            if (/Drag the puzzle piece|Select 2 objects|Verify to continue/i.test(bodySnippet)) {
                return 'TikTok interactive CAPTCHA verification required';
            }
            return null;
        });
    } catch {
        return null;
    }
}

// ==================== NORMALIZED RECORD MAPPERS ====================

/**
 * Maps TikTok user/userInfo data from SSR rehydration, XHR API, or search results into a sanitized PROFILE record.
 * @param {object} userInfo
 * @param {string} sourceUrl
 * @param {{ extractEmailAndPhone?: boolean }} [options]
 * @returns {object|null}
 */
export function mapUserInfoToProfileRecord(userInfo, sourceUrl, { extractEmailAndPhone = true } = {}) {
    if (!userInfo || typeof userInfo !== 'object') return null;
    const user = userInfo.user || userInfo.user_info || userInfo;
    if (!user || typeof user !== 'object') return null;

    const stats = userInfo.stats || userInfo.statsV2 || {};
    const username = toSafeString(user.uniqueId ?? user.unique_id ?? extractTikTokUsername(sourceUrl));
    const nickname = toSafeString(user.nickname);
    const id = toSafeString(user.id ?? user.uid);

    if (!username && !nickname && !id) return null;

    const biography = toSafeString(user.signature, { allowEmpty: true }) ?? '';
    const leads = extractEmailAndPhone ? extractLeadsFromText(biography) : { email: undefined, phone: undefined };

    const canonicalUrl = username ? `https://www.tiktok.com/@${username}` : sourceUrl;

    return sanitizeRecord({
        type: 'PROFILE',
        url: canonicalUrl,
        sourceUrl: sourceUrl && sourceUrl !== canonicalUrl ? sourceUrl : undefined,
        id,
        secUid: toSafeString(user.secUid ?? user.sec_uid),
        username,
        nickname: nickname ?? username,
        biography,
        bioLink: toSafeString(user.bioLink?.link),
        followersCount: toSafeInt(stats.followerCount ?? stats.follower_count ?? user.follower_count),
        followingCount: toSafeInt(stats.followingCount ?? stats.following_count ?? user.following_count),
        heartCount: toSafeInt(stats.heartCount ?? stats.heart ?? stats.total_favorited ?? user.total_favorited),
        videoCount: toSafeInt(stats.videoCount ?? stats.video_count ?? user.aweme_count),
        isVerified: Boolean(user.verified || user.customVerify || user.custom_verify),
        email: leads.email,
        phone: leads.phone,
        avatarUrl: toSafeString(user.avatarLarger || user.avatarMedium || user.avatarThumb || user.avatar_larger?.url_list?.[0]),
        scrapedAt: new Date().toISOString(),
    });
}

/**
 * Maps any TikTok itemStruct (SSR, SIGI_STATE, /api/post/item_list, /api/challenge/item_list, /api/search/)
 * into a sanitized VIDEO or PHOTO_SLIDES record.
 * @param {object} item
 * @param {{ fallbackUrl?: string }} [options]
 * @returns {object|null}
 */
export function mapItemStructToVideoRecord(item, { fallbackUrl } = {}) {
    if (!item || typeof item !== 'object') return null;

    const id = toSafeString(item.id ?? item.aweme_id);
    const authorUsername = toSafeString(item.author?.uniqueId ?? item.author?.unique_id ?? (fallbackUrl ? extractTikTokUsername(fallbackUrl) : undefined));
    const authorNickname = toSafeString(item.author?.nickname);

    const imageListRaw = item.imagePost?.images || item.image_post_info?.images || [];
    const photoUrls = Array.isArray(imageListRaw)
        ? imageListRaw
              .map((img) => toSafeString(img?.imageURL?.urlList?.[0] ?? img?.display_image?.url_list?.[0]))
              .filter(Boolean)
        : [];
    const isPhotoSlide = photoUrls.length > 0;

    const videoObj = item.video || {};
    const videoUrl = toSafeString(
        videoObj.playAddr ||
            videoObj.downloadAddr ||
            videoObj.play_addr?.url_list?.[0] ||
            videoObj.download_addr?.url_list?.[0]
    );
    const coverUrl = toSafeString(
        videoObj.cover ||
            videoObj.dynamicCover ||
            videoObj.originCover ||
            videoObj.cover?.url_list?.[0] ||
            videoObj.origin_cover?.url_list?.[0]
    );

    const stats = item.stats || item.statistics || {};
    const challengeTitles = (item.challenges || item.cha_list || [])
        .map((c) => toSafeString(c?.title ?? c?.cha_name))
        .filter(Boolean);
    const textExtraTags = (item.textExtra || item.text_extra || [])
        .map((t) => toSafeString(t?.hashtagName ?? t?.hashtag_name))
        .filter(Boolean);
    const hashtags = Array.from(new Set([...challengeTitles, ...textExtraTags]));

    const canonicalUrl =
        authorUsername && id
            ? `https://www.tiktok.com/@${authorUsername}/${isPhotoSlide ? 'photo' : 'video'}/${id}`
            : toSafeString(fallbackUrl);

    if (!id && !canonicalUrl) return null;

    return sanitizeRecord({
        type: isPhotoSlide ? 'PHOTO_SLIDES' : 'VIDEO',
        url: canonicalUrl,
        sourceUrl: fallbackUrl && fallbackUrl !== canonicalUrl ? fallbackUrl : undefined,
        id,
        desc: toSafeString(item.desc, { allowEmpty: true }) ?? '',
        isPhotoSlide,
        photoUrls,
        videoUrl,
        coverUrl,
        durationSec: toSafeInt(videoObj.duration),
        authorUsername,
        authorNickname,
        playCount: toSafeInt(stats.playCount ?? stats.play_count),
        diggCount: toSafeInt(stats.diggCount ?? stats.digg_count),
        commentCount: toSafeInt(stats.commentCount ?? stats.comment_count),
        shareCount: toSafeInt(stats.shareCount ?? stats.share_count),
        collectCount: toSafeInt(stats.collectCount ?? stats.collect_count),
        musicId: toSafeString(item.music?.id ?? item.music?.id_str),
        musicTitle: toSafeString(item.music?.title),
        musicAuthor: toSafeString(item.music?.authorName ?? item.music?.author),
        hashtags,
        timestamp: toIsoTimestamp(item.createTime ?? item.create_time),
        scrapedAt: new Date().toISOString(),
    });
}

/**
 * Maps raw TikTok API comments into structured comment records.
 * @param {Array<object>} rawComments
 * @param {number} maxComments
 * @returns {Array<object>}
 */
export function mapApiComments(rawComments, maxComments = 20) {
    if (!Array.isArray(rawComments) || maxComments <= 0) return [];
    const out = [];
    for (const c of rawComments) {
        if (!c || typeof c !== 'object') continue;
        const text = toSafeString(c.text);
        if (!text) continue;
        out.push(
            sanitizeRecord({
                commentIndex: out.length + 1,
                id: toSafeString(c.cid ?? c.id),
                author: toSafeString(c.user?.unique_id ?? c.user?.uniqueId ?? c.user?.nickname) || 'User',
                authorNickname: toSafeString(c.user?.nickname),
                text,
                likesCount: toSafeInt(c.digg_count ?? c.diggCount) ?? 0,
                likes: String(toSafeInt(c.digg_count ?? c.diggCount) ?? 0),
                replyCount: toSafeInt(c.reply_comment_total) ?? 0,
                time: toIsoTimestamp(c.create_time ?? c.createTime) ?? '',
            })
        );
        if (out.length >= maxComments) break;
    }
    return out;
}

// ==================== FAST HTTP SSR ENGINE (gotScraping) ====================

/**
 * Attempts fast HTTP SSR HTML extraction using gotScraping (browser TLS fingerprints) + optional proxy.
 * Short-circuits Playwright ONLY when rich __UNIVERSAL_DATA_FOR_REHYDRATION__ / SIGI_STATE JSON satisfies
 * the target mode cleanly without needing JS/XHR scrolling or comments.
 * @param {string} url
 * @param {string} activeMode
 * @param {{ proxyUrl?: string, cookieHeader?: string, maxCommentsPerVideo?: number, extractEmailAndPhone?: boolean, maxItems?: number }} [options]
 * @returns {Promise<{ ok: boolean, records?: Array<object>, reason?: string }>}
 */
export async function tryFastSsrExtract(url, activeMode, options = {}) {
    const {
        proxyUrl,
        cookieHeader = '',
        maxCommentsPerVideo = 0,
        extractEmailAndPhone = true,
        maxItems = 20,
    } = options;

    const urlType = detectTikTokUrlType(url);

    // Search pages and comment-heavy runs depend on client JS/XHR; delegate directly to Playwright.
    if (activeMode === 'COMMENTS' || activeMode === 'KEYWORD_SEARCH' || activeMode === 'TIKTOK_SHOP' || urlType === 'KEYWORD_SEARCH') {
        return { ok: false, reason: 'Mode requires interactive browser XHR/scrolling' };
    }
    if ((urlType === 'VIDEOS' || urlType === 'PHOTO_SLIDES') && maxCommentsPerVideo > 0) {
        return { ok: false, reason: 'Comments requested; using Playwright to load comment feed' };
    }
    if (urlType === 'PROFILES' && (activeMode === 'VIDEOS' || activeMode === 'PHOTO_SLIDES')) {
        // Profile video feeds load via signed XHR /api/post/item_list
        return { ok: false, reason: 'Profile feed videos require XHR/Playwright' };
    }
    if (urlType === 'HASHTAGS' && (activeMode === 'VIDEOS' || activeMode === 'PHOTO_SLIDES')) {
        return { ok: false, reason: 'Hashtag feed videos require XHR/Playwright' };
    }

    try {
        const res = await gotScraping({
            url,
            ...(proxyUrl ? { proxyUrl } : {}),
            headerGeneratorOptions: {
                browsers: [{ name: 'chrome', minVersion: 120 }],
                operatingSystems: ['windows'],
                locales: ['en-US'],
            },
            headers: {
                ...(cookieHeader ? { cookie: cookieHeader } : {}),
                'accept-language': 'en-US,en;q=0.9',
            },
            timeout: { request: 15_000 },
            retry: { limit: 1 },
        });

        if (res.statusCode < 200 || res.statusCode >= 300 || !res.body) {
            return { ok: false, reason: `HTTP status ${res.statusCode}` };
        }

        const wafReason = detectWafOrCaptchaFromHtml(res.body);
        if (wafReason) {
            return { ok: false, reason: wafReason };
        }

        const scope = extractRehydrationFromHtml(res.body);
        if (!scope) {
            return { ok: false, reason: 'No rehydration JSON in SSR HTML' };
        }

        // 1. Profile SSR
        if (activeMode === 'PROFILES' || (activeMode === 'AUTO_DETECT' && urlType === 'PROFILES')) {
            const userInfo = scope['webapp.user-detail']?.userInfo;
            const profile = mapUserInfoToProfileRecord(userInfo, url, { extractEmailAndPhone });
            if (profile && profile.username) {
                return { ok: true, records: [profile] };
            }
            return { ok: false, reason: 'Profile JSON missing in SSR HTML' };
        }

        // 2. Direct Video / Photo SSR (when no comments requested)
        if ((urlType === 'VIDEOS' || urlType === 'PHOTO_SLIDES') && (activeMode === 'VIDEOS' || activeMode === 'PHOTO_SLIDES' || activeMode === 'AUTO_DETECT')) {
            const itemStruct = scope['webapp.video-detail']?.itemInfo?.itemStruct;
            const record = mapItemStructToVideoRecord(itemStruct, { fallbackUrl: url });
            if (record && (record.id || record.desc)) {
                return { ok: true, records: [record] };
            }
            return { ok: false, reason: 'Video JSON missing in SSR HTML' };
        }

        // 3. Hashtag / Music SSR (only short-circuit if both metadata AND items populated in SSR)
        if (urlType === 'HASHTAGS' && activeMode === 'HASHTAGS') {
            const cd = scope['webapp.challenge-detail'];
            if (cd?.challengeInfo?.challenge && Array.isArray(cd?.itemList) && cd.itemList.length > 0) {
                const challenge = cd.challengeInfo.challenge;
                const stats = cd.challengeInfo.stats || cd.challengeInfo.statsV2 || {};
                const videos = cd.itemList
                    .slice(0, maxItems)
                    .map((it) => mapItemStructToVideoRecord(it))
                    .filter(Boolean);
                const record = sanitizeRecord({
                    type: 'HASHTAG',
                    url,
                    id: toSafeString(challenge.id),
                    hashtagTitle: toSafeString(challenge.title) || 'Hashtag',
                    desc: toSafeString(challenge.desc),
                    totalViews: stats.viewCount !== undefined ? String(stats.viewCount) : undefined,
                    playCount: toSafeInt(stats.viewCount),
                    videoCount: toSafeInt(stats.videoCount),
                    collectedVideosCount: videos.length,
                    videos,
                    scrapedAt: new Date().toISOString(),
                });
                return { ok: true, records: [record] };
            }
        }

        return { ok: false, reason: 'SSR scope lacks target module data' };
    } catch (err) {
        return { ok: false, reason: err.message };
    }
}

// ==================== PLAYWRIGHT XHR CAPTURE & UI HELPERS ====================

/**
 * Creates a clean network capture state container and attaches a JSON response listener to the Playwright Page.
 * Captures TikTok XHR payloads (/api/post/item_list, /api/challenge/, /api/search/, /api/comment/list, etc.).
 * @param {import('playwright').Page} page
 */
export function attachTikTokNetworkCapture(page) {
    const state = {
        userInfos: [],
        itemsById: new Map(),
        challengeInfo: null,
        musicInfo: null,
        liveInfo: null,
        comments: [],
        seenCommentIds: new Set(),
        shopItems: [],
        responsesCaptured: 0,
    };

    if (page.__tikTokCaptureState) {
        return page.__tikTokCaptureState;
    }
    page.__tikTokCaptureState = state;

    page.on('response', async (response) => {
        try {
            const reqUrl = response.url();
            if (!reqUrl.includes('tiktok.com') && !reqUrl.includes('tiktokv.com')) return;
            const isTargetApi =
                reqUrl.includes('/api/') ||
                reqUrl.includes('/webcast/') ||
                reqUrl.includes('/aweme/');
            if (!isTargetApi) return;

            const status = response.status();
            if (status < 200 || status >= 300) return;

            const contentType = response.headers()['content-type'] || '';
            if (!contentType.includes('json') && !contentType.includes('text/plain')) return;

            const text = await response.text().catch(() => '');
            if (!text || text[0] !== '{') return;

            const payload = JSON.parse(text);
            state.responsesCaptured += 1;
            ingestTikTokJsonPayload(payload, reqUrl, state);
        } catch {
            // Non-JSON or aborted response on page teardown
        }
    });

    return state;
}

/**
 * Ingests parsed JSON from any TikTok web XHR API response into normalized capture state.
 * @param {Record<string, any>} payload
 * @param {string} reqUrl
 * @param {object} state
 */
export function ingestTikTokJsonPayload(payload, reqUrl, state) {
    if (!payload || typeof payload !== 'object') return;

    // Profile detail
    if (payload.userInfo?.user) {
        state.userInfos.push(payload.userInfo);
    }

    // Single item detail
    if (payload.itemInfo?.itemStruct) {
        const it = payload.itemInfo.itemStruct;
        const id = toSafeString(it.id ?? it.aweme_id);
        if (id) state.itemsById.set(id, it);
    }

    // Hashtag challenge detail
    if (payload.challengeInfo?.challenge) {
        state.challengeInfo = payload.challengeInfo;
    }

    // Music detail
    if (payload.musicInfo?.music) {
        state.musicInfo = payload.musicInfo;
    }

    // Standard item lists (profile feed, hashtag feed, music feed, recommend feed)
    const lists = [payload.itemList, payload.item_list, payload.aweme_list];
    for (const list of lists) {
        if (Array.isArray(list)) {
            for (const it of list) {
                if (it && typeof it === 'object') {
                    const id = toSafeString(it.id ?? it.aweme_id);
                    if (id && (it.desc !== undefined || it.video || it.imagePost || it.author)) {
                        state.itemsById.set(id, it);
                    }
                }
            }
        }
    }

    // Search API (/api/search/general/full/ returns payload.data[] where entry.item or entry.user_list)
    if (Array.isArray(payload.data)) {
        for (const entry of payload.data) {
            if (!entry || typeof entry !== 'object') continue;
            const candidate = entry.item || entry;
            if (candidate && (candidate.id || candidate.aweme_id) && (candidate.video || candidate.imagePost || candidate.author || candidate.desc !== undefined)) {
                const id = toSafeString(candidate.id ?? candidate.aweme_id);
                if (id) state.itemsById.set(id, candidate);
            }
            if (Array.isArray(entry.user_list)) {
                for (const u of entry.user_list) {
                    if (u?.user_info) state.userInfos.push(u.user_info);
                }
            }
            if (entry.user_info && typeof entry.user_info === 'object') {
                state.userInfos.push(entry.user_info);
            }
        }
    }

    // Search users (/api/search/user/full/)
    if (Array.isArray(payload.user_list)) {
        for (const u of payload.user_list) {
            if (u?.user_info) state.userInfos.push(u.user_info);
            else if (u?.user) state.userInfos.push(u);
        }
    }

    // Comments API (/api/comment/list/)
    if (reqUrl.includes('/comment/') && Array.isArray(payload.comments)) {
        for (const c of payload.comments) {
            const cid = toSafeString(c?.cid ?? c?.id) || `${c?.user?.unique_id || ''}:${c?.text || ''}`;
            if (cid && !state.seenCommentIds.has(cid)) {
                state.seenCommentIds.add(cid);
                state.comments.push(c);
            }
        }
    }

    // Live metadata (/webcast/)
    if (reqUrl.includes('/webcast/') && payload.data) {
        const d = payload.data;
        if (d.title || d.id_str || d.owner || d.user_count !== undefined) {
            state.liveInfo = d;
        }
    }
}

/**
 * Dismisses login modals, app download prompts, and cookie overlays without touching page content.
 * @param {import('playwright').Page} page
 */
export async function dismissTikTokModals(page) {
    try {
        await page.evaluate(() => {
            const modals = document.querySelectorAll(
                'div[class*="DivModalContainer"], div[role="dialog"], div[id*="login-modal"], div[data-e2e="modal-close-inner-button"]'
            );
            modals.forEach((m) => {
                const txt = m.innerText || '';
                if (
                    txt.includes('Log in') ||
                    txt.includes('Sign up') ||
                    txt.includes('Get app') ||
                    txt.includes('Continue as guest')
                ) {
                    const guestBtn = Array.from(m.querySelectorAll('div, button, a')).find((el) =>
                        /Continue as guest/i.test(el.textContent || '')
                    );
                    if (guestBtn && typeof guestBtn.click === 'function') {
                        guestBtn.click();
                    } else {
                        m.remove();
                    }
                }
            });
            if (document.body) document.body.style.overflow = 'auto';
            if (document.documentElement) document.documentElement.style.overflow = 'auto';
        });

        const closeBtn = page
            .locator('[data-e2e="modal-close-inner-button"], div[class*="ButtonClose"], [aria-label="Close"]')
            .first();
        if (await closeBtn.isVisible({ timeout: 500 }).catch(() => false)) {
            await closeBtn.click().catch(() => {});
        }
    } catch {
        // Silently continue
    }
}

/**
 * Waits adaptively up to timeoutMs for either SSR rehydration JSON, XHR payload, key DOM elements, or CAPTCHA.
 * Much faster than fixed sleeps while giving React feeds time to populate after 'domcontentloaded'.
 * @param {import('playwright').Page} page
 * @param {object} captureState
 * @param {number} [timeoutMs=8000]
 */
export async function waitForTikTokReady(page, captureState, timeoutMs = 8_000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        if (captureState && (captureState.itemsById.size > 0 || captureState.userInfos.length > 0 || captureState.challengeInfo || captureState.musicInfo || captureState.liveInfo)) {
            await page.waitForTimeout(450);
            return;
        }

        const state = await page
            .evaluate(() => {
                const captcha = !!(
                    document.querySelector('#captcha-verify-image, #captcha_container, [id*="captcha-verify"], iframe[src*="captcha"]') ||
                    (document.getElementById('slardar-config') && (document.body?.innerText || '').trim().length < 200)
                );
                if (captcha) return 'blocked';

                const uni = document.getElementById('__UNIVERSAL_DATA_FOR_REHYDRATION__');
                if (uni?.textContent) {
                    const txt = uni.textContent;
                    if (
                        txt.includes('webapp.user-detail') ||
                        txt.includes('webapp.video-detail') ||
                        txt.includes('webapp.challenge-detail') ||
                        txt.includes('webapp.music-detail')
                    ) {
                        return 'rehydration';
                    }
                }

                const domReady = !!document.querySelector(
                    '[data-e2e="user-title"], [data-e2e="browse-video-desc"], [data-e2e="video-desc"], [data-e2e="challenge-title"], a[href*="/video/"], a[href*="/photo/"], [data-e2e="search_top-item"]'
                );
                return domReady ? 'dom' : 'waiting';
            })
            .catch(() => 'waiting');

        if (state === 'rehydration' || state === 'dom') {
            await page.waitForTimeout(400);
            return;
        }
        if (state === 'blocked') {
            return;
        }
        await page.waitForTimeout(450);
    }
}

// ==================== IN-PAGE REHYDRATION PARSER ====================

export async function extractRehydrationData(page) {
    return await page.evaluate(() => {
        try {
            const script = document.getElementById('__UNIVERSAL_DATA_FOR_REHYDRATION__');
            if (script && script.textContent) {
                const parsed = JSON.parse(script.textContent);
                return parsed?.__DEFAULT_SCOPE__ || parsed || null;
            }
            const sigi = document.getElementById('SIGI_STATE');
            if (sigi && sigi.textContent) {
                return JSON.parse(sigi.textContent);
            }
        } catch {
            return null;
        }
        return null;
    });
}

// ==================== 1. PROFILE EXTRACTOR ====================

export async function extractTikTokProfile(page, url, { captureState, extractEmailAndPhone = true } = {}) {
    const rawData = await extractRehydrationData(page);
    const rehydrationUser = rawData?.['webapp.user-detail']?.userInfo;
    const sigiUser = rawData?.UserModule?.users && rawData?.UserModule?.stats
        ? (() => {
              const firstKey = Object.keys(rawData.UserModule.users)[0];
              return firstKey
                  ? { user: rawData.UserModule.users[firstKey], stats: rawData.UserModule.stats[firstKey] }
                  : null;
          })()
        : null;
    const xhrUser = captureState?.userInfos?.[0] || null;

    const mappedFromJson =
        mapUserInfoToProfileRecord(rehydrationUser, url, { extractEmailAndPhone }) ||
        mapUserInfoToProfileRecord(sigiUser, url, { extractEmailAndPhone }) ||
        mapUserInfoToProfileRecord(xhrUser, url, { extractEmailAndPhone });

    if (mappedFromJson) {
        return mappedFromJson;
    }

    // Browser DOM Fallback
    const domData = await page.evaluate(() => {
        const username = document.querySelector('[data-e2e="user-title"]')?.innerText?.trim() || '';
        const nickname = document.querySelector('[data-e2e="user-subtitle"]')?.innerText?.trim() || username;
        const bio = document.querySelector('[data-e2e="user-bio"]')?.innerText?.trim() || '';

        const followersText = document.querySelector('[data-e2e="followers-count"]')?.innerText?.trim() || '';
        const followingText = document.querySelector('[data-e2e="following-count"]')?.innerText?.trim() || '';
        const likesText = document.querySelector('[data-e2e="likes-count"]')?.innerText?.trim() || '';

        const isVerified = !!document.querySelector('[data-e2e="user-verified-badge"], svg[class*="Badge"]');
        const avatar = document.querySelector('[data-e2e="user-avatar"] img, img[class*="ImgAvatar"]')?.getAttribute('src') || '';
        const link = document.querySelector('[data-e2e="user-link"] a')?.getAttribute('href') || '';

        return {
            username,
            nickname,
            bio,
            followersText,
            followingText,
            likesText,
            isVerified,
            avatar,
            link,
        };
    });

    const fallbackUsername = domData.username || extractTikTokUsername(url);
    if (!domData.username && !domData.followersText && !domData.bio) {
        return null;
    }

    const leads = extractEmailAndPhone ? extractLeadsFromText(domData.bio) : { email: undefined, phone: undefined };

    return sanitizeRecord({
        type: 'PROFILE',
        url: fallbackUsername ? `https://www.tiktok.com/@${fallbackUsername}` : url,
        username: fallbackUsername || undefined,
        nickname: domData.nickname || fallbackUsername || undefined,
        biography: domData.bio,
        bioLink: toSafeString(domData.link),
        followersCount: toSafeInt(domData.followersText),
        followingCount: toSafeInt(domData.followingText),
        heartCount: toSafeInt(domData.likesText),
        isVerified: Boolean(domData.isVerified),
        email: leads.email,
        phone: leads.phone,
        avatarUrl: toSafeString(domData.avatar),
        scrapedAt: new Date().toISOString(),
    });
}

// ==================== 2. VIDEO & PHOTO SLIDES EXTRACTOR ====================

export async function extractTikTokVideoOrPhoto(page, url, { captureState } = {}) {
    const rawData = await extractRehydrationData(page);
    const rehydrationItem = rawData?.['webapp.video-detail']?.itemInfo?.itemStruct;

    const urlIdMatch = url.match(/\/(?:video|photo)\/(\d+)/);
    const targetId = urlIdMatch ? urlIdMatch[1] : undefined;
    const sigiItem =
        rawData?.ItemModule &&
        (targetId && rawData.ItemModule[targetId]
            ? rawData.ItemModule[targetId]
            : Object.values(rawData.ItemModule)[0]);
    const xhrItem = targetId ? captureState?.itemsById?.get(targetId) : undefined;

    const mapped =
        mapItemStructToVideoRecord(rehydrationItem, { fallbackUrl: url }) ||
        mapItemStructToVideoRecord(sigiItem, { fallbackUrl: url }) ||
        mapItemStructToVideoRecord(xhrItem, { fallbackUrl: url });

    if (mapped) {
        return mapped;
    }

    // Browser DOM Fallback (only accepts pages with genuine video/photo DOM content)
    const domData = await page.evaluate(() => {
        const descElem = document.querySelector('h1[data-e2e="browse-video-desc"], [data-e2e="video-desc"], [data-e2e="new-desc-span"]');
        const desc = descElem ? descElem.innerText.trim() : '';

        const photoImgs = Array.from(document.querySelectorAll('img[class*="ImagePhoto"], div[class*="DivPhotoSlide"] img'))
            .map((img) => img.getAttribute('src'))
            .filter(Boolean);

        const video = document.querySelector('video');
        const videoSrc = video ? video.getAttribute('src') || '' : '';
        const cover = video ? video.getAttribute('poster') || '' : '';

        const likesText = document.querySelector('[data-e2e="like-count"], [data-e2e="browse-like-count"]')?.innerText?.trim() || '';
        const commentsText = document.querySelector('[data-e2e="comment-count"], [data-e2e="browse-comment-count"]')?.innerText?.trim() || '';
        const bookmarksText = document.querySelector('[data-e2e="undefined-count"], [data-e2e="collect-count"]')?.innerText?.trim() || '';
        const sharesText = document.querySelector('[data-e2e="share-count"]')?.innerText?.trim() || '';

        const musicTitle = document.querySelector('[data-e2e="browse-music"], [data-e2e="video-music"]')?.innerText?.trim() || '';
        const author = document.querySelector('[data-e2e="browse-username"], [data-e2e="video-author-uniqueid"]')?.innerText?.trim() || '';

        const hashtags = Array.from(document.querySelectorAll('a[href*="/tag/"] strong, a[href*="/tag/"]'))
            .map((a) => (a.innerText || '').trim().replace(/^#/, ''))
            .filter(Boolean);

        return {
            desc,
            photoImgs,
            videoSrc,
            cover,
            likesText,
            commentsText,
            bookmarksText,
            sharesText,
            musicTitle,
            author,
            hashtags,
        };
    });

    // Reject empty/challenge pages so we don't push hollow stub objects
    if (!domData.desc && !domData.videoSrc && domData.photoImgs.length === 0 && !domData.likesText) {
        return null;
    }

    const isPhotoSlide = domData.photoImgs.length > 0 || url.includes('/photo/');
    return sanitizeRecord({
        type: isPhotoSlide ? 'PHOTO_SLIDES' : 'VIDEO',
        url,
        id: targetId,
        desc: domData.desc,
        isPhotoSlide,
        photoUrls: domData.photoImgs,
        videoUrl: toSafeString(domData.videoSrc),
        coverUrl: toSafeString(domData.cover),
        authorUsername: toSafeString(domData.author) || (extractTikTokUsername(url) || undefined),
        diggCount: toSafeInt(domData.likesText),
        commentCount: toSafeInt(domData.commentsText),
        collectCount: toSafeInt(domData.bookmarksText),
        shareCount: toSafeInt(domData.sharesText),
        musicTitle: toSafeString(domData.musicTitle),
        hashtags: Array.from(new Set(domData.hashtags)),
        scrapedAt: new Date().toISOString(),
    });
}

// ==================== 3. COMMENTS EXTRACTOR ====================

export async function extractTikTokComments(page, maxComments = 20, { captureState } = {}) {
    if (maxComments <= 0) return [];

    // Prefer captured XHR API comments (/api/comment/list/) when present
    if (captureState?.comments?.length > 0) {
        return mapApiComments(captureState.comments, maxComments);
    }

    const domComments = await page.evaluate((max) => {
        const commentRows = Array.from(
            document.querySelectorAll('div[class*="DivCommentItemContainer"], div[class*="DivCommentContentWrapper"], [data-e2e="comment-item"]')
        ).slice(0, max);

        return commentRows
            .map((row, idx) => {
                const author = row.querySelector('[data-e2e="comment-username"], a[href*="/@"]')?.innerText?.trim() || 'User';
                const text = row.querySelector('[data-e2e="comment-level-1"], [data-e2e="comment-level-2"], p')?.innerText?.trim() || '';
                const likes = row.querySelector('[data-e2e="comment-like-count"]')?.innerText?.trim() || '0';
                const time = row.querySelector('[data-e2e="comment-time"], time')?.innerText?.trim() || '';

                return {
                    commentIndex: idx + 1,
                    author,
                    text,
                    likes,
                    time,
                };
            })
            .filter((c) => c.text.length > 0);
    }, maxComments);

    return domComments.map((c) =>
        sanitizeRecord({
            ...c,
            likesCount: toSafeInt(c.likes) ?? 0,
        })
    );
}

// ==================== 4. FEED COLLECTION (PROFILE / HASHTAG / SEARCH / MUSIC) ====================

/**
 * Scrolls a TikTok feed page up to maxScrolls rounds, collecting captured XHR items & DOM video links
 * until maxItems is reached or no new items appear.
 * @param {import('playwright').Page} page
 * @param {object} captureState
 * @param {number} maxItems
 * @param {{ onlyPhotoSlides?: boolean }} [options]
 * @returns {Promise<{ records: Array<object>, videoLinks: Array<{ videoUrl: string, coverUrl?: string, desc?: string, playCount?: number }> }>}
 */
export async function collectFeedVideos(page, captureState, maxItems = 20, { onlyPhotoSlides = false } = {}) {
    // Also ingest any rehydration itemList / ItemModule present in DOM script
    const rawData = await extractRehydrationData(page);
    if (rawData) {
        ingestTikTokJsonPayload(rawData, 'rehydration://scope', captureState);
        for (const scopeVal of Object.values(rawData)) {
            if (scopeVal && typeof scopeVal === 'object') {
                ingestTikTokJsonPayload(scopeVal, 'rehydration://module', captureState);
            }
        }
        if (rawData.ItemModule && typeof rawData.ItemModule === 'object') {
            for (const it of Object.values(rawData.ItemModule)) {
                const id = toSafeString(it?.id);
                if (id) captureState.itemsById.set(id, it);
            }
        }
    }

    let previousCount = 0;
    let stagnantRounds = 0;
    const maxScrolls = Math.min(Math.max(Math.ceil(maxItems / 8), 1), 6);

    for (let round = 0; round < maxScrolls; round++) {
        const currentLinks = await page
            .evaluate(() => document.querySelectorAll('a[href*="/video/"], a[href*="/photo/"]').length)
            .catch(() => 0);
        const totalDiscovered = Math.max(captureState.itemsById.size, currentLinks);

        if (totalDiscovered >= maxItems) break;

        if (totalDiscovered === previousCount && round > 0) {
            stagnantRounds += 1;
            if (stagnantRounds >= 2) break;
        } else {
            stagnantRounds = 0;
        }
        previousCount = totalDiscovered;

        await page.evaluate(() => window.scrollBy(0, 1400)).catch(() => {});
        await page.waitForTimeout(1200);
    }

    // Build rich records from XHR / Rehydration items first
    const allMapped = Array.from(captureState.itemsById.values())
        .map((it) => mapItemStructToVideoRecord(it))
        .filter(Boolean);

    const filteredMapped = onlyPhotoSlides ? allMapped.filter((r) => r.isPhotoSlide) : allMapped;

    // Extract DOM video/photo links as backup or for metadata when XHR didn't return items
    const domLinksRaw = await page
        .evaluate(() => {
            const anchors = Array.from(document.querySelectorAll('a[href*="/video/"], a[href*="/photo/"]'));
            const seen = new Set();
            const list = [];
            for (const a of anchors) {
                const href = a.href;
                if (!href || seen.has(href)) continue;
                seen.add(href);
                const img = a.querySelector('img');
                const card = a.closest('div[data-e2e*="item"], div[class*="DivItemContainer"]') || a;
                const viewsTxt = card?.querySelector('[data-e2e="video-views"], strong')?.innerText?.trim() || '';
                const descTxt = img?.getAttribute('alt')?.trim() || '';
                list.push({
                    videoUrl: href,
                    coverUrl: img?.getAttribute('src') || '',
                    desc: descTxt,
                    viewsTxt,
                });
            }
            return list;
        })
        .catch(() => []);

    const videoLinks = domLinksRaw
        .filter((l) => !onlyPhotoSlides || l.videoUrl.includes('/photo/'))
        .slice(0, maxItems)
        .map((l) =>
            sanitizeRecord({
                videoUrl: l.videoUrl,
                coverUrl: toSafeString(l.coverUrl),
                desc: toSafeString(l.desc),
                playCount: toSafeInt(l.viewsTxt),
            })
        );

    return {
        records: filteredMapped.slice(0, maxItems),
        videoLinks,
    };
}

// ==================== 5. HASHTAGS & CHALLENGES ====================

export async function extractTikTokHashtag(page, url, maxItems = 20, { captureState } = {}) {
    const rawData = await extractRehydrationData(page);
    const challengeInfo =
        rawData?.['webapp.challenge-detail']?.challengeInfo || captureState?.challengeInfo || null;

    const { records, videoLinks } = await collectFeedVideos(page, captureState, maxItems);

    const domMeta = await page.evaluate(() => {
        const title = document.querySelector('h1[data-e2e="challenge-title"], [data-e2e="challenge-title"]')?.innerText?.trim() || '';
        const views = document.querySelector('[data-e2e="challenge-vvcount"]')?.innerText?.trim() || '';
        const desc = document.querySelector('[data-e2e="challenge-desc"]')?.innerText?.trim() || '';
        return { title, views, desc };
    });

    const ch = challengeInfo?.challenge || {};
    const stats = challengeInfo?.stats || challengeInfo?.statsV2 || {};
    const tagFromUrl = decodeURIComponentSafe((url.match(/\/tag\/([^/?#]+)/i)?.[1] || ''));

    const videos =
        records.length > 0
            ? records.map((r, i) =>
                  sanitizeRecord({
                      index: i + 1,
                      id: r.id,
                      videoUrl: r.url,
                      playUrl: r.videoUrl,
                      coverUrl: r.coverUrl,
                      desc: r.desc,
                      authorUsername: r.authorUsername,
                      playCount: r.playCount,
                      diggCount: r.diggCount,
                  })
              )
            : videoLinks.map((v, i) => sanitizeRecord({ index: i + 1, ...v }));

    if (!ch.title && !domMeta.title && videos.length === 0) {
        return null;
    }

    const viewCountNum = toSafeInt(stats.viewCount ?? domMeta.views);

    return sanitizeRecord({
        type: 'HASHTAG',
        url,
        id: toSafeString(ch.id),
        hashtagTitle: toSafeString(ch.title) || toSafeString(domMeta.title) || tagFromUrl || 'Hashtag',
        desc: toSafeString(ch.desc) || toSafeString(domMeta.desc),
        totalViews: toSafeString(domMeta.views) || (stats.viewCount !== undefined ? String(stats.viewCount) : undefined),
        playCount: viewCountNum,
        videoCount: toSafeInt(stats.videoCount),
        collectedVideosCount: videos.length,
        videos,
        scrapedAt: new Date().toISOString(),
    });
}

// ==================== 6. MUSIC / SOUNDS EXTRACTOR ====================

export async function extractTikTokMusic(page, url, maxItems = 20, { captureState } = {}) {
    const rawData = await extractRehydrationData(page);
    const musicInfo = rawData?.['webapp.music-detail']?.musicInfo || captureState?.musicInfo || null;
    const { records, videoLinks } = await collectFeedVideos(page, captureState, maxItems);

    const domMeta = await page.evaluate(() => {
        const musicTitle = document.querySelector('h1[data-e2e="music-title"], [data-e2e="music-title"]')?.innerText?.trim() || '';
        const musicAuthor = document.querySelector('[data-e2e="music-creator"], h2[data-e2e="music-author"]')?.innerText?.trim() || '';
        const videoCountText = document.querySelector('[data-e2e="music-video-count"]')?.innerText?.trim() || '';
        return { musicTitle, musicAuthor, videoCountText };
    });

    const m = musicInfo?.music || {};
    const stats = musicInfo?.stats || {};
    const videos =
        records.length > 0
            ? records.map((r, i) =>
                  sanitizeRecord({
                      index: i + 1,
                      id: r.id,
                      videoUrl: r.url,
                      coverUrl: r.coverUrl,
                      desc: r.desc,
                      authorUsername: r.authorUsername,
                      playCount: r.playCount,
                  })
              )
            : videoLinks.map((v, i) => sanitizeRecord({ index: i + 1, ...v }));

    if (!m.title && !domMeta.musicTitle && videos.length === 0) {
        return null;
    }

    return sanitizeRecord({
        type: 'MUSIC_SOUND',
        url,
        musicId: toSafeString(m.id ?? m.id_str ?? url.match(/-(\d+)(?:[/?#]|$)/)?.[1]),
        musicTitle: toSafeString(m.title) || toSafeString(domMeta.musicTitle) || 'Sound',
        musicAuthor: toSafeString(m.authorName) || toSafeString(domMeta.musicAuthor),
        durationSec: toSafeInt(m.duration),
        videoCount: toSafeInt(stats.videoCount ?? domMeta.videoCountText),
        collectedVideosCount: videos.length,
        videos,
        scrapedAt: new Date().toISOString(),
    });
}

// ==================== 7. LIVE METADATA EXTRACTOR ====================

export async function extractTikTokLive(page, url, { captureState } = {}) {
    const rawData = await extractRehydrationData(page);
    const liveRoom =
        rawData?.['webapp.live-detail']?.liveRoom ||
        rawData?.LiveRoom?.liveRoomUserInfo ||
        captureState?.liveInfo ||
        null;

    const domMeta = await page.evaluate(() => {
        const title = document.querySelector('[data-e2e="live-title"], h1')?.innerText?.trim() || '';
        const username = document.querySelector('[data-e2e="live-anchor-name"], [data-e2e="user-title"]')?.innerText?.trim() || '';
        const viewers = document.querySelector('[data-e2e="live-audience-count"]')?.innerText?.trim() || '';
        return { title, username, viewers };
    });

    const user = liveRoom?.user || liveRoom?.owner || {};
    const room = liveRoom?.liveRoom || liveRoom || {};
    const username = toSafeString(user.uniqueId ?? user.display_id ?? domMeta.username) || (extractTikTokUsername(url) || undefined);
    const title = toSafeString(room.title ?? domMeta.title);
    const liveRoomId = toSafeString(room.roomId ?? room.id_str ?? user.roomId);

    if (!title && !liveRoomId && !username) {
        return null;
    }

    return sanitizeRecord({
        type: 'LIVE_METADATA',
        url,
        liveRoomId,
        username,
        nickname: toSafeString(user.nickname),
        title,
        viewerCount: toSafeInt(room.liveRoomStats?.userCount ?? room.user_count ?? domMeta.viewers),
        status: room.status === 2 || domMeta.viewers ? 'LIVE' : 'ENDED_OR_OFFLINE',
        scrapedAt: new Date().toISOString(),
    });
}
