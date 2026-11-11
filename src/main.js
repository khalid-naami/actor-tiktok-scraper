/**
 * Apify Actor: TikTok Ultimate All-in-One Scraper (Enterprise Edition)
 * Technology: JavaScript (ES Modules), Crawlee, Playwright + got-scraping SSR pre-flight
 * Supports Profiles & Leads, Videos (single & feed extraction), Photo Slideshows,
 * Comments, Music/Sounds, Hashtags, Keyword Search, TikTok Shop, and Live Metadata.
 */

import { Actor } from 'apify';
import { PlaywrightCrawler, log } from 'crawlee';
import {
    attachTikTokNetworkCapture,
    buildSearchUrl,
    collectFeedVideos,
    detectTikTokUrlType,
    detectWafOrCaptchaOnPage,
    dismissTikTokModals,
    extractTikTokComments,
    extractTikTokHashtag,
    extractTikTokLive,
    extractTikTokMusic,
    extractTikTokProfile,
    extractTikTokVideoOrPhoto,
    isTikTokFeedUrl,
    mapUserInfoToProfileRecord,
    normalizeTikTokUrl,
    parseCustomCookies,
    sanitizeRecord,
    tryFastSsrExtract,
    waitForTikTokReady,
} from './extractors.js';

await Actor.init();

let failureExitMessage = null;

try {
    const input = (await Actor.getInput()) || {};
    const {
        scrapeMode = 'AUTO_DETECT',
        targetUrls = [],
        searchKeywords = [],
        maxItems: rawMaxItems = 20,
        maxCommentsPerVideo: rawMaxComments = 15,
        extractEmailAndPhone = true,
        proxyConfiguration: proxyInput,
        customCookies = '',
    } = input;

    const maxItems = Math.min(Math.max(Number.parseInt(rawMaxItems, 10) || 20, 1), 500);
    const maxCommentsPerVideo = Math.min(Math.max(Number.parseInt(rawMaxComments, 10) || 0, 0), 100);

    // Build normalized request queue seeds
    const initialRequests = [];
    const seenSeedUrls = new Set();

    const addSeed = (url, userData = {}) => {
        if (!url || seenSeedUrls.has(url)) return;
        seenSeedUrls.add(url);
        initialRequests.push({
            url,
            userData: {
                mode: scrapeMode,
                isRoot: true,
                ...userData,
            },
        });
    };

    for (const item of Array.isArray(targetUrls) ? targetUrls : []) {
        const rawUrl = typeof item === 'string' ? item : item?.url;
        const normalized = normalizeTikTokUrl(rawUrl);
        if (normalized) addSeed(normalized);
    }

    for (const kw of Array.isArray(searchKeywords) ? searchKeywords : []) {
        if (kw && typeof kw === 'string' && kw.trim()) {
            const searchUrl = buildSearchUrl(kw, scrapeMode);
            if (searchUrl) addSeed(searchUrl, { keyword: kw.trim() });
        }
    }

    if (initialRequests.length === 0) {
        addSeed('https://www.tiktok.com/@tiktok');
    }

    log.info(`🚀 Starting TikTok Ultimate Scraper | Mode: ${scrapeMode} | Targets: ${initialRequests.length} | MaxItems: ${maxItems}`);

    // Configure proxy with graceful fallback when RESIDENTIAL is unavailable on the account
    let proxyConfiguration;
    try {
        if (proxyInput && (proxyInput.useApifyProxy || proxyInput.proxyUrls?.length)) {
            proxyConfiguration = await Actor.createProxyConfiguration(proxyInput);
        } else if (!proxyInput) {
            proxyConfiguration = await Actor.createProxyConfiguration({ groups: ['RESIDENTIAL'] }).catch(async () => {
                log.warning('Residential proxy group unavailable; falling back to default Apify Proxy.');
                return await Actor.createProxyConfiguration().catch(() => undefined);
            });
        }
    } catch (proxyErr) {
        log.warning(`Requested proxy configuration failed (${proxyErr.message}); falling back to default proxy/direct.`);
        proxyConfiguration = await Actor.createProxyConfiguration().catch(() => undefined);
    }

    const { playwrightCookies, cookieHeader } = parseCustomCookies(customCookies);
    const scrapedRecords = [];
    const failedRequests = [];

    const pushCleanRecord = async (rawRecord) => {
        const clean = sanitizeRecord(rawRecord);
        if (!clean || Object.keys(clean).length === 0) return false;
        try {
            await Actor.pushData(clean);
            scrapedRecords.push(clean);
            return true;
        } catch (pushErr) {
            if (pushErr?.data?.invalidItems) {
                log.error(`Dataset schema validation error: ${JSON.stringify(pushErr.data.invalidItems)}`);
            }
            throw pushErr;
        }
    };

    // ==================== PHASE 1: FAST SSR PRE-FLIGHT ====================
    const browserQueueRequests = [];

    for (const req of initialRequests) {
        const urlType = detectTikTokUrlType(req.url);
        const effectiveMode = scrapeMode === 'AUTO_DETECT' ? urlType : scrapeMode;
        const proxyUrl = proxyConfiguration ? await proxyConfiguration.newUrl().catch(() => undefined) : undefined;

        const fastResult = await tryFastSsrExtract(req.url, effectiveMode, {
            proxyUrl,
            cookieHeader,
            maxCommentsPerVideo,
            extractEmailAndPhone,
            maxItems,
        });

        if (fastResult.ok && Array.isArray(fastResult.records) && fastResult.records.length > 0) {
            for (const rec of fastResult.records) {
                await pushCleanRecord(rec);
                log.info(`⚡ SSR Fast-Extracted [${rec.type}] from: ${req.url}`);
            }
        } else {
            log.debug(`Browser queue -> ${req.url} (${fastResult.reason || 'Playwright required'})`);
            browserQueueRequests.push(req);
        }
    }

    // ==================== PHASE 2: PLAYWRIGHT CRAWLER ====================
    if (browserQueueRequests.length > 0) {
        const crawler = new PlaywrightCrawler({
            proxyConfiguration,
            maxRequestRetries: 2,
            minConcurrency: 1,
            maxConcurrency: 2,
            requestHandlerTimeoutSecs: 120,
            navigationTimeoutSecs: 60,
            headless: true,

            launchContext: {
                launchOptions: {
                    args: [
                        '--no-sandbox',
                        '--disable-setuid-sandbox',
                        '--disable-dev-shm-usage',
                        '--disable-blink-features=AutomationControlled',
                        '--disable-infobars',
                        '--window-size=1280,850',
                    ],
                },
            },

            preNavigationHooks: [
                async ({ page, gotoOptions }) => {
                    // Do not wait for streaming media / analytics ('load'); SSR + React start at 'domcontentloaded'
                    gotoOptions.waitUntil = 'domcontentloaded';

                    // Apply custom session cookies onto the actual Playwright BrowserContext
                    if (playwrightCookies.length > 0) {
                        try {
                            await page.context().addCookies(playwrightCookies);
                        } catch (cookieErr) {
                            log.warning(`Failed to apply custom cookies: ${cookieErr.message}`);
                        }
                    }

                    // Attach live XHR JSON interceptor before navigation
                    attachTikTokNetworkCapture(page);

                    // Abort video/audio streams, fonts, and heavy telemetry trackers cleanly without regex blind spots
                    if (!page.__tikTokRouteInstalled) {
                        page.__tikTokRouteInstalled = true;
                        await page.route('**/*', (route) => {
                            const req = route.request();
                            if (req.isNavigationRequest()) {
                                return route.continue().catch(() => {});
                            }
                            const type = req.resourceType();
                            const reqUrl = req.url();
                            if (
                                type === 'media' ||
                                type === 'font' ||
                                /\.(?:mp4|webm|avi|m4s|mp3|aac|woff2?)(?:$|\?)/i.test(reqUrl) ||
                                reqUrl.includes('mime_type=video') ||
                                reqUrl.includes('mon.tiktokv.com') ||
                                reqUrl.includes('analytics.tiktok.com') ||
                                reqUrl.includes('googletagmanager.com') ||
                                reqUrl.includes('google-analytics.com')
                            ) {
                                return route.abort().catch(() => {});
                            }
                            return route.continue().catch(() => {});
                        });
                    }
                },
            ],

            async requestHandler({ page, request, addRequests }) {
                const url = request.url;
                const urlType = detectTikTokUrlType(url);
                const requestedMode = request.userData?.mode || scrapeMode;
                const activeMode = requestedMode === 'AUTO_DETECT' ? urlType : requestedMode;
                const keyword = request.userData?.keyword;

                log.info(`🔎 Scraping TikTok [${activeMode}]: ${url}`);

                const captureState = attachTikTokNetworkCapture(page);
                await waitForTikTokReady(page, captureState, 9_000);
                await dismissTikTokModals(page);

                const pushVideoDetailOrComments = async (targetUrl, mode) => {
                    const videoOrPhoto = await extractTikTokVideoOrPhoto(page, targetUrl, { captureState });
                    if (!videoOrPhoto) return 0;

                    let comments = [];
                    if (maxCommentsPerVideo > 0) {
                        await page.mouse.wheel(0, 750).catch(() => {});
                        await page.waitForTimeout(1200);
                        comments = await extractTikTokComments(page, maxCommentsPerVideo, { captureState });
                    }

                    const combined = sanitizeRecord({
                        ...videoOrPhoto,
                        ...(keyword ? { keyword } : {}),
                        commentsCount: comments.length,
                        comments,
                    });

                    await pushCleanRecord(combined);
                    log.info(`✅ Successfully scraped [${combined.type}] from: ${targetUrl}`);
                    return 1;
                };

                let pushedCount = 0;
                let enqueuedChildCount = 0;

                switch (activeMode) {
                    case 'PROFILES': {
                        if (urlType === 'KEYWORD_SEARCH') {
                            await collectFeedVideos(page, captureState, maxItems);
                            for (const ui of captureState.userInfos.slice(0, maxItems)) {
                                const prof = mapUserInfoToProfileRecord(ui, url, { extractEmailAndPhone });
                                if (prof) {
                                    await pushCleanRecord({ ...prof, ...(keyword ? { keyword } : {}) });
                                    pushedCount += 1;
                                }
                            }
                        } else {
                            const profile = await extractTikTokProfile(page, url, { captureState, extractEmailAndPhone });
                            if (profile) {
                                await pushCleanRecord(profile);
                                pushedCount += 1;
                                log.info(`✅ Successfully scraped [PROFILE] from: ${url}`);
                            }
                        }
                        break;
                    }

                    case 'VIDEOS':
                    case 'PHOTO_SLIDES': {
                        if (!isTikTokFeedUrl(url) || urlType === 'VIDEOS' || urlType === 'PHOTO_SLIDES') {
                            pushedCount += await pushVideoDetailOrComments(url, activeMode);
                        } else {
                            // User passed a profile/hashtag/search/music feed in VIDEOS / PHOTO_SLIDES mode -> extract items from feed
                            const { records, videoLinks } = await collectFeedVideos(page, captureState, maxItems, {
                                onlyPhotoSlides: activeMode === 'PHOTO_SLIDES',
                            });

                            if (records.length > 0) {
                                for (const rec of records.slice(0, maxItems)) {
                                    await pushCleanRecord({ ...rec, ...(keyword ? { keyword } : {}) });
                                    pushedCount += 1;
                                }
                                log.info(`✅ Extracted ${pushedCount} [${activeMode}] item(s) from feed: ${url}`);
                            } else if (videoLinks.length > 0) {
                                const childUrls = videoLinks
                                    .map((v) => v.videoUrl)
                                    .filter(Boolean)
                                    .slice(0, maxItems)
                                    .map((childUrl) => ({
                                        url: childUrl,
                                        userData: { mode: activeMode, isRoot: false, keyword },
                                    }));
                                if (childUrls.length > 0) {
                                    await addRequests(childUrls);
                                    enqueuedChildCount = childUrls.length;
                                    log.info(`🔗 Enqueued ${enqueuedChildCount} discovered video/photo URLs from: ${url}`);
                                }
                            } else if (activeMode === 'PHOTO_SLIDES' && captureState.itemsById.size > 0) {
                                log.warning(`Feed ${url} loaded ${captureState.itemsById.size} item(s), but 0 matched PHOTO_SLIDES.`);
                                request.noRetry = true;
                            }
                        }
                        break;
                    }

                    case 'COMMENTS': {
                        if (isTikTokFeedUrl(url) && !request.userData?.isChild) {
                            const { videoLinks, records } = await collectFeedVideos(page, captureState, maxItems);
                            const childUrls = (records.length > 0 ? records.map((r) => r.url) : videoLinks.map((v) => v.videoUrl))
                                .filter(Boolean)
                                .slice(0, maxItems)
                                .map((childUrl) => ({
                                    url: childUrl,
                                    userData: { mode: 'COMMENTS', isRoot: false, isChild: true },
                                }));
                            if (childUrls.length > 0) {
                                await addRequests(childUrls);
                                enqueuedChildCount = childUrls.length;
                                log.info(`🔗 Enqueued ${enqueuedChildCount} video(s) for comment extraction from: ${url}`);
                            }
                        } else {
                            await page.mouse.wheel(0, 900).catch(() => {});
                            await page.waitForTimeout(1400);
                            const commentsList = await extractTikTokComments(page, Math.max(maxCommentsPerVideo, 20), { captureState });
                            if (commentsList.length > 0) {
                                await pushCleanRecord({
                                    type: 'COMMENTS_FEED',
                                    url,
                                    sourceUrl: url,
                                    totalComments: commentsList.length,
                                    comments: commentsList,
                                    scrapedAt: new Date().toISOString(),
                                });
                                pushedCount += 1;
                                log.info(`✅ Extracted ${commentsList.length} comments from: ${url}`);
                            }
                        }
                        break;
                    }

                    case 'HASHTAGS': {
                        const hashtagRecord = await extractTikTokHashtag(page, url, maxItems, { captureState });
                        if (hashtagRecord) {
                            await pushCleanRecord(hashtagRecord);
                            pushedCount += 1;
                            log.info(`✅ Successfully scraped [HASHTAG] #${hashtagRecord.hashtagTitle} (${hashtagRecord.collectedVideosCount} videos)`);
                        }
                        break;
                    }

                    case 'MUSIC_SOUNDS': {
                        const musicRecord = await extractTikTokMusic(page, url, maxItems, { captureState });
                        if (musicRecord) {
                            await pushCleanRecord(musicRecord);
                            pushedCount += 1;
                            log.info(`✅ Successfully scraped [MUSIC_SOUND] "${musicRecord.musicTitle}"`);
                        }
                        break;
                    }

                    case 'KEYWORD_SEARCH': {
                        const { records, videoLinks } = await collectFeedVideos(page, captureState, maxItems);
                        if (records.length > 0) {
                            for (const rec of records.slice(0, maxItems)) {
                                await pushCleanRecord({ ...rec, ...(keyword ? { keyword } : {}) });
                                pushedCount += 1;
                            }
                            log.info(`✅ Extracted ${pushedCount} search result(s) for "${keyword || url}"`);
                        } else if (captureState.userInfos.length > 0) {
                            for (const ui of captureState.userInfos.slice(0, maxItems)) {
                                const prof = mapUserInfoToProfileRecord(ui, url, { extractEmailAndPhone });
                                if (prof) {
                                    await pushCleanRecord({ ...prof, ...(keyword ? { keyword } : {}) });
                                    pushedCount += 1;
                                }
                            }
                        } else if (videoLinks.length > 0) {
                            const childUrls = videoLinks
                                .map((v) => v.videoUrl)
                                .filter(Boolean)
                                .slice(0, maxItems)
                                .map((childUrl) => ({
                                    url: childUrl,
                                    userData: { mode: 'VIDEOS', isRoot: false, keyword },
                                }));
                            if (childUrls.length > 0) {
                                await addRequests(childUrls);
                                enqueuedChildCount = childUrls.length;
                                log.info(`🔗 Enqueued ${enqueuedChildCount} search video URLs from: ${url}`);
                            }
                        }
                        break;
                    }

                    case 'LIVE_METADATA': {
                        const liveRecord = await extractTikTokLive(page, url, { captureState });
                        if (liveRecord) {
                            await pushCleanRecord(liveRecord);
                            pushedCount += 1;
                            log.info(`✅ Successfully scraped [LIVE_METADATA] from: ${url}`);
                        }
                        break;
                    }

                    case 'TIKTOK_SHOP': {
                        const shopProducts = await page.evaluate((max) => {
                            const cards = Array.from(document.querySelectorAll('a[href*="/shop/pdp/"], [data-e2e*="product"], div[class*="ProductCard"]')).slice(0, max);
                            return cards
                                .map((el) => {
                                    const link = el.tagName === 'A' ? el.href : el.querySelector('a')?.href || '';
                                    const title = el.querySelector('[data-e2e*="title"], h3, h4, span')?.innerText?.trim() || el.innerText?.split('\n')[0]?.trim() || '';
                                    const coverUrl = el.querySelector('img')?.getAttribute('src') || '';
                                    if (!title && !link) return null;
                                    return { title, url: link, coverUrl };
                                })
                                .filter(Boolean);
                        }, maxItems);

                        for (const p of shopProducts) {
                            await pushCleanRecord({
                                type: 'TIKTOK_SHOP_PRODUCT',
                                url: p.url || url,
                                sourceUrl: url,
                                title: p.title,
                                coverUrl: p.coverUrl,
                                scrapedAt: new Date().toISOString(),
                            });
                            pushedCount += 1;
                        }
                        break;
                    }

                    default: {
                        const pageTitle = await page.title().catch(() => '');
                        if (pageTitle) {
                            await pushCleanRecord({
                                type: 'GENERIC_TIKTOK',
                                url,
                                title: pageTitle,
                                scrapedAt: new Date().toISOString(),
                            });
                            pushedCount += 1;
                        }
                    }
                }

                // If nothing was extracted AND nothing child-enqueued, surface WAF/CAPTCHA or empty-render error for retry
                if (pushedCount === 0 && enqueuedChildCount === 0) {
                    const wafReason = await detectWafOrCaptchaOnPage(page);
                    if (wafReason) {
                        throw new Error(wafReason);
                    }
                    throw new Error(`No extractable TikTok [${activeMode}] content found on ${url}`);
                }
            },

            async failedRequestHandler({ request }, error) {
                const msg = error?.message || 'Unknown Playwright error';
                log.error(`❌ Request ${request.url} failed permanently: ${msg}`);
                failedRequests.push({ url: request.url, error: msg });
            },
        });

        await crawler.run(browserQueueRequests);
    }

    // Store compact execution summary in Key-Value store
    const summary = sanitizeRecord({
        status: scrapedRecords.length > 0 ? (failedRequests.length > 0 ? 'PARTIAL_SUCCESS' : 'COMPLETED') : 'FAILED',
        totalRecordsScraped: scrapedRecords.length,
        failedRequestsCount: failedRequests.length,
        failedRequests,
        executionMode: scrapeMode,
        recordsSummary: scrapedRecords.slice(0, 100).map((r) => ({
            type: r.type,
            url: r.url || r.sourceUrl,
            username: r.username || r.authorUsername,
            nickname: r.nickname || r.authorNickname,
            followers: r.followersCount,
            views: r.playCount,
            isPhotoSlide: Boolean(r.isPhotoSlide),
            email: r.email,
            phone: r.phone,
        })),
        finishedAt: new Date().toISOString(),
    });

    await Actor.setValue('OUTPUT', summary);

    if (scrapedRecords.length === 0 && failedRequests.length > 0) {
        failureExitMessage = `TikTok scraper extracted 0 records; all ${failedRequests.length} request(s) failed (${failedRequests[0].error}). Try residential proxies or valid session cookies if TikTok challenged the requests.`;
    } else if (scrapedRecords.length === 0) {
        failureExitMessage = 'TikTok scraper completed with 0 extracted records.';
    } else {
        log.info(`🎉 Scraped ${scrapedRecords.length} TikTok record(s) (${failedRequests.length} failed). Data saved to Dataset & OUTPUT.`);
    }
} catch (error) {
    log.error(`Actor failed: ${error.message}`, { stack: error.stack });
    failureExitMessage = error.message || 'Unhandled TikTok scraper failure';
}

if (failureExitMessage) {
    await Actor.fail(failureExitMessage);
} else {
    await Actor.exit();
}
