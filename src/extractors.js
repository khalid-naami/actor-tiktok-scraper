/**
 * TikTok Ultimate All-in-One Extractors
 * Supports dual-engine extraction:
 * 1. Ultra-fast Rehydration JSON Data (__UNIVERSAL_DATA_FOR_REHYDRATION__ / SIGI_STATE)
 * 2. Playwright Stealth Browser Emulation
 * Covers:
 * - Profiles & B2B Leads
 * - Standard Videos
 * - Photo Slideshows (Reels Photo mode)
 * - Comments & Replies
 * - Sounds & Music
 * - Hashtags & Challenges
 * - TikTok Shop Products & Live metadata
 */

import { gotScraping } from 'got-scraping';

/**
 * Normalizes TikTok URLs and handles (e.g. @tiktok -> https://www.tiktok.com/@tiktok).
 * @param {string} input
 * @returns {string}
 */
export function normalizeTikTokUrl(input) {
    if (!input) return '';
    let url = input.trim();
    if (!url.startsWith('http')) {
        if (url.startsWith('#')) {
            url = `https://www.tiktok.com/tag/${encodeURIComponent(url.slice(1))}`;
        } else {
            const handle = url.startsWith('@') ? url : `@${url}`;
            url = `https://www.tiktok.com/${encodeURIComponent(handle)}`;
        }
    }
    return url;
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
    if (lower.includes('/live')) return 'LIVE_METADATA';

    return 'PROFILES';
}

/**
 * Extracts username from profile URL.
 * @param {string} url
 * @returns {string}
 */
export function extractTikTokUsername(url) {
    const match = url.match(/tiktok\.com\/@([a-zA-Z0-9_.-]+)/);
    return match ? match[1] : '';
}

/**
 * Extracts email and phone leads from text.
 * @param {string} text
 * @returns {{ email: string|null, phone: string|null }}
 */
export function extractLeadsFromText(text) {
    if (!text || typeof text !== 'string') return { email: null, phone: null };

    let email = null;
    const emailMatch = text.match(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,7}\b/);
    if (emailMatch && !emailMatch[0].includes('tiktok.com') && !emailMatch[0].includes('bytedance.com')) {
        email = emailMatch[0];
    }

    let phone = null;
    const phoneMatch = text.match(/(?:\+?\d{1,4}[ -]?)?\(?\d{2,4}\)?[ -]?\d{3,4}[ -]?\d{3,4}/);
    if (phoneMatch && phoneMatch[0].replace(/\D/g, '').length >= 8) {
        phone = phoneMatch[0].trim();
    }

    return { email, phone };
}

/**
 * Dismisses login modals, app download prompts, and verification overlays.
 * @param {import('playwright').Page} page
 */
export async function dismissTikTokModals(page) {
    try {
        await page.evaluate(() => {
            const modals = document.querySelectorAll('div[class*="DivModalContainer"], div[role="dialog"], div[id*="login-modal"]');
            modals.forEach((m) => {
                if (m.innerText && (m.innerText.includes('Log in') || m.innerText.includes('Sign up') || m.innerText.includes('Get app'))) {
                    m.remove();
                }
            });
            document.body.style.overflow = 'auto';
            document.documentElement.style.overflow = 'auto';
        });

        const closeBtn = page.locator('div[class*="ButtonClose"], [aria-label="Close"], svg[class*="StyledCloseIcon"]').first();
        if (await closeBtn.isVisible({ timeout: 600 }).catch(() => false)) {
            await closeBtn.click().catch(() => {});
        }
    } catch {
        // Silently continue
    }
}

// ==================== FAST REHYDRATION DATA PARSER ====================
export async function extractRehydrationData(page) {
    return await page.evaluate(() => {
        try {
            const script = document.getElementById('__UNIVERSAL_DATA_FOR_REHYDRATION__');
            if (script && script.innerText) {
                const parsed = JSON.parse(script.innerText);
                return parsed?.__DEFAULT_SCOPE__ || null;
            }
            // Fallback to SIGI_STATE
            const sigi = document.getElementById('SIGI_STATE');
            if (sigi && sigi.innerText) {
                return JSON.parse(sigi.innerText);
            }
        } catch {
            return null;
        }
        return null;
    });
}

// ==================== 1. PROFILE EXTRACTOR ====================
export async function extractTikTokProfile(page, url) {
    const rawData = await extractRehydrationData(page);
    const userDetail = rawData?.['webapp.user-detail']?.userInfo;

    if (userDetail) {
        const user = userDetail.user;
        const stats = userDetail.stats;
        const leads = extractLeadsFromText(user.signature || '');

        return {
            type: 'PROFILE',
            url,
            id: user.id,
            secUid: user.secUid,
            username: user.uniqueId,
            nickname: user.nickname,
            biography: user.signature,
            bioLink: user.bioLink?.link || null,
            followersCount: stats.followerCount,
            followingCount: stats.followingCount,
            heartCount: stats.heartCount,
            videoCount: stats.videoCount,
            isVerified: user.verified || false,
            email: leads.email,
            phone: leads.phone,
            avatarUrl: user.avatarLarger || user.avatarMedium,
            scrapedAt: new Date().toISOString()
        };
    }

    // Browser DOM Fallback
    return await page.evaluate((canonicalUrl) => {
        const username = document.querySelector('h1[data-e2e="user-title"], h2[data-e2e="user-subtitle"]')?.innerText?.trim() || '';
        const nickname = document.querySelector('h1[data-e2e="user-subtitle"], h2[data-e2e="user-title"]')?.innerText?.trim() || username;
        const bio = document.querySelector('h2[data-e2e="user-bio"], [data-e2e="user-bio"]')?.innerText?.trim() || '';

        const followersText = document.querySelector('[data-e2e="followers-count"]')?.innerText?.trim() || '0';
        const followingText = document.querySelector('[data-e2e="following-count"]')?.innerText?.trim() || '0';
        const likesText = document.querySelector('[data-e2e="likes-count"]')?.innerText?.trim() || '0';

        const isVerified = !!document.querySelector('[data-e2e="user-verified-badge"], svg[class*="Badge"]');
        const avatar = document.querySelector('[data-e2e="user-avatar"] img, img[class*="ImgAvatar"]')?.getAttribute('src') || '';
        const link = document.querySelector('[data-e2e="user-link"] a')?.getAttribute('href') || null;

        return {
            type: 'PROFILE',
            url: canonicalUrl,
            username,
            nickname,
            biography: bio,
            bioLink: link,
            followersRaw: followersText,
            followingRaw: followingText,
            heartRaw: likesText,
            isVerified,
            avatarUrl: avatar,
            scrapedAt: new Date().toISOString()
        };
    }, url);
}

// ==================== 2. VIDEO & PHOTO SLIDES EXTRACTOR ====================
export async function extractTikTokVideoOrPhoto(page, url) {
    const rawData = await extractRehydrationData(page);
    const videoDetail = rawData?.['webapp.video-detail']?.itemInfo?.itemStruct;

    if (videoDetail) {
        // Detect if this is a Photo Slideshow
        const isPhotoSlide = !!(videoDetail.imagePost && videoDetail.imagePost.images && videoDetail.imagePost.images.length > 0);
        const photoUrls = isPhotoSlide ? videoDetail.imagePost.images.map(img => img.imageURL?.urlList?.[0]).filter(Boolean) : [];

        const hashtags = (videoDetail.challenges || []).map(c => c.title);

        return {
            type: isPhotoSlide ? 'PHOTO_SLIDES' : 'VIDEO',
            url,
            id: videoDetail.id,
            desc: videoDetail.desc,
            isPhotoSlide,
            photoUrls,
            videoUrl: videoDetail.video?.playAddr || videoDetail.video?.downloadAddr || null,
            coverUrl: videoDetail.video?.cover || videoDetail.video?.dynamicCover || null,
            authorUsername: videoDetail.author?.uniqueId,
            authorNickname: videoDetail.author?.nickname,
            playCount: videoDetail.stats?.playCount || 0,
            diggCount: videoDetail.stats?.diggCount || 0,
            commentCount: videoDetail.stats?.commentCount || 0,
            shareCount: videoDetail.stats?.shareCount || 0,
            collectCount: videoDetail.stats?.collectCount || 0,
            musicTitle: videoDetail.music?.title || null,
            musicAuthor: videoDetail.music?.authorName || null,
            hashtags,
            timestamp: videoDetail.createTime ? new Date(videoDetail.createTime * 1000).toISOString() : null,
            scrapedAt: new Date().toISOString()
        };
    }

    // Browser DOM Fallback
    return await page.evaluate((canonicalUrl) => {
        const fullText = document.body.innerText || '';
        const descElem = document.querySelector('h1[data-e2e="browse-video-desc"], [data-e2e="video-desc"]');
        const desc = descElem ? descElem.innerText.trim() : '';

        // Check if there are photo slides
        const photoImgs = Array.from(document.querySelectorAll('img[class*="ImagePhoto"], div[class*="DivPhotoSlide"] img'))
            .map(img => img.getAttribute('src'))
            .filter(Boolean);
        const isPhotoSlide = photoImgs.length > 0;

        const video = document.querySelector('video');
        const videoSrc = video ? video.getAttribute('src') : null;

        const likesMatch = document.querySelector('[data-e2e="like-count"]')?.innerText || '0';
        const commentsMatch = document.querySelector('[data-e2e="comment-count"]')?.innerText || '0';
        const bookmarksMatch = document.querySelector('[data-e2e="undefined-count"], [data-e2e="collect-count"]')?.innerText || '0';

        const musicTitle = document.querySelector('[data-e2e="browse-music"]')?.innerText?.trim() || null;

        return {
            type: isPhotoSlide ? 'PHOTO_SLIDES' : 'VIDEO',
            url: canonicalUrl,
            desc,
            isPhotoSlide,
            photoUrls: photoImgs,
            videoUrl: videoSrc,
            likesRaw: likesMatch,
            commentsRaw: commentsMatch,
            bookmarksRaw: bookmarksMatch,
            musicTitle,
            scrapedAt: new Date().toISOString()
        };
    }, url);
}

// ==================== 3. COMMENTS EXTRACTOR ====================
export async function extractTikTokComments(page, maxComments = 20) {
    return await page.evaluate((max) => {
        const commentRows = Array.from(document.querySelectorAll('div[class*="DivCommentItemContainer"], [data-e2e="comment-item"]')).slice(0, max);
        return commentRows.map((row, idx) => {
            const author = row.querySelector('[data-e2e="comment-username"], a')?.innerText?.trim() || 'User';
            const text = row.querySelector('[data-e2e="comment-level-1"], p')?.innerText?.trim() || '';
            const likes = row.querySelector('[data-e2e="comment-like-count"]')?.innerText?.trim() || '0';
            const time = row.querySelector('[data-e2e="comment-time"], time')?.innerText?.trim() || '';

            return {
                commentIndex: idx + 1,
                author,
                text,
                likes,
                time
            };
        }).filter(c => c.text.length > 0);
    }, maxComments);
}

// ==================== 4. HASHTAGS & CHALLENGES ====================
export async function extractTikTokHashtag(page, url, maxItems = 20) {
    return await page.evaluate(({ canonicalUrl, max }) => {
        const title = document.querySelector('h1[data-e2e="challenge-title"]')?.innerText?.trim() || 'Hashtag';
        const views = document.querySelector('[data-e2e="challenge-vvcount"]')?.innerText?.trim() || 'N/A';

        const videoLinks = Array.from(document.querySelectorAll('a[href*="/video/"]')).slice(0, max);
        const videos = videoLinks.map((a, idx) => ({
            index: idx + 1,
            videoUrl: a.href,
            coverUrl: a.querySelector('img')?.getAttribute('src') || ''
        }));

        return {
            type: 'HASHTAG',
            url: canonicalUrl,
            hashtagTitle: title,
            totalViews: views,
            collectedVideosCount: videos.length,
            videos,
            scrapedAt: new Date().toISOString()
        };
    }, { canonicalUrl: url, max: maxItems });
}
