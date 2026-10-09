/**
 * Apify Actor: TikTok Ultimate All-in-One Scraper (Enterprise Edition)
 * Technology: JavaScript (ES Modules), Crawlee, Playwright
 * Supports Video scraping, Photo Slideshows, Profiles with Leads, Comments, and Sounds.
 */

import { Actor } from 'apify';
import { PlaywrightCrawler, log } from 'crawlee';
import {
    normalizeTikTokUrl,
    detectTikTokUrlType,
    dismissTikTokModals,
    extractTikTokProfile,
    extractTikTokVideoOrPhoto,
    extractTikTokComments,
    extractTikTokHashtag
} from './extractors.js';

await Actor.init();

try {
    const input = (await Actor.getInput()) || {};
    const {
        scrapeMode = 'AUTO_DETECT',
        targetUrls = [{ url: 'https://www.tiktok.com/@tiktok' }],
        searchKeywords = [],
        maxItems = 20,
        maxCommentsPerVideo = 15,
        extractEmailAndPhone = true,
        proxyConfiguration: proxyInput,
        customCookies = ''
    } = input;

    log.info(`🚀 Starting TikTok Ultimate Scraper | Mode: ${scrapeMode} | Targets: ${targetUrls.length}`);

    // Build target URLs
    const targets = [];
    for (const item of targetUrls) {
        const rawUrl = typeof item === 'string' ? item : item.url;
        if (rawUrl) targets.push(normalizeTikTokUrl(rawUrl));
    }
    for (const kw of searchKeywords) {
        if (kw && typeof kw === 'string') {
            const clean = kw.trim().replace(/^#/, '');
            targets.push(`https://www.tiktok.com/tag/${encodeURIComponent(clean)}`);
        }
    }

    if (targets.length === 0) {
        targets.push('https://www.tiktok.com/@tiktok');
    }

    // Setup Apify Residential Proxy
    let proxyConfiguration;
    if (proxyInput) {
        proxyConfiguration = await Actor.createProxyConfiguration(proxyInput);
    } else {
        proxyConfiguration = await Actor.createProxyConfiguration({
            groups: ['RESIDENTIAL']
        }).catch(() => undefined);
    }

    const scrapedRecords = [];

    const crawler = new PlaywrightCrawler({
        proxyConfiguration,
        maxRequestRetries: 2,
        requestHandlerTimeoutSecs: 85,
        navigationTimeoutSecs: 50,
        headless: true,

        launchContext: {
            launchOptions: {
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-blink-features=AutomationControlled',
                    '--disable-infobars',
                    '--window-size=1280,850'
                ]
            }
        },

        preNavigationHooks: [
            async ({ page, context }) => {
                await page.setExtraHTTPHeaders({
                    'accept-language': 'en-US,en;q=0.9',
                    'sec-ch-ua': '"Google Chrome";v="124", "Chromium";v="124", "Not-A.Brand";v="99"',
                    'sec-ch-ua-mobile': '?0',
                    'sec-ch-ua-platform': '"Windows"'
                });

                // Apply custom session cookies
                if (customCookies && typeof customCookies === 'string') {
                    try {
                        let parsedCookies = [];
                        if (customCookies.trim().startsWith('[')) {
                            parsedCookies = JSON.parse(customCookies);
                        } else {
                            parsedCookies = customCookies.split(';').map((pair) => {
                                const [name, ...val] = pair.trim().split('=');
                                return {
                                    name: name.trim(),
                                    value: val.join('=').trim(),
                                    domain: '.tiktok.com',
                                    path: '/'
                                };
                            }).filter(c => c.name && c.value);
                        }
                        if (parsedCookies.length > 0) {
                            await context.addCookies(parsedCookies);
                            log.info(`🔑 Applied ${parsedCookies.length} TikTok session cookies.`);
                        }
                    } catch (cookieErr) {
                        log.warning(`Failed to parse custom cookies: ${cookieErr.message}`);
                    }
                }

                // Block streaming video playback to save bandwidth & compute
                await page.route('**/*.{mp4,webm,avi,woff,woff2}', (route) => route.abort());
            }
        ],

        async requestHandler({ page, request }) {
            const url = request.url;
            const activeMode = scrapeMode === 'AUTO_DETECT' ? detectTikTokUrlType(url) : scrapeMode;
            log.info(`🔎 Scraping TikTok [${activeMode}]: ${url}`);

            await page.waitForLoadState('domcontentloaded');
            await page.waitForTimeout(2500);

            // Dismiss login & app promotion modals
            await dismissTikTokModals(page);

            let record = null;

            switch (activeMode) {
                case 'PROFILES': {
                    record = await extractTikTokProfile(page, url);
                    break;
                }
                case 'VIDEOS':
                case 'PHOTO_SLIDES': {
                    const videoOrPhoto = await extractTikTokVideoOrPhoto(page, url);
                    let comments = [];
                    if (maxCommentsPerVideo > 0) {
                        // Scroll down to load comments
                        await page.mouse.wheel(0, 700);
                        await page.waitForTimeout(1000);
                        comments = await extractTikTokComments(page, maxCommentsPerVideo);
                    }
                    record = {
                        ...videoOrPhoto,
                        commentsCount: comments.length,
                        comments
                    };
                    break;
                }
                case 'COMMENTS': {
                    await page.mouse.wheel(0, 800);
                    await page.waitForTimeout(1200);
                    const commentsList = await extractTikTokComments(page, maxCommentsPerVideo);
                    record = {
                        type: 'COMMENTS_FEED',
                        sourceUrl: url,
                        totalComments: commentsList.length,
                        comments: commentsList,
                        scrapedAt: new Date().toISOString()
                    };
                    break;
                }
                case 'HASHTAGS': {
                    record = await extractTikTokHashtag(page, url, maxItems);
                    break;
                }
                default: {
                    record = {
                        type: 'GENERIC_TIKTOK',
                        url,
                        title: await page.title(),
                        scrapedAt: new Date().toISOString()
                    };
                }
            }

            if (record) {
                log.info(`✅ Successfully scraped [${record.type}] from: ${url}`);
                await Actor.pushData(record);
                scrapedRecords.push(record);
            }
        },

        async failedRequestHandler({ request, error }) {
            log.error(`❌ Request ${request.url} failed: ${error.message}`);
        }
    });

    await crawler.run(targets);

    // Save summary in Key-Value store
    const summary = {
        totalRecordsScraped: scrapedRecords.length,
        executionMode: scrapeMode,
        recordsSummary: scrapedRecords.map((r) => ({
            type: r.type,
            url: r.url || r.sourceUrl,
            username: r.username || r.authorUsername,
            nickname: r.nickname || r.authorNickname,
            followers: r.followersCount,
            views: r.playCount,
            isPhotoSlide: r.isPhotoSlide || false,
            email: r.email,
            phone: r.phone
        })),
        finishedAt: new Date().toISOString()
    };

    await Actor.setValue('OUTPUT', summary);
    log.info(`🎉 Scraped ${scrapedRecords.length} TikTok record(s). Data pushed to Dataset & OUTPUT Key-Value store.`);

} catch (error) {
    log.error(`Actor failed: ${error.message}`, { stack: error.stack });
    throw error;
} finally {
    await Actor.exit();
}
